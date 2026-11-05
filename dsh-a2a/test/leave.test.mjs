/**
 * Leaving a group must converge, in the only order that works.
 *
 * THE STATE THIS EXISTS FOR
 *
 * There are six states a membership can be in, and two of them are divergences:
 *
 *   1   never joined                     local none      server none
 *   2a  joined, no Session bound         local row       server row
 *   2b  joined, Session bound            local row       server row
 *   3a  server gone, local not           local row       server none    <- converges via unreachableAt
 *   3b  local gone, server not           local none      server row     <- THIS is the unrecoverable one
 *
 * 3b could not be repaired because the credential — the only thing that can withdraw the server row — lived in the
 * local row that had been deleted. "Server follows local" was therefore impossible: the intent has to travel with the
 * credential being removed.
 *
 * So leave now goes: ask the host, and only then delete. A failure keeps the row and stamps `leavingAt`, which makes
 * a retry possible and makes the operation idempotent in the sense that matters — calling it twice converges to
 * "gone" instead of the second call saying "you already left" while the host disagrees.
 *
 * @module dsh-a2a/test/leave
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGroupStore } from '../lib/core/groups.js';
import { createMembershipLedger } from '../lib/core/memberships.js';
import { normalizeConfig } from '../lib/core/config.js';
import { createToolRuntime } from '../lib/shared/tool-runtime.js';

const LOGGER = { info() {}, warn() {}, debug() {} };
const SESSION = 'session-test';

/** A bridge that records calls and answers or fails on demand. */
function stubBridge({ fail } = {}) {
  const calls = [];
  const run = async (target, input) => {
    calls.push({ target, input });
    if (fail !== undefined) {
      const error = new Error(`upstream: ${fail}`);
      error.code = -32004;
      // The real bridge puts the business sub-code in `data`, not `code`. A stub that threw the local shape would
      // hide the very bug this suite was written to catch.
      error.data = fail;
      throw error;
    }
    return { data: { left: true } };
  };
  return { calls, send: run, stream: run, discover: async () => ({ skills: [] }) };
}

