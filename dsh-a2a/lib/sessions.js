/**
 * Session resolution and turn observation for the A2A server half.
 *
 * Two jobs, both about answering "which Session is this agent, and when has it
 * finished thinking":
 *
 *   1. **Binding.** An A2A agent is one DSH instance standing behind one
 *      Session. The first `session/ask` that arrives can bind it (a Session that
 *      asks its own instance to become an agent is the ordinary case), or the
 *      operator names one in config. Both are supported; an unbound agent
 *      refuses the call instead of silently picking a Session.
 *
 *   2. **Turn watching.** `session/ask` has to wait for the *turn* it caused,
 *      not merely for the delivery call to return — delivery only queues the
 *      message. The end of a turn is observable on the Host's Session event
 *      stream, so this module subscribes before delivering and resolves when the
 *      matching `turn/end` arrives.
 *
 * No `@deepseek-ai/*` import: everything Host-specific arrives through `ctx`.
 *
 * @module dsh-a2a/sessions
 */

/** Event names DSH uses for a Session's turn lifecycle, in either vocabulary. */
const TURN_END_EVENTS = new Set(['turn/end', 'turn-end', 'turnEnd']);

/** Event names that carry what the model said. */
const ASSISTANT_TEXT_EVENTS = new Set(['assistant/message', 'assistant-message', 'assistantMessage']);

/**
 * Build the session facade the server and skills share.
 *
 * @param {object} options - construction options.
 * @param {object} options.ctx - plugin context carrying `sessionController`, `sessions`.
 * @param {object} options.config - normalized config.
 * @param {object} [options.logger] - host logger.
 * @param {Function} [options.clock] - epoch-millisecond clock.
 * @returns {object} the facade.
 */
export function createSessions({ ctx, config, logger, clock = () => Date.now() }) {
  /** Set once something binds this agent to a Session. */
  let boundSessionId;
  /** Sessions already offered by a caller, most recent last. */
  const seen = new Set();

  const controller = () => {
    const service = ctx?.get?.('sessionController') ?? ctx?.sessionController;
    if (service === undefined) throw new Error('dsh-a2a: the sessionController service is unavailable in this Host');
    return service;
  };

  /**
   * The Session this agent stands for.
   *
   * Config wins when it names one; `'self'` means "the first Session that talks
   * to me". A configured id is resolved lazily rather than at mount time,
   * because a Host can mount a plugin before any Session exists.
   */
  const resolveBoundSessionId = () => {
    if (typeof boundSessionId === 'string' && boundSessionId !== '') return boundSessionId;
    const configured = config?.server?.bindSessionId ?? 'self';
    if (configured !== 'self') return configured;
    return undefined;
  };

  /**
   * Offer a Session the chance to bind this agent.
   *
   * Called from the tool surface, where the calling Session is known. It only
   * binds while unbound and while config says `self`, so an operator who pinned
   * a Session cannot have it silently replaced by whoever calls next.
   *
   * @param {string} sessionId - the calling Session.
   * @returns {boolean} true when this call bound it.
   */
  const offerBinding = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return false;
    seen.add(sessionId);
    if ((config?.server?.bindSessionId ?? 'self') !== 'self') return false;
    if (typeof boundSessionId === 'string' && boundSessionId !== '') return false;
    boundSessionId = sessionId;
    logger?.info?.(`a2a: bound this agent to Session "${sessionId}" (first caller)`);
    return true;
  };

  /**
   * Whether the underlying Agent is currently running a turn.
   *
   * Read from the live Agent rather than from the store, so a Session that just
   * went idle is not reported busy for another polling interval.
   */
  const isRunning = (sessionId) => {
    const agent = liveAgent(sessionId);
    if (agent === undefined) return false;
    if (typeof agent.running === 'boolean') return agent.running;
    const state = agent.state;
    return state === 'running' || state === 'busy';
  };

  const liveAgent = (sessionId) => {
    const agents = ctx?.get?.('agents') ?? ctx?.agents;
    if (agents !== undefined && typeof agents.get === 'function') {
      const agent = agents.get(sessionId);
      if (agent !== undefined && agent !== null) return agent;
    }
    const store = ctx?.get?.('sessions') ?? ctx?.sessions;
    if (store !== undefined && typeof store.get === 'function') {
      return store.get(sessionId);
    }
    return undefined;
  };

  /**
   * Watch one Session for the end of the next turn, collecting what it says.
   *
   * Subscribing happens before delivery on purpose: delivery can start and even
   * finish a very fast turn, and a listener attached afterwards would wait
   * forever for an event that already happened.
   *
   * The returned `done` promise never rejects on timeout — it resolves with
   * `{timedOut:true}`, because a timeout is an outcome the skill reports, not an
   * exception the transport has to translate.
   *
   * @param {string} sessionId - Session to watch.
   * @param {object} [options] - `{timeoutMs, signal}`.
   * @returns {{done: Promise<{text: string, events: number, timedOut: boolean}>, cancel: Function}} the watcher.
   */
  const watchTurn = (sessionId, options = {}) => {
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : config?.server?.taskTimeoutMs ?? 600000;
    /** Latest assistant text seen after the turn started. */
    let text = '';
    let events = 0;
    let settled = false;
    let unsubscribe;
    let timer;

    const finish = (timedOut) => {
      if (settled) return;
      settled = true;
      if (unsubscribe !== undefined) unsubscribe();
      if (timer !== undefined) clearTimeout(timer);
      resolveOutcome({ text, events, timedOut });
    };

    /** @type {(value: {text: string, events: number, timedOut: boolean}) => void} */
    let resolveOutcome = () => {};
    const done = new Promise((resolve) => {
      resolveOutcome = resolve;
    });

    const onEvent = (session, event) => {
      const id = typeof session === 'string' ? session : session?.id;
      if (id !== sessionId) return;
      events += 1;
      const type = event?.type ?? event?.kind;
      if (typeof type === 'string' && ASSISTANT_TEXT_EVENTS.has(type)) {
        const candidate = textOfEvent(event);
        if (candidate !== '') text = candidate;
        return;
      }
      if (typeof type === 'string' && TURN_END_EVENTS.has(type)) {
        const candidate = textOfEvent(event);
        if (candidate !== '') text = candidate;
        finish(false);
      }
    };

    unsubscribe = attachEventListener(ctx, onEvent);
    timer = setTimeout(() => finish(true), timeoutMs);
    if (typeof timer?.unref === 'function') timer.unref();
    if (options.signal !== undefined) {
      const abort = () => finish(true);
      if (options.signal.aborted) abort();
      else options.signal.addEventListener('abort', abort, { once: true });
    }

    return {
      done,
      cancel: () => finish(true),
    };
  };

  /**
   * Read the tail of a Session transcript.
   *
   * Used by `group/*` skills and the UI to answer "what did this Session say"
   * without the caller needing the Host's inspection API.
   *
   * @param {string} sessionId - Session to read.
   * @param {number} [limit] - how many messages to return, newest last.
   * @returns {Promise<Array<{role: string, text: string, at: number}>>} the tail.
   */
  const readTail = async (sessionId, limit = 12) => {
    try {
      const inspection = await controller().inspect?.(sessionId);
      const events = Array.isArray(inspection?.events) ? inspection.events : [];
      const messages = [];
      for (const event of events.slice(-2000)) {
        const type = event?.type ?? event?.kind;
        if (type !== 'user/message' && type !== 'assistant/message') continue;
        const text = textOfEvent(event);
        if (text === '') continue;
        messages.push({ role: type.startsWith('user') ? 'user' : 'assistant', text, at: event.at ?? 0 });
      }
      return messages.slice(-Math.max(1, limit));
    } catch (error) {
      logger?.warn?.(`a2a: could not read the tail of "${sessionId}": ${describe(error)}`);
      return [];
    }
  };

  return {
    resolveBoundSessionId,
    offerBinding,
    isRunning,
    watchTurn,
    readTail,
    /** For `ping` and the card: what this agent is currently bound to. */
    info: () => ({ boundSessionId: resolveBoundSessionId() ?? null, candidates: [...seen], now: clock() }),
  };
}

