/**
 * The built-in skills: `ping` and `session/ask`.
 *
 * Both exist to answer one question through the whole stack — "did this message
 * actually reach a Session, and did the Session really work on it?" A `ping`
 * that only echoes proves the transport; `session/ask` proves the last mile,
 * because it has to wait for a real turn to end and read what the model said.
 *
 * The session skill deliberately does **not** stream. A DSH turn is not a
 * sequence of protocol-level progress events; pretending its intermediate steps
 * were A2A `statusUpdate`s would put a made-up progress narrative on the wire.
 * It reports `submitted` → `working` → a final artifact, which is the truth.
 *
 * @module dsh-a2a/skills/session
 */

/** How long one ask waits for its turn to finish, when the caller names nothing. */
const DEFAULT_ASK_TIMEOUT_MS = 600000;

/**
 * `ping` — a transport check.
 *
 * Returns the bound Session id and the plugin version so a caller can tell
 * "the gateway reached a DSH instance" from "the gateway reached *the right*
 * DSH instance", which is the failure mode that costs an hour when several
 * machines are behind one gateway.
 *
 * @param {object} deps - `{ version, sessionIdOf }`.
 * @returns {object} the skill definition.
 */
export function createPingSkill({ version, sessionIdOf }) {
  return {
    id: 'ping',
    name: 'Ping',
    description: 'Report the DSH instance behind this agent: its bound Session id and plugin version. Use it to verify connectivity before a real call.',
    examples: ['ping'],
    async run() {
      return {
        text: JSON.stringify({ pong: true, version, sessionId: sessionIdOf() ?? null }, null, 2),
      };
    },
  };
}

/**
 * `session/ask` — put a task into the bound Session and wait for the answer.
 *
 * This is the skill that makes a DSH instance an A2A agent: the caller's
 * message becomes a real turn (the left-hand "task message received" card, not a
 * bubble that looks like the user typed it), and the Session's last assistant
 * message becomes the artifact.
 *
 * @param {object} deps - `{ deliverer, sessions, logger, config }`.
 * @returns {object} the skill definition.
 */
export function createSessionAskSkill({ deliverer, sessions, logger, config }) {
  return {
    id: 'session/ask',
    name: 'Ask this Session',
    description:
      'Deliver a message into this DSH instance\'s bound Session as a task message, wait for the turn to finish, and return what the Session answered.',
    examples: ['Refactor the invoice module and report what changed', 'Summarise today\'s incident and list the open questions'],
    async run(input, context) {
      const text = typeof input.text === 'string' ? input.text.trim() : '';
      if (text === '') {
        // A caller that sends no words has nothing to deliver; answering with an
        // error is better than waking a Session to ask it what it was told.
        const error = new Error('session/ask needs a non-empty message text');
        error.code = 'empty_message';
        throw error;
      }
      const sessionId = input.sessionId ?? sessions.resolveBoundSessionId();
      if (typeof sessionId !== 'string' || sessionId === '') {
        const error = new Error(
          'session/ask has no target Session: set server.bindSessionId, or call from a Session once so it can bind itself',
        );
        error.code = 'no_bound_session';
        throw error;
      }
      const timeoutMs = clampTimeout(input.timeoutMs, config.server.taskTimeoutMs);
      const messageId = input.messageId ?? context.messageId;

      // The turn is observed from the Session's own event stream rather than
      // polled: an answer can arrive in 200ms or in ten minutes, and a poll
      // interval is either wasteful or slow at exactly the wrong moment.
      const watcher = sessions.watchTurn(sessionId, { timeoutMs, signal: context.signal });
      const receipt = await deliverer.deliver({
        sessionId,
        text,
        messageId,
        mode: 'queue',
        source: { kind: 'a2a', skill: 'session/ask', taskId: context.taskId, from: input.from },
      });
      const outcome = await watcher.done;
      if (outcome.timedOut) {
        const error = new Error(`session/ask timed out after ${timeoutMs}ms waiting for the Session to finish`);
        error.code = 'turn_timeout';
        throw error;
      }
      if (receipt.injected === 'duplicate') {
        logger?.info?.(`a2a: session/ask message ${messageId} was already delivered; answered from the Session's state`);
      }
      return {
        text: outcome.text === '' ? '(the Session finished its turn without a text answer)' : outcome.text,
        meta: { sessionId, injected: receipt.injected, timedOut: false },
      };
    },
  };
}

/** Keep a caller-supplied timeout inside what this server is willing to hold. */
function clampTimeout(value, ceiling) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0) return Math.min(DEFAULT_ASK_TIMEOUT_MS, ceiling);
  return Math.max(1000, Math.min(Math.trunc(number), ceiling));
}
