/**
 * Tests for stale-membership reaping: when the host says the credential is dead, the local
 * record must go.
 *
 * The failure this prevents is a silent one. A removed member's machine keeps the record,
 * so their panel keeps listing the group and every action fails with a code they never see.
 * From their side the feature looks broken rather than their access having ended.
 *
 * The tests below pin both halves: the record IS removed on the two codes that mean it, and
 * it is NOT removed for anything else — a broader sweep would turn one stale credential into
 * a wiped ledger.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createToolRuntime } from '../lib/shared/tool-runtime.js';

/** A ledger that records what was asked of it. */
function fakeIdentities(overrides = {}) {
  const calls = { remove: [], flush: 0 };
  return {
    calls,
    list: () => [],
    get: () => undefined,
    has: () => false,
    upsert: () => ({}),
    remove: (where) => {
      calls.remove.push(where);
      return 1;
    },
    flush: () => {
      calls.flush += 1;
      return Promise.resolve();
    },
    ...overrides,
  };
}

/** A runtime whose bridge fails with a chosen code. */
function runtimeWith({ code, identities }) {
  return createToolRuntime({
    config: { groups: { gatewayBase: 'http://gw/a2a', agentName: 'agent-groups' }, client: { timeoutMs: 100 } },
    registry: { list: () => [], get: () => undefined, resolve: () => ({ baseUrl: 'http://gw/a2a/agent-groups' }) },
    bridge: {
      send: async () => {
        const error = new Error(`host said ${code}`);
        error.code = code;
        throw error;
      },
    },
    store: { has: () => false, list: () => [], flush: async () => {} },
    identities,
    logger: { info() {}, warn() {}, debug() {} },
  });
}

/** Call a group tool that goes over A2A and therefore surfaces the host's code. */
async function callDirectory(runtime) {
  return runtime.call('a2a_group_directory', { groupId: 'g-1' }, { sessionId: 's-1' });
}

test('not_member drops the local membership for that group and session', async () => {
  const identities = fakeIdentities();
  const runtime = runtimeWith({ code: 'not_member', identities });
  await assert.rejects(() => callDirectory(runtime), (error) => error.code === 'not_member');
  assert.deepEqual(identities.calls.remove, [{ groupId: 'g-1', sessionId: 's-1' }]);
  assert.equal(identities.calls.flush, 1, 'the in-memory ledger must reach the file');
});

test('unknown_group also drops it, because the group is gone or was never there', async () => {
  const identities = fakeIdentities();
  const runtime = runtimeWith({ code: 'unknown_group', identities });
  await assert.rejects(() => callDirectory(runtime), (error) => error.code === 'unknown_group');
  assert.deepEqual(identities.calls.remove, [{ groupId: 'g-1', sessionId: 's-1' }]);
});

test('the error is annotated so a UI can say "you were removed"', async () => {
  const identities = fakeIdentities();
  const runtime = runtimeWith({ code: 'not_member', identities });
  const error = await callDirectory(runtime).catch((caught) => caught);
  assert.equal(error.code, 'not_member', 'the original code must survive');
  assert.equal(error.membershipDropped, true, 'and the UI needs its own signal');
});

test('a transient failure does NOT drop the membership', async () => {
  // A network blip or a rate limit says nothing about membership. Dropping the record on
  // those would erase a valid membership because of one bad afternoon.
  for (const code of ['network_error', 'rate_limited', 'invite_expired', 'not_owner', 'too_long']) {
    const identities = fakeIdentities();
    const runtime = runtimeWith({ code, identities });
    await assert.rejects(() => callDirectory(runtime));
    assert.equal(identities.calls.remove.length, 0, `${code} must not touch the ledger`);
  }
});

test('an error without a groupId cannot reap anything', async () => {
  const identities = fakeIdentities();
  const runtime = runtimeWith({ code: 'not_member', identities });
  // `a2a_agents` takes no groupId, so a failure there must not sweep the ledger.
  const error = await runtime.call('a2a_agents', { action: 'list' }, { sessionId: 's-1' }).catch((caught) => caught);
  void error;
  assert.equal(identities.calls.remove.length, 0);
});

test('reaping is scoped: it asks for exactly one pair', async () => {
  const identities = fakeIdentities();
  const runtime = runtimeWith({ code: 'not_member', identities });
  await assert.rejects(() => callDirectory(runtime));
  const call = identities.calls.remove[0];
  assert.equal(Object.keys(call).sort().join(','), 'groupId,sessionId', 'no broader sweep');
});

test('a ledger without remove() does not break the tool error', async () => {
  const identities = fakeIdentities({ remove: undefined });
  const runtime = runtimeWith({ code: 'not_member', identities });
  // The original error must still surface: reaping is a courtesy, not a precondition.
  await assert.rejects(() => callDirectory(runtime), (error) => error.code === 'not_member');
});

test('a throwing ledger does not mask the tool error', async () => {
  const identities = fakeIdentities({
    remove: () => {
      throw new Error('ledger exploded');
    },
  });
  const runtime = runtimeWith({ code: 'not_member', identities });
  await assert.rejects(() => callDirectory(runtime), (error) => error.code === 'not_member');
});
