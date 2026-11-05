/**
 * `a2a_group_read` must return `from` as a STRING on both branches.
 *
 * THE BUG, AS REPORTED FROM A REAL TWO-INSTANCE RUN
 *
 *   local group    tool-runtime.js collapsed `entry.from` to `displayName`  -> worked
 *   remote group   tool-runtime.js passed `entry.from` through unchanged    -> every entry rejected
 *
 * The host produces `from` as `{ personId, displayName }` (CONTRACT.md documents that shape), but the tool's output
 * schema declares `from: { type: 'string' }`. So the remote branch handed an object to a string slot, and every read
 * of a remote group's history failed with `entries[].from must be a string`.
 *
 * It went unnoticed because the local branch normalises first — so the same tool worked or broke depending on where
 * the group lived, and the integration tests only exercised the local path.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createToolRuntime } from '../lib/shared/tool-runtime.js';
import { TOOL_SPECS } from '../lib/shared/tool-specs.js';

/** A ledger with one remote membership. */
function remoteIdentities() {
  const record = {
    sessionId: 's-1',
    groupId: 'g-1',
    personId: 'p-1',
    personKey: 'k',
    local: false,
    baseUrl: 'http://gw/a2a/host',
    groupName: '发票重构',
    role: 'member',
    lastSeq: 0,
  };
  return {
    list: () => [record],
    get: () => record,
    has: () => true,
    upsert: () => record,
    remove: () => 0,
    flush: () => Promise.resolve(),
  };
}

/** A runtime whose bridge answers `group/read` with the given entries. */
function runtimeReturning(entries) {
  return createToolRuntime({
    identities: remoteIdentities(),
    logger: { info() {}, warn() {}, debug() {} },
    bridge: {
      send: async () => ({ data: { lastSeq: entries.length, entries } }),
      stream: async () => ({ data: {} }),
      discover: async () => ({ skills: [] }),
    },
    config: { groups: {}, client: { timeoutMs: 1000 } },
  });
}

test('the tool schema declares from as a string', () => {
  const spec = TOOL_SPECS.find((entry) => entry.name === 'a2a_group_read');
  assert.ok(spec, 'a2a_group_read must exist');
  const from = spec.output.schema.properties.entries.items.properties.from;
  assert.deepEqual(from, { type: 'string' }, 'the schema is what rejects the object, so it defines the contract');
});

test('a remote entry whose from is an object is collapsed to its display name', async () => {
  const runtime = runtimeReturning([
    { seq: 1, from: { personId: 'p-2', displayName: '李四' }, text: '对账接口改完了', at: '2026-11-05T00:44:28Z' },
  ]);

  const result = await runtime.call('a2a_group_read', { groupId: 'g-1' }, { sessionId: 's-1' });

  // This is the exact assertion the client failed: an object here is a validation error for every entry.
  assert.equal(typeof result.entries[0].from, 'string');
  assert.equal(result.entries[0].from, '李四');
});

test('a remote entry that already carries a string is left alone', async () => {
  const runtime = runtimeReturning([
    { seq: 1, from: '李四', text: 'hi', at: '2026-11-05T00:00:00Z' },
  ]);

  const result = await runtime.call('a2a_group_read', { groupId: 'g-1' }, { sessionId: 's-1' });

  // The host may some day normalise on its side; the tool must not double-wrap or mangle a plain string.
  assert.equal(result.entries[0].from, '李四');
});

test('an object with no displayName yields an empty string, never undefined', async () => {
  const runtime = runtimeReturning([
    { seq: 1, from: { personId: 'p-3' }, text: '匿名', at: '2026-11-05T00:00:00Z' },
  ]);

  const result = await runtime.call('a2a_group_read', { groupId: 'g-1' }, { sessionId: 's-1' });

  // `undefined` would fail the same schema just as loudly as the object did.
  assert.equal(result.entries[0].from, '');
});

test('every entry is normalised, not only the first', async () => {
  const runtime = runtimeReturning([
    { seq: 1, from: { personId: 'p-2', displayName: '李四' }, text: 'a', at: '2026-11-05T00:00:00Z' },
    { seq: 2, from: { personId: 'p-3', displayName: '王五' }, text: 'b', at: '2026-11-05T00:00:01Z' },
    { seq: 3, from: { personId: 'p-1', displayName: '张三' }, text: 'c', at: '2026-11-05T00:00:02Z' },
  ]);

  const result = await runtime.call('a2a_group_read', { groupId: 'g-1' }, { sessionId: 's-1' });

  // The report said entries[0] already failed, which is why the fix must not stop at the first item.
  for (const entry of result.entries) {
    assert.equal(typeof entry.from, 'string', `entry ${entry.seq} must carry a string`);
    assert.ok(entry.from !== '', `entry ${entry.seq} must name somebody`);
  }
  assert.deepEqual(result.entries.map((entry) => entry.from), ['李四', '王五', '张三']);
});
