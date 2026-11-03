/**
 * A2A 1.0 wire format: encoding, decoding, SSE framing, and the task store.
 *
 * This module is the only place that knows the on-the-wire spelling of an A2A
 * message. Everything above it (server, deliverer, skills) speaks plain JS
 * values; everything a caller sees comes out of here. Keeping the vocabulary in
 * one file is what makes "we speak 1.0, not 0.3" a single, testable decision
 * instead of a convention scattered across handlers.
 *
 * Boundaries:
 * - No DSH concept may appear here. No session, no plugin ctx, no delivery.
 *   A reviewer should be able to hand this file to any A2A peer author.
 * - Time is epoch milliseconds inside (`TaskStore`), ISO-8601 only at the edges
 *   where the wire demands it. Conversions live in `toWireTask()` /
 *   `statusUpdate()` so no caller has to remember the rule.
 * - `TaskStore` persistence is best-effort by contract: a failed disk write must
 *   never fail an in-flight A2A call, because the task already exists in memory
 *   and the remote peer has no way to undo its retry.
 *
 * @module dsh-a2a/wire
 */

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Protobuf enum names, as A2A 1.0 spells task states.
 *
 * Exposed as a frozen lookup so callers can compare against `TASK_STATES.DONE`
 * without hard-coding strings; the value is what goes on the wire.
 */
export const TASK_STATES = Object.freeze({
  UNSPECIFIED: 'TASK_STATE_UNSPECIFIED',
  SUBMITTED: 'TASK_STATE_SUBMITTED',
  WORKING: 'TASK_STATE_WORKING',
  INPUT_REQUIRED: 'TASK_STATE_INPUT_REQUIRED',
  AUTH_REQUIRED: 'TASK_STATE_AUTH_REQUIRED',
  COMPLETED: 'TASK_STATE_COMPLETED',
  CANCELED: 'TASK_STATE_CANCELED',
  FAILED: 'TASK_STATE_FAILED',
  REJECTED: 'TASK_STATE_REJECTED',
});

/** JSON-RPC and A2A error codes, so handler and tests agree on one table. */
export const RPC_ERRORS = Object.freeze({
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  UNAUTHENTICATED: -32001,
  FORBIDDEN: -32002,
  VERSION_UNSUPPORTED: -32003,
  REJECTED: -32004,
});

/** The one protocol version this module encodes and decodes. */
export const PROTOCOL_VERSION = '1.0';

/**
 * The version implied by an absent `A2A-Version` header.
 *
 * A caller that sends no version header is a 0.3 caller by convention, and 0.3
 * field names differ (camelCase methods, `state` strings). Accepting such a
 * request would silently drop fields, so the server rejects it instead; naming
 * the implied default here documents *why* "missing" is a rejection and not an
 * allowance.
 */
export const IMPLIED_LEGACY_VERSION = '0.3';

/** Internal state names (lower kebab-case) mapped to their wire enum name. */
const WIRE_BY_INTERNAL = Object.freeze({
  submitted: TASK_STATES.SUBMITTED,
  working: TASK_STATES.WORKING,
  'input-required': TASK_STATES.INPUT_REQUIRED,
  'auth-required': TASK_STATES.AUTH_REQUIRED,
  completed: TASK_STATES.COMPLETED,
  canceled: TASK_STATES.CANCELED,
  failed: TASK_STATES.FAILED,
  rejected: TASK_STATES.REJECTED,
  unknown: TASK_STATES.UNSPECIFIED,
});

/** Reverse table, derived so the two spellings can never drift apart. */
const INTERNAL_BY_WIRE = Object.freeze(
  Object.fromEntries(Object.entries(WIRE_BY_INTERNAL).map(([internal, wire]) => [wire, internal])),
);

/** States after which a task will not change again on its own. */
const TERMINAL_STATES = Object.freeze(new Set(['completed', 'canceled', 'failed', 'rejected']));