/** A runtime with one hosted group and one remote membership. */
function harness({ bridge = stubBridge() } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-a2a-leave-'));
  const clock = () => Date.now();
  const config = normalizeConfig({
    groups: { gatewayBase: 'http://gw/a2a', agentName: 'agent-test' },
    client: { apiKey: 'k', forwardProto: 'http', timeoutMs: 1000 },
  });
  const store = createGroupStore({ home, logger: LOGGER, clock, config });
  const identities = createMembershipLedger({ home, logger: LOGGER, clock });

  const created = store.create({ name: '发票重构', ownerDisplayName: '张三' });
  const localGroupId = created.group.groupId;
  identities.upsert({
    sessionId: SESSION, groupId: localGroupId,
    personId: created.group.owner.personId,
    personKey: created.ownerKey,
    local: true, groupName: '发票重构', role: 'owner', lastSeq: 0,
  });

  const remoteGroupId = 'g-remote-1';
  identities.upsert({
    sessionId: SESSION, groupId: remoteGroupId,
    personId: 'p-remote', personKey: 'mk_secret',
    local: false, baseUrl: 'http://gw/a2a/host', groupName: '远程群', role: 'member', lastSeq: 0,
  });

  const runtime = createToolRuntime({ store, identities, bridge, config, logger: LOGGER, clock });
  return {
    store, identities, bridge, runtime, localGroupId, remoteGroupId, sessionId: SESSION,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// State 1 -> leave: nothing to do
// ---------------------------------------------------------------------------

test('leaving a group this Session was never in reports success', async () => {
  const env = harness();
  try {
    const result = await env.runtime.call('a2a_group_leave', { groupId: 'g-never' }, { sessionId: SESSION });
    // Idempotence starts here: "not a member" is the desired end state, so it is success, not an error.
    assert.equal(result.left, true);
    assert.equal(result.pending, false);
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// State 2 -> 1, hosted group
// ---------------------------------------------------------------------------

test('leaving a hosted group removes the member and the local row', async () => {
  const env = harness();
  try {
    const result = await env.runtime.call('a2a_group_leave', { groupId: env.localGroupId }, { sessionId: SESSION });
    assert.equal(result.left, true);

    // The store is the authority for a hosted group, so both sides must change together.
    assert.equal(env.identities.get(env.localGroupId, SESSION), undefined);
    assert.equal(env.store.snapshot({ groupId: env.localGroupId }).memberCount, 0);
  } finally {
    env.cleanup();
  }
});

test('leaving a hosted group twice is not an error', async () => {
  const env = harness();
  try {
    await env.runtime.call('a2a_group_leave', { groupId: env.localGroupId }, { sessionId: SESSION });
    const again = await env.runtime.call('a2a_group_leave', { groupId: env.localGroupId }, { sessionId: SESSION });
    assert.equal(again.left, true);
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// State 2 -> 1, remote group: the host is told first
// ---------------------------------------------------------------------------

test('leaving a remote group tells the host before dropping the credential', async () => {
  const env = harness();
  try {
    const result = await env.runtime.call('a2a_group_leave', { groupId: env.remoteGroupId }, { sessionId: SESSION });
    assert.equal(result.left, true);

    // The order is the whole fix: the skill call must carry the credential, which means it must happen while the row
    // still exists.
    const leaveCall = env.bridge.calls.find((call) => call.input.skill === 'group/leave');
    assert.ok(leaveCall !== undefined, 'the host must be told');
    assert.equal(leaveCall.input.data.personKey, 'mk_secret', 'with the credential that is about to be deleted');

    // Only then is the local row removed.
    assert.equal(env.identities.get(env.remoteGroupId, SESSION), undefined);
  } finally {
    env.cleanup();
  }
});

test('a failed leave keeps the credential, records the intent, and is retryable', async () => {
  const env = harness({ bridge: stubBridge({ fail: 'unreachable' }) });
  try {
    const result = await env.runtime.call('a2a_group_leave', { groupId: env.remoteGroupId }, { sessionId: SESSION });
    assert.equal(result.left, false);
    assert.equal(result.pending, true);

    const row = env.identities.get(env.remoteGroupId, SESSION);
    // This is the state that used to be unrecoverable: deletion would have destroyed the only credential capable of
    // withdrawing the host-side row.
    assert.ok(row !== undefined, 'the row must survive a failed leave');
    assert.equal(row.personKey, 'mk_secret', 'and keep the credential');
    assert.equal(typeof row.leavingAt, 'number', 'and remember that leaving was attempted');
  } finally {
    env.cleanup();
  }
});

test('a retry after a failure completes the leave', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-a2a-leave-retry-'));

  // First attempt: the host is down.
  const failing = stubBridge({ fail: 'unreachable' });
  const clock = () => Date.now();
  const config = normalizeConfig({
    groups: { gatewayBase: 'http://gw/a2a', agentName: 'agent-test' },
    client: { apiKey: 'k', forwardProto: 'http', timeoutMs: 1000 },
  });
  const store = createGroupStore({ home, logger: LOGGER, clock, config });
  const identities = createMembershipLedger({ home, logger: LOGGER, clock });
  identities.upsert({
    sessionId: SESSION, groupId: 'g-remote-1', personId: 'p', personKey: 'mk_secret',
    local: false, baseUrl: 'http://gw/a2a/host', groupName: '远程群', role: 'member',
  });

  const first = createToolRuntime({ store, identities, bridge: failing, config, logger: LOGGER, clock });
  await first.call('a2a_group_leave', { groupId: 'g-remote-1' }, { sessionId: SESSION });
  assert.equal(typeof identities.get('g-remote-1', SESSION).leavingAt, 'number');

  try {
    // Second attempt: the host is back. The SAME credential is still there to use.
    const working = createToolRuntime({ store, identities, bridge: stubBridge(), config, logger: LOGGER, clock });
    const second = await working.call('a2a_group_leave', { groupId: 'g-remote-1' }, { sessionId: SESSION });

    assert.equal(second.left, true, 'the retry must complete');
    assert.equal(identities.get('g-remote-1', SESSION), undefined, 'and then drop the row');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a host that says the member is already gone still finishes the leave', async () => {
  const env = harness({ bridge: stubBridge({ fail: 'not_member' }) });
  try {
    const result = await env.runtime.call('a2a_group_leave', { groupId: env.remoteGroupId }, { sessionId: SESSION });
    // The outcome we wanted has already happened, however it arrived; keeping a spent credential would be clutter
    // that fails every later call.
    assert.equal(result.left, true);
    assert.equal(env.identities.get(env.remoteGroupId, SESSION), undefined);
  } finally {
    env.cleanup();
  }
});

test('leaving twice after a successful remote leave is not an error', async () => {
  const env = harness();
  try {
    await env.runtime.call('a2a_group_leave', { groupId: env.remoteGroupId }, { sessionId: SESSION });
    const again = await env.runtime.call('a2a_group_leave', { groupId: env.remoteGroupId }, { sessionId: SESSION });
    // Idempotence: converging to "gone" twice must not produce a failure the caller has to interpret.
    assert.equal(again.left, true);
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// The leavingAt stamp survives a restart
// ---------------------------------------------------------------------------

test('the leaving stamp survives a reload, so a retry works after a restart', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-a2a-leave-persist-'));
  try {
    const clock = () => Date.now();
    const first = createMembershipLedger({ home, logger: LOGGER, clock });
    first.upsert({ sessionId: SESSION, groupId: 'g', personId: 'p', personKey: 'k', local: false, leavingAt: 777 });
    first.flush?.();

    // A stamp that only lives in memory would be lost exactly when the retry matters — after the restart that
    // interrupted the first attempt.
    const second = createMembershipLedger({ home, logger: LOGGER, clock });
    assert.equal(second.get('g', SESSION).leavingAt, 777);
    assert.equal(second.get('g', SESSION).personKey, 'k');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Publishing the new tool
// ---------------------------------------------------------------------------

test('the leave tool is advertised to a model', async () => {
  const { TOOL_SPECS } = await import('../lib/shared/tool-specs.js');
  const spec = TOOL_SPECS.find((entry) => entry.name === 'a2a_group_leave');
  assert.ok(spec !== undefined, 'a model can only leave if the tool is published');
  assert.match(spec.description, /idempotent|twice|retry/i, 'the description must warn that a retry is safe');
  assert.deepEqual(spec.parameters.required, ['groupId']);
});