/**
 * Subscribe to Session events however this Host exposes them.
 *
 * DSH emits `session/event(session, event)`; older/other compositions expose a
 * per-session subscription. Both are attempted and the first that exists wins,
 * so one helper covers a range of Host versions instead of failing shut.
 *
 * @param {object} ctx - plugin context.
 * @param {Function} listener - `(session, event) => void`.
 * @returns {Function} disposer.
 */
function attachEventListener(ctx, listener) {
  if (typeof ctx?.on === 'function') {
    const dispose = ctx.on('session/event', listener);
    return typeof dispose === 'function' ? dispose : () => {};
  }
  const events = ctx?.events;
  if (events !== undefined && typeof events.on === 'function') {
    const dispose = events.on('session/event', listener);
    return typeof dispose === 'function' ? dispose : () => {};
  }
  return () => {};
}

/**
 * The text an event carries, in whatever shape the Host used.
 *
 * Kept deliberately tolerant: an event's payload moved between DSH releases
 * (`data`, `message`, `content`, blocks of `{type:'text'}`). Reading all of them
 * means one helper survives an upgrade, where pinning one shape would silently
 * return empty strings.
 */
function textOfEvent(event) {
  const candidates = [event?.text, event?.data?.text, event?.message?.text, event?.data?.message?.text];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
  }
  for (const block of contentBlocks(event)) {
    if (typeof block?.text === 'string' && block.text.trim() !== '') return block.text;
  }
  return '';
}

/** Every plausible content-block array in an event. */
function contentBlocks(event) {
  const candidates = [event?.content, event?.parts, event?.data?.content, event?.message?.content, event?.data?.message?.content];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

/** One line about an error, without a stack. */
function describe(error) {
  return error instanceof Error ? error.message : String(error);
}
