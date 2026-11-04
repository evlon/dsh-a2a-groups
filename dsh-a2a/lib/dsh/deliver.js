/**
 * Turn "some text from outside" into a real turn inside a target Session.
 *
 * This is the one place where the A2A server is allowed to touch DSH. Its job is
 * to reproduce the exact delivery vocabulary the harness already uses for
 * non-human input, so a message that arrives over A2A looks to the receiving
 * Session like every other plugin-sourced message: a left-hand "task message
 * received" card, not a right-aligned bubble the person supposedly typed.
 *
 * Two paths exist because two Host generations exist:
 * 1. `ctx.sessionController.resolveAgent(sessionId)` → `agent.followup|steer|inject`
 *    with `source.kind = 'agent-message'`. Preferred: it is the only way to get
 *    the non-human presentation and to seat the message in the live Agent.
 * 2. `ctx.sessionController.prompt({requestId, sessionId, mode, content})`.
 *    The legacy path, which records an ordinary `user` message. Used when the
 *    Host has no live Agent, when the operator asked for `bubble`, or when the
 *    resolved Agent exposes no delivery method.
 *
 * Boundaries and non-goals:
 * - It never wraps, prefixes, or rewrites the text. Formatting an envelope is
 *   the caller's business (this module has no opinion about A2A semantics).
 * - It never creates a Session. A delivery to an unknown Session fails; creating
 *   Sessions implicitly would let one misconfigured peer spawn unbounded agents.
 * - The dedupe ledger is process-local and bounded. It exists to survive a
 *   transport retry, not to be a durable inbox; durability belongs to the Session
 *   log, which `#alreadyAdmitted()` also consults.
 *
 * @module dsh-a2a/deliver
 */

import { createHash } from 'node:crypto';

/** The source kind DSH assigns to plugin-originated, non-user input. */
const NOTICE_SOURCE_KIND = 'agent-message';

/** Default window a delivered message counts as a duplicate. */
const DEFAULT_DEDUPE_WINDOW_MS = 10 * 60 * 1000;

/** Ceiling on ledger entries; a long-lived gateway must not grow without bound. */
const LEDGER_LIMIT = 2000;

/** Poll interval for `waitIdle`. */
const IDLE_POLL_MS = 50;

/** A credential-looking field, scrubbed from any text before it is logged. */
const SECRET_FIELDS = Object.freeze(['token', 'password', 'personKey', 'apiKey', 'secret', 'key']);

/**
 * Build the deliverer.
 *
 * @param {object} options - deliverer options.
 * @param {object} options.ctx - Host context; `sessionController` is the only part used.
 * @param {object} [options.logger] - logger with `info` / `warn` / `debug`.
 * @param {object} [options.config] - normalized config; `delivery.*` is read here.
 * @param {() => number} [options.clock] - epoch-ms source, for deterministic tests.
 * @returns {{deliver: (input: object) => Promise<object>, isBusy: (sessionId: string) => boolean, waitIdle: (sessionId: string, ms?: number) => Promise<boolean>, debugState: () => object}} the deliverer.
 */
