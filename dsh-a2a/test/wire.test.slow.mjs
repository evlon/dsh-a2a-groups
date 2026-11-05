/**
 * Behavioral tests for the A2A 1.0 wire layer.
 *
 * These assert what a peer would observe — enum spelling, SSE framing, task
 * lifetime, persistence — not which internal helper ran. The clock is injected
 * everywhere a timestamp matters so TTL behaviour is deterministic instead of
 * dependent on `setTimeout` luck.
 */

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  TASK_STATES,
  RPC_ERRORS,
  PROTOCOL_VERSION,
  TaskStore,
  artifactUpdate,
  fromWireState,
  makeArtifact,
  makeMessage,
  redact,
  redactAll,
  rpcError,
  rpcResult,
  safeEqual,
  statusUpdate,
  textOfMessage,
  toWireState,
  toWireTask,
  writeComment,
  writeSse,
  writeSseHead,
} from '../lib/core/wire.js';

/** A response double that records exactly what the SSE writers emitted. */
function fakeResponse() {
  const chunks = [];
  const headers = {};
  let ended = false;
  let headersSent = false;
  return {
    chunks,
    headers,
    get body() {
      return chunks.join('');
    },
    setHeader(name, value) {
      headers[name.toLowerCase()] = value;
    },
    flushHeaders() {
      headersSent = true;
    },
    write(chunk) {
      if (ended) return false;
      chunks.push(chunk);
      return true;
    },
    end() {
      ended = true;
    },
    get headersSent() {
      return headersSent;
    },
    get writableEnded() {
      return ended;
    },
    destroyed: false,
  };
}

test('wire: the protocol version is pinned to 1.0', () => {
  assert.equal(PROTOCOL_VERSION, '1.0');
  assert.equal(TASK_STATES.COMPLETED, 'TASK_STATE_COMPLETED');
});

test('wire: state names round-trip in both directions', () => {
  for (const internal of ['submitted', 'working', 'completed', 'canceled', 'failed', 'rejected', 'input-required', 'auth-required']) {
    const wire = toWireState(internal);
    assert.match(wire, /^TASK_STATE_[A-Z_]+$/);
    assert.equal(fromWireState(wire), internal, `${internal} must round-trip through ${wire}`);
  }
});

test('wire: unknown states degrade instead of throwing', () => {
  assert.equal(fromWireState('TASK_STATE_MADE_UP'), 'unknown');
  assert.equal(toWireState('made-up'), TASK_STATES.UNSPECIFIED);
  assert.equal(toWireState(undefined), TASK_STATES.UNSPECIFIED);
  assert.equal(fromWireState(undefined), 'unknown');
});

test('wire: toWireState is idempotent on an already-wire value', () => {
  assert.equal(toWireState('TASK_STATE_WORKING'), 'TASK_STATE_WORKING');
});

test('wire: rpcResult echoes the id and defaults a missing one to null', () => {
  assert.deepEqual(rpcResult('smoke-1', { task: { id: 't' } }), {
    jsonrpc: '2.0',
    id: 'smoke-1',
    result: { task: { id: 't' } },
  });
  assert.equal(rpcResult(undefined, {}).id, null);
  assert.equal(rpcResult(7, undefined).result instanceof Object, true);
});

test('wire: rpcError carries a stable sub-code and never invents a data string', () => {
  assert.deepEqual(rpcError('1', RPC_ERRORS.VERSION_UNSUPPORTED, 'nope'), {
    jsonrpc: '2.0',
    id: '1',
    error: { code: -32003, message: 'nope' },
  });
  const detailed = rpcError(null, RPC_ERRORS.REJECTED, 'over budget', { code: 'rate_limited' });
  assert.equal(detailed.error.data.code, 'rate_limited');
  assert.equal(detailed.id, null);
});