/** Default task lifetime; a peer that polls hours later gets a clean "gone". */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** Default cap on retained tasks; keeps an unbounded poller from eating memory. */
const DEFAULT_LIMIT = 500;

/**
 * Convert one internal state name to its wire enum name.
 *
 * Idempotent on wire input: a caller that passes `TASK_STATE_WORKING` gets it
 * back unchanged. That tolerance is deliberate — response builders assemble
 * values from several sources and re-normalising must not corrupt them.
 *
 * @param {string|undefined} internal - internal state, wire enum, or anything else.
 * @returns {string} a `TASK_STATE_*` name; unknown input becomes `_UNSPECIFIED`.
 */
export function toWireState(internal) {
  if (typeof internal !== 'string') return TASK_STATES.UNSPECIFIED;
  const direct = WIRE_BY_INTERNAL[internal];
  if (direct !== undefined) return direct;
  if (Object.hasOwn(INTERNAL_BY_WIRE, internal)) return internal;
  return TASK_STATES.UNSPECIFIED;
}

/**
 * Convert one wire enum name back to the internal state name.
 *
 * @param {string|undefined} wire - a `TASK_STATE_*` name.
 * @returns {string} internal state name, or `'unknown'` for anything unrecognised.
 */
export function fromWireState(wire) {
  if (typeof wire !== 'string') return 'unknown';
  return INTERNAL_BY_WIRE[wire] ?? 'unknown';
}

/**
 * Build a successful JSON-RPC response.
 *
 * @param {string|number|null} id - the request id, echoed verbatim.
 * @param {object} payload - exactly one of `task` / `message` / `statusUpdate` / `artifactUpdate`.
 * @returns {{jsonrpc: '2.0', id: string|number|null, result: object}} the envelope.
 */
export function rpcResult(id, payload) {
  return { jsonrpc: '2.0', id: id ?? null, result: payload ?? {} };
}

/**
 * Build a JSON-RPC error response.
 *
 * `data` stays optional at the top level but is always an object when present,
 * because A2A clients read `data.code` for stable sub-codes; a string there
 * would make them parse free text.
 *
 * @param {string|number|null} id - the request id, or null when unparseable.
 * @param {number} code - JSON-RPC / A2A error code.
 * @param {string} message - human sentence, never carrying a credential.
 * @param {object} [data] - structured detail, e.g. `{code: 'rate_limited'}`.
 * @returns {{jsonrpc: '2.0', id: string|number|null, error: object}} the envelope.
 */