export function createDeliverer({ ctx, logger, config, clock } = {}) {
  const delivery = config?.delivery ?? {};
  const dedupeWindowMs = Number.isFinite(delivery.dedupeWindowMs) && delivery.dedupeWindowMs > 0
    ? delivery.dedupeWindowMs
    : DEFAULT_DEDUPE_WINDOW_MS;
  const defaultMode = delivery.defaultMode === 'steer' || delivery.defaultMode === 'inbox' ? delivery.defaultMode : 'queue';
  const presentation = delivery.presentation === 'bubble' ? 'bubble' : 'notice';
  const now = typeof clock === 'function' ? clock : Date.now;

  /** @type {Map<string, number>} `${sessionId}\u0000${messageId}` → delivery epoch ms. */
  const ledger = new Map();

  /** @type {Set<string>} keys currently being delivered; guards concurrent retries. */
  const inflight = new Set();

  /** @type {Map<string, object>} sessionId → last resolved agent, for `isBusy`. */
  const agents = new Map();

  // Both services are read through `ctx.get`, never as a bare property.
  //
  // Cordis enforces `inject` for direct property access: `ctx.sessionStore` throws
  // "cannot get property without inject" unless the plugin declared it, and a
  // deliverer must not force every Host to provide a Session store just to mount.
  // `get` asks "is this service available right now" and answers undefined when it
  // is not, which is exactly the contract this module wants — it degrades to the
  // prompt path instead of failing the mount.
  //
  // Found by mounting in a real DSH instance: every unit test injects a fake `ctx`
  // object, and a plain object has no such rule, so the proxy's guard was invisible
  // until a real Host ran it.
  const controller = readService(ctx, 'sessionController');
  const sessionStore = readService(ctx, 'sessionStore');

  /**
   * Find the live Agent for a Session, tolerating every shape a Host may return.
   *
   * The Host contract is `resolveAgent(sessionId) → {agent} | null`, but a
   * rejected promise or an `{error}` wrapper is also possible; each is folded
   * into "no live agent" so the caller falls through to the prompt path instead
   * of crashing a delivery.
   *
   * @param {string} sessionId - target Session.
   * @returns {Promise<object|null>} the live agent, or null.
   */
  async function resolveAgent(sessionId) {
    if (controller === null || typeof controller !== 'object') return null;
    if (typeof controller.resolveAgent !== 'function') return null;
    let resolved;
    try {
      resolved = await controller.resolveAgent(sessionId);
    } catch (error) {
      warn(`resolveAgent failed for session ${trim(sessionId)}`, error);
      return null;
    }
    if (resolved === null || typeof resolved !== 'object') return null;
    if (resolved.error !== undefined) {
      warn(`resolveAgent reported an error for session ${trim(sessionId)}`, resolved.error);
      return null;
    }
    const agent = resolved.agent;
    if (agent === null || typeof agent !== 'object') return null;
    agents.set(sessionId, agent);
    return agent;
  }

  /**
   * Whether this exact message already reached the target.
   *
   * Three sources are consulted, cheapest first: our own ledger (survives a
   * transport retry inside one process), the Agent's inbox (a message queued for
   * a turn that has not started), and the Session log (a message whose turn
   * already ran). Checking only one of them would let a retry duplicate at the
   * boundary between "queued" and "logged".
   *
   * @param {object|null} agent - live agent, when one was resolved.
   * @param {string} sessionId - target Session.
   * @param {string} messageId - A2A message id.
   * @returns {boolean} true when the message already landed.
   */
  function alreadyAdmitted(agent, sessionId, messageId) {
    const key = ledgerKey(sessionId, messageId);
    const stamped = ledger.get(key);
    if (stamped !== undefined) {
      if (now() - stamped <= dedupeWindowMs) return true;
      ledger.delete(key);
    }
    if (agent === null) return false;
    if (inboxMatches(agent.inbox, messageId)) return true;
    if (logMatches(agent.session, messageId)) return true;
    return false;
  }

  /**
   * Record one successful delivery and keep the ledger bounded.
   * @param {string} sessionId - target Session.
   * @param {string} messageId - A2A message id.
   * @returns {void}
   */
  function remember(sessionId, messageId) {
    ledger.delete(ledgerKey(sessionId, messageId));
    ledger.set(ledgerKey(sessionId, messageId), now());
    while (ledger.size > LEDGER_LIMIT) {
      const oldest = ledger.keys().next();
      if (oldest.done === true) break;
      ledger.delete(oldest.value);
    }
  }

  /**
   * Deliver one message into a Session.
   *
   * The order of operations is the whole safety story:
   *   1. reserve the id (a concurrent retry sees a duplicate immediately),
   *   2. check every duplicate source,
   *   3. perform exactly one admit call,
   *   4. commit the ledger entry only after the admit call returned.
   * A throw at step 3 releases the reservation and commits nothing, so a retry
   * is attempted again rather than being swallowed as a duplicate — the failure
   * leaves no trace the next call could mistake for success.
   *
   * @param {object} input - delivery request.
   * @param {string} input.sessionId - target Session id.
   * @param {string} input.text - body to deliver, used verbatim.
   * @param {string} input.messageId - A2A message id; also the retry key.
   * @param {'queue'|'steer'|'inbox'} [input.mode] - delivery mode.
   * @param {object} [input.source] - extra source fields recorded on the message.
   * @param {AbortSignal} [input.signal] - cancellation.
   * @returns {Promise<{injected: 'followup'|'steer'|'inbox'|'duplicate', interrupted: boolean}>} how the target took it.
   * @throws {Error} when the Session is unknown or the Host refuses the delivery.
   */
  async function deliver(input) {
    const sessionId = typeof input?.sessionId === 'string' ? input.sessionId.trim() : '';
    if (sessionId === '') throw new Error('deliver: sessionId is required');
    if (typeof input?.text !== 'string' || input.text === '') throw new Error('deliver: text is required');
    const messageId = typeof input?.messageId === 'string' && input.messageId !== ''
      ? input.messageId
      : `a2a-${createHash('sha256').update(`${sessionId}\u0000${input.text}`).digest('hex').slice(0, 24)}`;
    const mode = normalizeMode(input?.mode, defaultMode);
    const signal = input?.signal;
    signal?.throwIfAborted?.();

    const key = ledgerKey(sessionId, messageId);
    if (inflight.has(key)) return { injected: 'duplicate', interrupted: false };
    inflight.add(key);
    try {
      const agent = await resolveAgent(sessionId);
      signal?.throwIfAborted?.();
      if (alreadyAdmitted(agent, sessionId, messageId)) {
        remember(sessionId, messageId);
        return { injected: 'duplicate', interrupted: false };
      }
      const useAgentPath = presentation === 'notice'
        && agent !== null
        && typeof agent.followup === 'function';
      const receipt = useAgentPath
        ? await admitAsNotice({ agent, sessionId, messageId, mode, text: input.text, source: input.source, signal })
        : await admitAsPrompt({ sessionId, messageId, mode, text: input.text, signal });
      remember(sessionId, messageId);
      return receipt;
    } finally {
      inflight.delete(key);
    }
  }

  /**
   * Deliver through the Agent API with a non-user source.
   *
   * `followup` queues a next-turn prompt and wakes the driver, `steer` submits
   * into the running step, and `inject` seats the message in the next-step queue
   * without waking anything. Mode is honoured literally here: unlike the
   * reference bus, A2A has no `interrupt` mode, so there is no state-dependent
   * translation to do and no risk of stranding a steered message on an idle
   * Session.
   *
   * @param {object} input - admit inputs.
   * @param {object} input.agent - live agent.
   * @param {string} input.sessionId - target Session.
   * @param {string} input.messageId - A2A message id.
   * @param {string} input.mode - normalized mode.
   * @param {string} input.text - body.
   * @param {object} [input.source] - caller source fields.
   * @param {AbortSignal} [input.signal] - cancellation.
   * @returns {Promise<{injected: string, interrupted: boolean}>} the receipt.
   */
  async function admitAsNotice({ agent, sessionId, messageId, mode, text, source, signal }) {
    const running = agentIsRunning(agent);
    if (mode === 'inbox') {
      const inject = typeof agent.inject === 'function' ? agent.inject : agent.followup;
      await inject.call(agent, createInboundMessage({ text, source: buildSource({ messageId, source }) }));
      await flush(sessionId, agent);
      return { injected: 'inbox', interrupted: false };
    }
    if (mode === 'steer' && typeof agent.steer === 'function') {
      signal?.throwIfAborted?.();
      await agent.steer(createInboundMessage({ text, source: buildSource({ messageId, source }) }));
      await flush(sessionId, agent);
      return { injected: 'steer', interrupted: running };
    }
    signal?.throwIfAborted?.();
    await agent.followup(createInboundMessage({ text, source: buildSource({ messageId, source }) }));
    await flush(sessionId, agent);
    return { injected: 'followup', interrupted: false };
  }

  /**
   * Deliver through the legacy prompt RPC, which records a `user` message.
   *
   * `requestId` carries the A2A message id so the controller's own retry
   * suppression recognises a repeated delivery even if our ledger was lost.
   * `inbox` has no prompt equivalent, so it degrades to `queue`: the message is
   * still delivered, just woken rather than silently seated.
   *
   * @param {object} input - admit inputs.
   * @param {string} input.sessionId - target Session.
   * @param {string} input.messageId - A2A message id.
   * @param {string} input.mode - normalized mode.
   * @param {string} input.text - body.
   * @param {AbortSignal} [input.signal] - cancellation.
   * @returns {Promise<{injected: string, interrupted: boolean}>} the receipt.
   */
  async function admitAsPrompt({ sessionId, messageId, mode, text, signal }) {
    if (controller === null || typeof controller !== 'object' || typeof controller.prompt !== 'function') {
      throw new Error('deliver: this Host exposes neither a live Agent nor sessionController.prompt()');
    }
    const promptMode = mode === 'steer' ? 'steer' : 'queue';
    await controller.prompt(
      {
        requestId: `a2a:${messageId}`,
        sessionId,
        mode: promptMode,
        content: [{ type: 'text', text }],
      },
      signal,
    );
    return { injected: promptMode, interrupted: promptMode === 'steer' };
  }

  /**
   * Persist the target Session's buffered events, including the admit splice.
   *
   * Durability is best effort and always after the admit call: the message is
   * already in the live Agent, so reporting a failure here would leave the peer
   * retrying something that already landed. Logged, never thrown.
   *
   * @param {string} sessionId - target Session.
   * @param {object} agent - live agent.
   * @returns {Promise<void>} resolves after the attempt.
   */
  async function flush(sessionId, agent) {
    if (sessionStore === undefined || sessionStore === null) return;
    if (typeof sessionStore.flush !== 'function') return;
    if (agent.session === undefined || agent.session === null) return;
    try {
      await sessionStore.flush(agent.session);
    } catch (error) {
      warn(`delivered to session ${trim(sessionId)} but the Session flush failed`, error);
    }
  }

  /**
   * Whether the target Session is executing a turn right now.
   *
   * Synchronous by contract, so it answers from the last resolved Agent. The
   * live Agent's `status` is authoritative when known; a Session never resolved
   * through this deliverer reports `false`, which is the safe answer for a caller
   * that only wants to decide whether to poll.
   *
   * @param {string} sessionId - target Session.
   * @returns {boolean} true when a turn is running.
   */
  function isBusy(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return false;
    const agent = agents.get(sessionId.trim());
    if (agent === undefined) return false;
    return agentIsRunning(agent);
  }

  /**
   * Wait until the target Session has no turn running, or the timeout expires.
   *
   * Polling is the honest implementation: the Agent API exposes `status` as a
   * property, not an event, and inventing a promise from it would mean holding a
   * listener on a Host that may never emit one. The interval is short enough to
   * feel immediate and long enough not to spin a core.
   *
   * @param {string} sessionId - target Session.
   * @param {number} [ms] - timeout in ms; default 120 s.
   * @returns {Promise<boolean>} true when the Session went idle, false on timeout.
   */
  async function waitIdle(sessionId, ms = 120000) {
    if (typeof sessionId !== 'string' || sessionId === '') return true;
    const deadline = now() + (Number.isFinite(ms) && ms > 0 ? ms : 120000);
    for (;;) {
      const agent = await resolveAgent(sessionId);
      if (agent === null) return true;
      if (!agentIsRunning(agent)) return true;
      if (now() >= deadline) return false;
      await delay(Math.min(IDLE_POLL_MS, Math.max(1, deadline - now())));
    }
  }

  /**
   * Expose the deliverer's own state for tests and diagnostics.
   *
   * Deliberately read-only: it hands out counts and copies, never the ledger
   * itself, so a test can assert "a failed delivery left nothing behind" without
   * being able to change the outcome it is measuring.
   *
   * @returns {{delivered: number, inflight: number, sessions: string[]}} a snapshot.
   */
  function debugState() {
    return { delivered: ledger.size, inflight: inflight.size, sessions: [...new Set([...agents.keys()])] };
  }

  /** Log a warning without leaking any credential that may sit in an error. */
  function warn(message, error) {
    if (logger === null || typeof logger !== 'object' || typeof logger.warn !== 'function') return;
    const detail = error === undefined ? '' : `: ${scrub(errorMessage(error))}`;
    logger.warn(`dsh-a2a: ${scrub(message)}${detail}`);
  }

  return { deliver, isBusy, waitIdle, debugState };
}