test('wire: textOfMessage joins text parts and ignores non-text ones', () => {
  const message = {
    role: 'user',
    messageId: 'm',
    parts: [
      { kind: 'text', text: 'hello' },
      { kind: 'file', file: { uri: 'x' } },
      { kind: 'text', text: 'world' },
      { kind: 'text' },
    ],
  };
  assert.equal(textOfMessage(message), 'hello\nworld');
  assert.equal(textOfMessage(undefined), '');
  assert.equal(textOfMessage({ parts: 'nope' }), '');
});

test('wire: makeMessage keeps a supplied id and generates one otherwise', () => {
  const kept = makeMessage({ role: 'user', text: 'x', messageId: 'msg-1', contextId: 'ctx' });
  assert.equal(kept.messageId, 'msg-1');
  assert.equal(kept.contextId, 'ctx');
  assert.deepEqual(kept.parts, [{ kind: 'text', text: 'x' }]);
  const generated = makeMessage({ role: 'agent', text: 'y' });
  assert.match(generated.messageId, /^[0-9a-f-]{36}$/);
  assert.equal(Object.hasOwn(generated, 'contextId'), false);
});

test('wire: makeArtifact produces a text part artifact with a stable id', () => {
  const artifact = makeArtifact({ artifactId: 'artifact-1', name: 'reply', text: 'ok' });
  assert.deepEqual(artifact, { artifactId: 'artifact-1', name: 'reply', parts: [{ kind: 'text', text: 'ok' }] });
  assert.match(makeArtifact({ text: 'z' }).artifactId, /^artifact-/);
});

test('wire: the statusUpdate frame matches the captured gateway shape', () => {
  const frame = statusUpdate({ taskId: 't1', contextId: 'c1', state: 'working', at: Date.parse('2026-01-02T03:04:05.000Z') });
  assert.deepEqual(frame, {
    taskId: 't1',
    contextId: 'c1',
    status: { state: 'TASK_STATE_WORKING', timestamp: '2026-01-02T03:04:05.000Z' },
    final: false,
  });
});

test('wire: statusUpdate attaches the note as a message and honours final', () => {
  const frame = statusUpdate({ taskId: 't1', state: 'completed', note: 'done', final: true });
  assert.equal(frame.final, true);
  assert.deepEqual(frame.status.message.parts, [{ kind: 'text', text: 'done' }]);
  assert.equal(frame.status.message.role, 'agent');
});

test('wire: artifactUpdate frames match the captured gateway shape', () => {
  const artifact = makeArtifact({ artifactId: 'artifact-1', text: 'hi' });
  const frame = artifactUpdate({ taskId: 't1', contextId: 'c1', artifact, append: false, lastChunk: true });
  assert.deepEqual(frame, {
    taskId: 't1',
    contextId: 'c1',
    artifact,
    append: false,
    lastChunk: true,
  });
});