export function rpcError(id, code, message, data) {
  const error = { code: typeof code === 'number' ? code : RPC_ERRORS.INTERNAL, message: String(message ?? '') };
  if (data !== undefined && data !== null) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

/**
 * Concatenate the text parts of a 1.0 message.
 *
 * Non-text parts (files, structured data) are skipped rather than stringified:
 * a skill that only wants prose should not receive `[object Object]` because a
 * caller attached a file. Parts are joined with a newline so multi-part text
 * keeps its paragraph structure.
 *
 * @param {object|undefined} message - `{parts: [{kind, text}]}` or anything else.
 * @returns {string} joined text, `''` when there is none.
 */
export function textOfMessage(message) {
  const parts = message?.parts;
  if (!Array.isArray(parts)) return '';
  const texts = [];
  for (const part of parts) {
    if (part === null || typeof part !== 'object') continue;
    if (part.kind !== 'text') continue;
    if (typeof part.text !== 'string' || part.text === '') continue;
    texts.push(part.text);
  }
  return texts.join('\n');
}

/**
 * Build a 1.0 message value.
 *
 * @param {object} input - message fields.
 * @param {'user'|'agent'} input.role - who authored it.
 * @param {string} input.text - text body.
 * @param {string} [input.messageId] - stable id; generated when omitted.
 * @param {string} [input.contextId] - conversation context.
 * @param {object} [input.metadata] - opaque caller metadata.
 * @returns {object} a `{role, messageId, parts, contextId?, metadata?}` value.
 */
export function makeMessage({ role = 'agent', text = '', messageId, contextId, metadata } = {}) {
  const message = {
    role,
    messageId: typeof messageId === 'string' && messageId !== '' ? messageId : randomUUID(),
    parts: [{ kind: 'text', text: String(text ?? '') }],
  };
  if (typeof contextId === 'string' && contextId !== '') message.contextId = contextId;
  if (metadata !== undefined && metadata !== null) message.metadata = metadata;
  return message;
}

/**
 * Build a 1.0 artifact with one text part.
 *
 * @param {object} input - artifact fields.
 * @param {string} [input.artifactId] - stable id; generated when omitted.
 * @param {string} [input.name] - short display name, e.g. `reply`.
 * @param {string} input.text - artifact body.
 * @param {object[]} [input.parts] - pre-built parts; wins over `text` when given.
 * @returns {{artifactId: string, name: string, parts: object[]}} the artifact.
 */
export function makeArtifact({ artifactId, name = 'reply', text = '', parts } = {}) {
  const resolvedParts = Array.isArray(parts) && parts.length > 0 ? parts : [{ kind: 'text', text: String(text ?? '') }];
  return {
    artifactId: typeof artifactId === 'string' && artifactId !== '' ? artifactId : `artifact-${randomUUID()}`,
    name: typeof name === 'string' && name !== '' ? name : 'reply',
    parts: resolvedParts,
  };
}

/**
 * Build one streaming `statusUpdate` payload.
 *
 * The `final: true` flag on the last frame is the only end-of-stream signal A2A
 * 1.0 defines; it is emitted from the same builder as the intermediate frames so
 * a handler cannot forget it.
 *
 * @param {object} input - frame fields.
 * @param {string} input.taskId - task this frame belongs to.
 * @param {string} [input.contextId] - conversation context.
 * @param {string|undefined} input.state - internal state name or wire enum.
 * @param {string} [input.note] - text surfaced as `status.message`.
 * @param {boolean} [input.final] - whether this frame ends the stream.
 * @param {number} [input.at] - epoch ms override, for deterministic tests.
 * @returns {object} `{taskId, contextId?, status:{state, timestamp, message?}, final}`.
 */
export function statusUpdate({ taskId, contextId, state, note, final = false, at } = {}) {
  const status = { state: toWireState(state), timestamp: isoAt(at) };
  if (typeof note === 'string' && note !== '') status.message = makeMessage({ role: 'agent', text: note });
  const frame = { taskId, status, final: final === true };
  if (typeof contextId === 'string' && contextId !== '') frame.contextId = contextId;
  return frame;
}

/**
 * Build one streaming `artifactUpdate` payload.
 *
 * @param {object} input - frame fields.
 * @param {string} input.taskId - task this frame belongs to.
 * @param {string} [input.contextId] - conversation context.
 * @param {object} input.artifact - artifact value from {@link makeArtifact}.
 * @param {boolean} [input.append] - append to the previous chunk instead of replacing.
 * @param {boolean} [input.lastChunk] - whether this is the artifact's final chunk.
 * @returns {object} `{taskId, contextId?, artifact, append, lastChunk}`.
 */
export function artifactUpdate({ taskId, contextId, artifact, append = false, lastChunk = true } = {}) {
  const frame = { taskId, artifact, append: append === true, lastChunk: lastChunk === true };
  if (typeof contextId === 'string' && contextId !== '') frame.contextId = contextId;
  return frame;
}

/**
 * Serialize one task for the wire.
 *
 * Epoch milliseconds become ISO strings here and only here: a peer parses
 * timestamps with `Date.parse`, and an epoch number would read as year 1970 in
 * every A2A client that follows the schema.
 *
 * @param {object} task - a task row from {@link TaskStore}.
 * @returns {object} `{id, contextId?, status, artifacts}`.
 */
export function toWireTask(task) {
  if (task === null || typeof task !== 'object') return undefined;
  const status = { state: toWireState(task.state), timestamp: isoAt(task.updatedAt) };
  if (typeof task.note === 'string' && task.note !== '') status.message = makeMessage({ role: 'agent', text: task.note });
  const wire = { id: task.id, status };
  if (typeof task.contextId === 'string' && task.contextId !== '') wire.contextId = task.contextId;
  wire.artifacts = Array.isArray(task.artifacts) ? task.artifacts : [];
  if (task.metadata !== undefined && task.metadata !== null) wire.metadata = task.metadata;
  return wire;
}

/**
 * Set the SSE response headers exactly once.
 *
 * `no-transform` keeps a reverse proxy from buffering the body, and
 * `X-Accel-Buffering: no` does the same for nginx specifically. Both matter:
 * buffering turns a live stream into one late blob and breaks every
 * `group/subscribe` caller. The flush is what makes the client see headers
 * before the first frame, so an error before the first frame can still be a
 * clean HTTP status instead of a truncated stream.
 *
 * @param {object} res - a `node:http` `ServerResponse`.
 * @returns {void}
 */
export function writeSseHead(res) {
  if (res === null || typeof res !== 'object') return;
  if (res.headersSent !== true && typeof res.setHeader === 'function') {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
  }
  if (typeof res.flushHeaders === 'function' && res.headersSent !== true) res.flushHeaders();
}

/**
 * Write one SSE `data:` frame.
 *
 * The payload is the whole JSON-RPC result object (`{result:{statusUpdate}}`),
 * matching what A2A 1.0 gateways emit; callers never pre-serialize.
 *
 * @param {object} res - a `node:http` `ServerResponse`.
 * @param {object} payload - JSON-serializable frame body.
 * @returns {boolean} `false` when the socket is gone, so a loop can stop early.
 */
export function writeSse(res, payload) {
  if (res === null || typeof res !== 'object') return false;
  if (res.writableEnded === true || res.destroyed === true) return false;
  try {
    return res.write(`data: ${JSON.stringify(payload)}\n\n`) !== false;
  } catch {
    return false;
  }
}

/**
 * Write one SSE comment line, used as a keep-alive heartbeat.
 *
 * A comment is the only SSE construct a client must ignore, which is exactly
 * what a heartbeat needs to be: it keeps NAT and proxies from closing an idle
 * subscription without inventing a frame the client would have to understand.
 *
 * @param {object} res - a `node:http` `ServerResponse`.
 * @param {string} text - comment body; newlines are folded to spaces.
 * @returns {boolean} `false` when the socket is gone.
 */
export function writeComment(res, text) {
  if (res === null || typeof res !== 'object') return false;
  if (res.writableEnded === true || res.destroyed === true) return false;
  const body = String(text ?? '').replace(/[\r\n]+/g, ' ');
  try {
    return res.write(`: ${body}\n\n`) !== false;
  } catch {
    return false;
  }
}

/**
 * Render one credential as a stable, non-reversible log token.
 *
 * `sha256:xxxxxxxx` is enough to correlate "the same key was rejected twice"
 * without ever putting the key in a log line, an error message, or a card.
 *
 * @param {unknown} value - credential or any value to mask.
 * @returns {string} `sha256:` plus 8 hex characters, or `''` for empty input.
 */
export function redact(value) {
  if (value === undefined || value === null || value === '') return '';
  const text = typeof value === 'string' ? value : safeStringify(value);
  if (text === '') return '';
  return `sha256:${createHash('sha256').update(text).digest('hex').slice(0, 8)}`;
}

/**
 * Replace every occurrence of the given secrets inside free text.
 *
 * Upstream errors are the usual leak: a library echoes the failing header back
 * in its message. Scrubbing before logging is cheaper than auditing every
 * library, so callers pass this over any text that came from outside.
 *
 * @param {string} text - text about to be logged.
 * @param {Array<string|undefined|null>} secrets - values that must never appear.
 * @returns {string} text with each non-empty secret replaced by its digest.
 */
export function redactAll(text, secrets) {
  let result = String(text ?? '');
  if (!Array.isArray(secrets)) return result;
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret === '') continue;
    result = result.split(secret).join(redact(secret));
  }
  return result;
}