/**
 * Normalize a requested delivery mode.
 * @param {unknown} mode - caller value.
 * @param {string} fallback - configured default.
 * @returns {'queue'|'steer'|'inbox'} the mode to use.
 */
function normalizeMode(mode, fallback) {
  if (mode === 'steer' || mode === 'inbox' || mode === 'queue') return mode;
  if (fallback === 'steer' || fallback === 'inbox') return fallback;
  return 'queue';
}

/**
 * Build the message `source` the Client uses to pick a presentation.
 *
 * `kind: 'agent-message'` is what makes the Web UI render a non-human card.
 * `form: 'relay'` says another agent addressed this Session rather than the
 * operator. The A2A message id travels as both `busMessageId` (the field DSH's
 * own plugins use for retry recognition) and `a2aMessageId` (so a future reader
 * knows where it came from).
 *
 * @param {{messageId: string, source?: object}} input - identity inputs.
 * @returns {object} a frozen-looking plain source value.
 */
function buildSource({ messageId, source }) {
  const extra = source !== null && typeof source === 'object' && !Array.isArray(source) ? source : {};
  return {
    ...extra,
    kind: NOTICE_SOURCE_KIND,
    form: 'relay',
    busMessageId: messageId,
    a2aMessageId: messageId,
  };
}

/**
 * Build one identified user-role message in the shape the Agent API accepts.
 *
 * This mirrors DSH's own `createUserMessage()`: a fresh id, a text content part,
 * and a source. A profile plugin cannot import that helper (a bare
 * `@deepseek-ai/*` specifier does not resolve outside the installation), so the
 * value shape is reproduced against the documented API instead.
 *
 * @param {{text: string, source: object}} input - body and producer source.
 * @returns {object} the message value.
 */