test('wire: toWireTask converts epoch times to ISO and keeps artifacts', () => {
  const task = {
    id: 't1',
    contextId: 'c1',
    state: 'completed',
    note: undefined,
    artifacts: [makeArtifact({ artifactId: 'a1', text: 'hi' })],
    createdAt: 1000,
    updatedAt: 2000,
  };
  const wire = toWireTask(task);
  assert.equal(wire.id, 't1');
  assert.equal(wire.contextId, 'c1');
  assert.equal(wire.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(wire.status.timestamp, new Date(2000).toISOString());
  assert.equal(wire.artifacts.length, 1);
  assert.equal(Object.hasOwn(wire.status, 'message'), false);
  assert.equal(toWireTask(undefined), undefined);
});

test('wire: SSE head is written exactly once with anti-buffering headers', () => {
  const res = fakeResponse();
  writeSseHead(res);
  writeSseHead(res);
  assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.match(res.headers['cache-control'], /no-transform/);
  assert.equal(res.headers['x-accel-buffering'], 'no');
  assert.equal(res.chunks.length, 0, 'the head must not write a body');
});

test('wire: writeSse emits one data frame per call and reports a dead socket', () => {
  const res = fakeResponse();
  assert.equal(writeSse(res, { result: { statusUpdate: { taskId: 't' } } }), true);
  assert.equal(res.body, `data: {"result":{"statusUpdate":{"taskId":"t"}}}\n\n`);
  const dead = fakeResponse();
  dead.destroyed = true;
  assert.equal(writeSse(dead, { result: {} }), false);
  assert.equal(dead.chunks.length, 0, 'a destroyed socket must not be written to');
});

test('wire: writeComment folds newlines so a comment cannot become a data frame', () => {
  const res = fakeResponse();
  writeComment(res, 'a\nb\rc');
  assert.equal(res.body, ': a b c\n\n');
});

test('wire: a credential is redacted to a stable short digest, never echoed', () => {
  const secret = 'super-secret-token';
  const masked = redact(secret);
  assert.match(masked, /^sha256:[0-9a-f]{8}$/);
  assert.equal(masked.includes(secret), false);
  assert.equal(redact(secret), masked, 'the digest must be stable across calls');
  assert.equal(redact(''), '');
});

test('wire: redactAll scrubs every occurrence inside a log line', () => {
  const line = 'rejected token=abc123 for password=abc123 and key=zzz';
  const scrubbed = redactAll(line, ['abc123', 'zzz']);
  assert.equal(scrubbed.includes('abc123'), false);
  assert.equal(scrubbed.includes('zzz'), false);
  assert.match(scrubbed, /sha256:[0-9a-f]{8}/);
});

test('wire: safeEqual accepts the exact credential and rejects everything else', () => {
  assert.equal(safeEqual('token-a', 'token-a'), true);
  assert.equal(safeEqual('token-b', 'token-a'), false);
  assert.equal(safeEqual('token-a-much-longer', 'token-a'), false);
  assert.equal(safeEqual('', 'token-a'), false);
  assert.equal(safeEqual('token-a', ''), false);
});

test('TaskStore: create/update/get/list/cancel are coherent', () => {
  let now = 1_000_000;
  const store = new TaskStore({ clock: () => now });
  const first = store.create({ contextId: 'ctx-1', metadata: { skill: 'ping' } });
  assert.equal(first.state, 'submitted');
  assert.equal(first.contextId, 'ctx-1');
  assert.deepEqual(first.metadata, { skill: 'ping' });
  assert.equal(store.get(first.id), first);

  now += 10;
  const updated = store.update(first.id, { state: 'working', note: 'running' });
  assert.equal(updated.state, 'working');
  assert.equal(updated.note, 'running');
  assert.equal(updated.updatedAt, now);

  now += 10;
  const artifact = makeArtifact({ artifactId: 'artifact-1', text: 'reply' });
  store.attachArtifact(first.id, artifact);
  assert.deepEqual(store.get(first.id).artifacts, [artifact]);

  const second = store.create({ contextId: 'ctx-2' });
  const listed = store.list();
  assert.deepEqual(listed.map((task) => task.id), [second.id, first.id], 'newest first');
  assert.deepEqual(store.list({ limit: 1 }).map((task) => task.id), [second.id]);

  const cancelled = store.cancel(first.id);
  assert.equal(cancelled.changed, true);
  assert.equal(cancelled.task.state, 'canceled');
  assert.equal(store.cancel(first.id).changed, false, 'cancelling twice must not claim a second change');
  assert.equal(store.update('missing', { state: 'working' }), undefined);
  assert.equal(store.get('missing'), undefined);
  assert.equal(store.cancel('missing').task, undefined);
});

test('TaskStore: an expired task reads as gone and disappears from list', () => {
  let now = 0;
  const store = new TaskStore({ ttlMs: 1000, clock: () => now });
  const task = store.create({});
  now = 500;
  assert.equal(store.get(task.id), task, 'still inside the TTL');
  now = 2000;
  assert.equal(store.get(task.id), undefined, 'past the TTL');
  assert.equal(store.list().length, 0);
});

test('TaskStore: onChange fires per transition and stops after dispose', () => {
  const store = new TaskStore();
  const seen = [];
  const dispose = store.onChange((task) => seen.push(`${task.state}:${task.artifacts.length}`));
  const task = store.create({});
  store.update(task.id, { state: 'completed' });
  store.attachArtifact(task.id, makeArtifact({ text: 'x' }));
  assert.deepEqual(seen, ['submitted:0', 'completed:0', 'completed:1']);
  dispose();
  store.update(task.id, { state: 'failed' });
  assert.equal(seen.length, 3, 'a disposed listener must not be called again');
});

test('TaskStore: a throwing subscriber cannot break a task transition', () => {
  const store = new TaskStore();
  store.onChange(() => {
    throw new Error('subscriber bug');
  });
  const task = store.create({});
  assert.equal(store.update(task.id, { state: 'completed' }).state, 'completed');
});

test('TaskStore: limit evicts the oldest task', () => {
  const store = new TaskStore({ limit: 2 });
  const first = store.create({});
  const second = store.create({});
  const third = store.create({});
  assert.equal(store.get(first.id), undefined);
  assert.equal(store.get(second.id) !== undefined, true);
  assert.equal(store.get(third.id) !== undefined, true);
});

test('TaskStore: flush writes JSON that a fresh store restores', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a2a-wire-'));
  try {
    const path = join(dir, 'tasks.json');
    const store = new TaskStore({ persistPath: path });
    const task = store.create({ contextId: 'ctx-1' });
    store.update(task.id, { state: 'completed' });
    store.attachArtifact(task.id, makeArtifact({ artifactId: 'artifact-1', text: 'reply' }));
    assert.equal(store.flush(), true);

    const raw = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(raw.version, 1);
    assert.equal(raw.tasks.length, 1);
    assert.equal(raw.tasks[0].id, task.id);
    assert.equal(raw.tasks[0].state, 'completed');

    const restored = new TaskStore({ persistPath: path });
    const reloaded = restored.get(task.id);
    assert.equal(reloaded.state, 'completed');
    assert.equal(reloaded.contextId, 'ctx-1');
    assert.deepEqual(reloaded.artifacts.map((entry) => entry.artifactId), ['artifact-1']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TaskStore: the persisted file is not world-readable where the OS honours it', (t) => {
  if (process.platform === 'win32') {
    console.log('POSIX file modes are not enforced on win32; skipping the 0o600 assertion');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'a2a-wire-mode-'));
  try {
    const path = join(dir, 'tasks.json');
    const store = new TaskStore({ persistPath: path });
    store.create({});
    assert.equal(store.flush(), true);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TaskStore: a corrupt store file starts empty instead of failing construction', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a2a-wire-bad-'));
  try {
    const path = join(dir, 'tasks.json');
    const store = new TaskStore({ persistPath: path });
    const task = store.create({});
    assert.equal(store.flush(), true);
    // Replace the store with a truncated write, as a crash mid-file would.
    writeFileSync(path, '{"version":1,"tasks":[{"id":"broken"', 'utf8');
    let recovered;
    assert.doesNotThrow(() => {
      recovered = new TaskStore({ persistPath: path });
    });
    assert.equal(recovered.list().length, 0, 'a corrupt file must not resurrect phantom tasks');
    assert.equal(recovered.get(task.id), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TaskStore: flush without a persistPath is a no-op success', () => {
  const store = new TaskStore();
  store.create({});
  assert.equal(store.flush(), true);
  assert.equal(store.persistPath, undefined);
});

test('TaskStore: an artifact with no id gets one attached at persist boundaries', () => {
  const store = new TaskStore();
  const task = store.create({});
  store.attachArtifact(task.id, { name: 'reply', parts: [{ kind: 'text', text: 'x' }] });
  const [artifact] = store.get(task.id).artifacts;
  assert.match(artifact.artifactId, /^artifact-/);
  assert.equal(artifact.name, 'reply');
});
