/**
 * `a2a_groups` must report a remote group's member count, not zero.
 *
 * THE BUG, AS REPORTED FROM A LIVE RUN
 *
 * A member saw `a2a_groups` say "0 member(s)" for their group while `a2a_group_info` said 2 people online, and
 * reasonably read that as data corruption. It was not: the count came only from `safeList`, which covers groups
 * hosted by THIS instance. For a remote group that lookup is empty, and the expression fell back to 0.
 *
 * The ledger had the right number all along, cached from the last info call — it was simply never consulted.
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';

import { createToolRuntime } from '../lib/shared/tool-runtime.js';

/** A ledger with one remote group and a cached member count. */
function identitiesWith(memberCount) {
  const record = {
    sessionId: 's-1',
    groupId: 'g-1',
    personId: 'p-1',
    personKey: 'k',
    local: false,
    baseUrl: 'http://gw/a2a/host',
    groupName: '发票与对账平台',
    role: 'member',
    lastSeq: 12,
    memberCount,
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

/** A runtime with no locally hosted groups, which is the situation that exposed the bug. */
function runtimeWith(identities) {
  return createToolRuntime({
    identities,
    // No `store`, so `safeList` yields nothing — exactly like a member instance that hosts no groups.
    store: undefined,
    logger: { info() {}, warn() {}, debug() {} },
    config: { groups: {}, client: { timeoutMs: 1000 } },
  });
}

test('a remote group reports the cached member count', async () => {
  const runtime = runtimeWith(identitiesWith(2));
  const result = await runtime.call('a2a_groups', {}, { sessionId: 's-1' });

  // The report: this said 0 while group_info said 2. Two tools disagreeing about the same fact is what made it
  // look like corruption rather than a display bug.
  assert.equal(result.groups[0].members, 2);
});

test('a group with no cached count still reports zero rather than undefined', async () => {
  const runtime = runtimeWith(identitiesWith(undefined));
  const result = await runtime.call('a2a_groups', {}, { sessionId: 's-1' });

  // Never fetched is a real state; the schema wants a number and the reader is told "unknown" by 0 in a list
  // context. Undefined would fail validation the way the `from` object did.
  assert.equal(result.groups[0].members, 0);
  assert.equal(typeof result.groups[0].members, 'number');
});

test('a freshly joined group shows its real size once info has been fetched', async () => {
  // The ordinary path: join caches the count, so the panel is correct from the first render.
  const runtime = runtimeWith(identitiesWith(3));
  const result = await runtime.call('a2a_groups', {}, { sessionId: 's-1' });
  assert.equal(result.groups[0].members, 3);
});