/**
 * Compare a presented credential with the configured one in constant time.
 *
 * Both sides are hashed first so the comparison length is fixed: comparing raw
 * strings with `===` leaks the secret's length through timing, and
 * `timingSafeEqual` on unequal lengths throws instead of returning false.
 *
 * @param {string|undefined|null} presented - credential from the request.
 * @param {string|undefined|null} expected - configured credential.
 * @returns {boolean} true when they match and `expected` is non-empty.
 */
export function safeEqual(presented, expected) {
  if (typeof expected !== 'string' || expected === '') return false;
  if (typeof presented !== 'string' || presented === '') return false;
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * In-memory task store with optional JSON persistence and a TTL.
 *
 * The store is deliberately dumb: it holds rows, timestamps them, and notifies
 * subscribers. It never runs a skill and never touches the network, so a test
 * can drive it with an injected clock and no I/O at all.
 *
 * Task rows are internal (`state` in lower kebab-case, times in epoch ms). Use
 * {@link toWireTask} at the edge rather than exposing rows to a caller.
 */
export class TaskStore {
  /** @type {Map<string, object>} id → task row, insertion ordered. */
  #tasks = new Map();

  /** @type {Map<string, number>} id → monotonic creation counter, for stable ordering. */
  #seq = new Map();

  /** @type {Set<(task: object) => void>} change subscribers. */
  #listeners = new Set();

  #ttlMs;
  #limit;
  #persistPath;
  #clock;
  #counter = 0;
  #lastFlushError = null;

  /**
   * @param {object} [options] - store options.
   * @param {number} [options.ttlMs] - task lifetime in ms; default 24 h.
   * @param {string} [options.persistPath] - JSON file to load from and flush to.
   * @param {() => number} [options.clock] - epoch-ms source; default `Date.now`.
   * @param {number} [options.limit] - max retained tasks; oldest are evicted.
   */
  constructor({ ttlMs = DEFAULT_TTL_MS, persistPath, clock, limit = DEFAULT_LIMIT } = {}) {
    this.#ttlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS;
    this.#limit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT;
    this.#persistPath = typeof persistPath === 'string' && persistPath !== '' ? persistPath : undefined;
    this.#clock = typeof clock === 'function' ? clock : Date.now;
    this.#restore();
  }

  /** @returns {string|undefined} the file this store flushes to, when configured. */
  get persistPath() {
    return this.#persistPath;
  }

  /** @returns {Error|null} the last flush failure, for diagnostics only. */
  get lastFlushError() {
    return this.#lastFlushError;
  }

  /** @returns {number} number of rows currently held (expired rows included). */
  get size() {
    return this.#tasks.size;
  }

  /**
   * Create one task in the `submitted` state.
   *
   * @param {object} [input] - creation fields.
   * @param {string} [input.contextId] - conversation context; generated when omitted.
   * @param {object} [input.metadata] - opaque metadata echoed on the wire.
   * @returns {object} the new task row.
   */
  create({ contextId, metadata } = {}) {
    this.#sweep();
    const at = this.#now();
    const id = `task-${randomUUID()}`;
    this.#counter += 1;
    const task = {
      id,
      contextId: typeof contextId === 'string' && contextId !== '' ? contextId : randomUUID(),
      state: 'submitted',
      note: undefined,
      artifacts: [],
      createdAt: at,
      updatedAt: at,
    };
    if (metadata !== undefined && metadata !== null) task.metadata = metadata;
    this.#tasks.set(id, task);
    this.#seq.set(id, this.#counter);
    this.#evict();
    this.#emit(task);
    return task;
  }

  /**
   * Update a task's state and/or note.
   *
   * An omitted `state` is left alone rather than reset, so a caller can attach a
   * note without owning the state machine.
   *
   * @param {string} id - task id.
   * @param {object} [patch] - `{state?, note?}`.
   * @returns {object|undefined} the updated row, or `undefined` for an unknown id.
   */
  update(id, { state, note } = {}) {
    const task = this.#live(id);
    if (task === undefined) return undefined;
    if (typeof state === 'string' && state !== '') task.state = state;
    if (note !== undefined) task.note = typeof note === 'string' ? note : undefined;
    task.updatedAt = this.#now();
    this.#emit(task);
    return task;
  }

  /**
   * Attach one artifact to a task.
   *
   * @param {string} id - task id.
   * @param {object} artifact - artifact value; a missing `artifactId` is filled in.
   * @returns {object|undefined} the updated row, or `undefined` for an unknown id.
   */
  attachArtifact(id, artifact) {
    const task = this.#live(id);
    if (task === undefined) return undefined;
    if (artifact === null || typeof artifact !== 'object') return task;
    const normalized = typeof artifact.artifactId === 'string' && artifact.artifactId !== ''
      ? artifact
      : { ...artifact, artifactId: `artifact-${randomUUID()}` };
    task.artifacts.push(normalized);
    task.updatedAt = this.#now();
    this.#emit(task);
    return task;
  }

  /**
   * Read one task, dropping it first if its TTL has elapsed.
   *
   * @param {string} id - task id.
   * @returns {object|undefined} the row, or `undefined` when unknown or expired.
   */
  get(id) {
    return this.#live(id);
  }

  /**
   * Cancel a task.
   *
   * `changed` distinguishes "we cancelled it" from "it was already finished",
   * which is the difference an A2A caller uses to decide whether its side
   * effects still matter.
   *
   * @param {string} id - task id.
   * @returns {{task: object|undefined, changed: boolean}} the outcome.
   */
  cancel(id) {
    const task = this.#live(id);
    if (task === undefined) return { task: undefined, changed: false };
    if (TERMINAL_STATES.has(task.state)) return { task, changed: false };
    task.state = 'canceled';
    task.updatedAt = this.#now();
    this.#emit(task);
    return { task, changed: true };
  }

  /**
   * List tasks, newest first.
   *
   * @param {object} [options] - list options.
   * @param {number} [options.limit] - max rows; defaults to every retained row.
   * @returns {object[]} task rows ordered by creation, newest first.
   */
  list({ limit } = {}) {
    this.#sweep();
    const rows = [...this.#tasks.values()].sort((a, b) => (this.#seq.get(b.id) ?? 0) - (this.#seq.get(a.id) ?? 0));
    const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : rows.length;
    return rows.slice(0, cap);
  }

  /**
   * Subscribe to task changes.
   *
   * The listener sees the live row, not a copy. That is on purpose: a
   * `group/subscribe` style consumer wants the current object identity to track
   * later mutations, and every consumer in this plugin only reads.
   *
   * @param {(task: object) => void} fn - change callback.
   * @returns {() => void} disposer; calling it twice is harmless.
   */
  onChange(fn) {
    if (typeof fn !== 'function') return () => {};
    const listener = (task) => {
      try {
        fn(task);
      } catch {
        // A broken subscriber must not be able to fail a task transition.
      }
    };
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Persist every retained task to `persistPath`, best effort.
   *
   * Writes go through a temp file plus rename so a crash mid-write cannot leave
   * a half-parsed JSON file that the next start would refuse to load. Failures
   * are recorded rather than thrown: the caller has already answered the peer.
   *
   * @returns {boolean} true when the write landed (or there is nothing to write).
   */
  flush() {
    if (this.#persistPath === undefined) return true;
    try {
      const rows = [...this.#tasks.values()];
      const payload = JSON.stringify({ version: 1, savedAt: this.#now(), tasks: rows }, null, 2);
      const dir = dirname(this.#persistPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.#persistPath}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 });
      try {
        renameSync(tmp, this.#persistPath);
      } catch (error) {
        // Windows refuses a rename over an open file; fall back to a direct write.
        rmSync(tmp, { force: true });
        writeFileSync(this.#persistPath, payload, { encoding: 'utf8', mode: 0o600 });
        if (error instanceof Error && this.#lastFlushError === null) this.#lastFlushError = error;
      }
      return true;
    } catch (error) {
      this.#lastFlushError = error instanceof Error ? error : new Error(String(error));
      return false;
    }
  }

  /** Drop every task and every subscriber; used by tests and by plugin teardown. */
  clear() {
    this.#tasks.clear();
    this.#seq.clear();
    this.#listeners.clear();
  }

  /** Current epoch ms from the injected clock. */
  #now() {
    const value = this.#clock();
    return Number.isFinite(value) ? value : Date.now();
  }

  /**
   * Resolve a live row, expiring it first when its TTL has elapsed.
   * @param {string} id - task id.
   * @returns {object|undefined} the row.
   */
  #live(id) {
    if (typeof id !== 'string' || id === '') return undefined;
    const task = this.#tasks.get(id);
    if (task === undefined) return undefined;
    if (this.#now() - task.updatedAt > this.#ttlMs) {
      this.#tasks.delete(id);
      this.#seq.delete(id);
      return undefined;
    }
    return task;
  }

  /** Remove every row whose TTL has elapsed. */
  #sweep() {
    const at = this.#now();
    for (const [id, task] of this.#tasks) {
      if (at - task.updatedAt > this.#ttlMs) {
        this.#tasks.delete(id);
        this.#seq.delete(id);
      }
    }
  }

  /** Drop the oldest rows once the retained count exceeds the configured cap. */
  #evict() {
    while (this.#tasks.size > this.#limit) {
      let oldestId;
      let oldestSeq = Number.POSITIVE_INFINITY;
      for (const [id, seq] of this.#seq) {
        if (seq < oldestSeq) {
          oldestSeq = seq;
          oldestId = id;
        }
      }
      if (oldestId === undefined) break;
      this.#tasks.delete(oldestId);
      this.#seq.delete(oldestId);
    }
  }

  /** Notify every subscriber about one row. */
  #emit(task) {
    for (const listener of this.#listeners) listener(task);
  }

  /** Load rows from `persistPath` when the file exists and parses; never throws. */
  #restore() {
    if (this.#persistPath === undefined || !existsSync(this.#persistPath)) return;
    try {
      const raw = readFileSync(this.#persistPath, 'utf8');
      const parsed = JSON.parse(raw);
      const rows = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
      for (const row of rows) {
        if (row === null || typeof row !== 'object') continue;
        if (typeof row.id !== 'string' || row.id === '') continue;
        this.#counter += 1;
        this.#tasks.set(row.id, {
          id: row.id,
          contextId: typeof row.contextId === 'string' ? row.contextId : randomUUID(),
          state: typeof row.state === 'string' && row.state !== '' ? row.state : 'submitted',
          note: typeof row.note === 'string' ? row.note : undefined,
          artifacts: Array.isArray(row.artifacts) ? row.artifacts : [],
          createdAt: Number.isFinite(row.createdAt) ? row.createdAt : this.#now(),
          updatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : this.#now(),
          ...row.metadata === undefined ? {} : { metadata: row.metadata },
        });
        this.#seq.set(row.id, this.#counter);
      }
      this.#sweep();
    } catch {
      // A corrupt store must not stop the plugin from starting; start empty.
      this.#tasks.clear();
      this.#seq.clear();
    }
  }
}

/**
 * Format epoch ms as the ISO string the wire expects.
 * @param {number|undefined} at - epoch ms; defaults to now.
 * @returns {string} ISO-8601 timestamp.
 */
function isoAt(at) {
  const value = Number.isFinite(at) ? at : Date.now();
  return new Date(value).toISOString();
}

/**
 * `JSON.stringify` that never throws and never yields `undefined`.
 * @param {unknown} value - value to render.
 * @returns {string} JSON text, or `String(value)` for cyclic input.
 */
function safeStringify(value) {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}