function createInboundMessage({ text, source }) {
  return structuredClone({
    id: globalThis.crypto?.randomUUID?.() ?? `a2a-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source,
  });
}

/**
 * Whether an inbox queue already holds this message.
 * @param {object|undefined} inbox - `{nextTurn?, nextStep?}`.
 * @param {string} messageId - A2A message id.
 * @returns {boolean} true when found.
 */
function inboxMatches(inbox, messageId) {
  if (inbox === null || typeof inbox !== 'object') return false;
  for (const queue of [inbox.nextTurn, inbox.nextStep]) {
    if (!Array.isArray(queue)) continue;
    if (queue.some((message) => sourceMatches(message?.source, messageId))) return true;
  }
  return false;
}

/**
 * Whether the Session's durable event log already holds this message.
 * @param {object|undefined} session - Session with optional `snapshotEvents()`.
 * @param {string} messageId - A2A message id.
 * @returns {boolean} true when found.
 */
function logMatches(session, messageId) {
  if (session === null || typeof session !== 'object') return false;
  if (typeof session.snapshotEvents !== 'function') return false;
  let events;
  try {
    events = session.snapshotEvents();
  } catch {
    return false;
  }
  if (!Array.isArray(events)) return false;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'user/message') continue;
    if (sourceMatches(event.data?.source ?? event.data, messageId)) return true;
  }
  return false;
}

/**
 * Whether a message source identifies the given A2A message id.
 * @param {unknown} source - candidate source value.
 * @param {string} messageId - A2A message id.
 * @returns {boolean} true when it matches on either id field.
 */
function sourceMatches(source, messageId) {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return false;
  return source.busMessageId === messageId || source.a2aMessageId === messageId;
}

/**
 * Whether the target Agent is executing a turn right now.
 *
 * The Agent's own `status` is authoritative; the Session row is a snapshot that
 * can already be stale by the time a message arrives.
 * @param {object|undefined} agent - live agent.
 * @returns {boolean} true when a turn is running.
 */
function agentIsRunning(agent) {
  if (agent?.status === 'running') return true;
  if (agent?.status === 'idle' || agent?.status === 'cold') return false;
  return agent?.running === true;
}

/**
 * Compose the ledger key. The message id alone is not enough: two Sessions may
 * legitimately receive the same A2A message id from two different peers.
 * @param {string} sessionId - target Session.
 * @param {string} messageId - A2A message id.
 * @returns {string} the composite key.
 */
function ledgerKey(sessionId, messageId) {
  return `${sessionId}\u0000${messageId}`;
}

/** Shorten an id for a log line. */
function trim(value) {
  const text = String(value ?? '');
  return text.length <= 24 ? text : `${text.slice(0, 24)}…`;
}

/** Render an error as a message string without a stack. */
function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error ?? 'unknown error');
}

/**
 * Remove credential-looking values from a log line.
 *
 * The same scrubber as `wire.redactAll`, inlined so this module imports nothing
 * but `node:crypto`: a delivery failure must not be the thing that drags the
 * whole wire module (and its store) into a test that only wants to check ids.
 * @param {string} text - candidate log text.
 * @returns {string} text with `key=value` secrets masked.
 */
function scrub(text) {
  let result = String(text ?? '');
  for (const field of SECRET_FIELDS) {
    const pattern = new RegExp(`(${field}\\s*[:=]\\s*)([^\\s,;)"']+)`, 'gi');
    result = result.replace(pattern, (_match, prefix, secret) => `${prefix}sha256:${createHash('sha256').update(secret).digest('hex').slice(0, 8)}`);
  }
  return result;
}

/** Resolve after `ms` milliseconds. */
function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Do not keep the process alive just for an idle poll.
    timer.unref?.();
  });
}

/**
 * Read one Host service without tripping Cordis's `inject` guard.
 *
 * Two reads, in this order, for one reason: `ctx.get(name)` is the reflective
 * read and is always safe, but a plain test double has no `get` and simply holds
 * the service as a property. Reading the property directly is what Cordis
 * forbids for an *undeclared* service, so it is attempted only through a
 * try/catch — a real Host throws there and this falls back to "absent", which is
 * the same answer the deliverer wants.
 *
 * @param {object} ctx - plugin context.
 * @param {string} name - service key.
 * @returns {any} the service, or undefined.
 */
function readService(ctx, name) {
  if (ctx === null || typeof ctx !== 'object') return undefined;
  if (typeof ctx.get === 'function') {
    try {
      const viaGet = ctx.get(name);
      if (viaGet !== undefined && viaGet !== null) return viaGet;
    } catch {
      // Fall through to the property read.
    }
  }
  try {
    const direct = ctx[name];
    return direct === null ? undefined : direct;
  } catch {
    // Cordis's inject guard: the plugin did not declare this service, so it is
    // not available to it. Absent is the correct reading.
    return undefined;
  }
}
