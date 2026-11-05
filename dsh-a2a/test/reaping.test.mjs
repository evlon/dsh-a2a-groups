/**
 * Tests for what happens when the host says a membership does not exist.
 *
 * THE OLD BEHAVIOUR, AND WHY IT WAS WRONG
 *
 * The local membership row used to be DELETED on `unknown_group` or `not_member`. That looked tidy — clear the
 * stale record, stop showing a group that no longer works — but it is irreversible and the evidence is weak.
 *
 * Observed for real: a host was restarted against a different data directory and briefly served nothing. Every
 * member was told `unknown_group`, every member deleted its row, and when the real data came back nobody could
 * reach the group any more. `personKey` is issued once at join and stored nowhere else, so the deletion destroyed
 * the only copy of the only credential that could ever speak in that group.
 *
 * THE CURRENT BEHAVIOUR
 *
 * Stamp `unreachableAt` and keep the row. The panel can then say "unreachable" instead of silently losing the
 * group, and the next success clears the stamp, so recovery needs no user action.
 *
 * The tests below pin both halves: the row is MARKED on the two codes that mean it, and untouched for anything
 * else — a broader sweep would turn one stale credential into a wiped ledger.
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createToolRuntime } from '../lib/shared/tool-runtime.js';
import { createMembershipLedger } from '../lib/core/memberships.js';

const EXISTING = {
  sessionId: 's-1',
  groupId: 'g-1',
  personId: 'p-1',
  personKey: 'secret-key',
  local: false,
  baseUrl: 'http://gw/a2a/host',
  groupName: '发票重构',
  role: 'member',
  lastSeq: 7,
};

/** A ledger that records what was asked of it. */
function fakeIdentities(overrides = {}) {
  const calls = { upsert: [], remove: [], flush: 0 };
  return {
    calls,
    list: () => [EXISTING],
    get: () => EXISTING,
    has: () => true,
    upsert: (input) => {
      calls.upsert.push(input);
      return input;
    },
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
function runtimeFailingWith(code, identities) {
  const fail = async () => {
    const error = new Error(code);
    error.code = code;
    throw error;
  };
  return createToolRuntime({
    identities,
    logger: { info() {}, warn() {}, debug() {} },
    bridge: { send: fail, stream: fail, discover: async () => ({ skills: [] }) },
    config: { groups: {}, client: { timeoutMs: 1000 } },
  });
}

/** Drive a tool that needs a remote membership. */
async function callRemote(runtime) {
  try {
    await runtime.call('a2a_group_read', { groupId: 'g-1' }, { sessionId: 's-1' });
  } catch {
    // The error is expected; the side effect is what is under test.
  }
}

test('unknown_group marks the membership unreachable instead of deleting it', async () => {
  const identities = fakeIdentities();
  await callRemote(runtimeFailingWith('unknown_group', identities));

  assert.equal(identities.calls.remove.length, 0, 'the row must never be deleted: personKey lives only there');
  assert.equal(identities.calls.upsert.length, 1, 'it must be stamped');
  assert.ok(
    typeof identities.calls.upsert[0].unreachableAt === 'number',
    'the stamp is what the panel shows and what a success clears',
  );
});

test('not_member marks it too', async () => {
  const identities = fakeIdentities();
  await callRemote(runtimeFailingWith('not_member', identities));

  assert.equal(identities.calls.remove.length, 0);
  assert.equal(identities.calls.upsert.length, 1);
});

test('the credential is preserved by the stamp', async () => {
  const identities = fakeIdentities();
  await callRemote(runtimeFailingWith('unknown_group', identities));

  const stamped = identities.calls.upsert[0];
  // The whole point: the row survives WITH the key, or recovery after a host restart is impossible.
  assert.equal(stamped.personKey, 'secret-key', 'the personKey must be carried through unchanged');
  assert.equal(stamped.personId, 'p-1');
  assert.equal(stamped.groupId, 'g-1');
  assert.equal(stamped.sessionId, 's-1');
});

test('the cached group name survives, so the reader still knows which group it was', async () => {
  const identities = fakeIdentities();
  await callRemote(runtimeFailingWith('unknown_group', identities));

  // Losing the name would leave a bare groupId in the panel, which reads as a different, broken feature.
  assert.equal(identities.calls.upsert[0].groupName, '发票重构');
});

test('an unrelated code changes nothing', async () => {
  const identities = fakeIdentities();
  await callRemote(runtimeFailingWith('task_timeout', identities));

  // A timeout is this host's failure, not evidence about the membership. Stamping it would mark every group
  // unreachable during a network blip.
  assert.equal(identities.calls.upsert.length, 0, 'no stamp for an unrelated code');
  assert.equal(identities.calls.remove.length, 0);
});

test('marking is scoped to one (groupId, sessionId) pair', async () => {
  const identities = fakeIdentities();
  await callRemote(runtimeFailingWith('unknown_group', identities));

  const stamped = identities.calls.upsert[0];
  // One stale credential must not become a wiped ledger.
  assert.equal(stamped.groupId, 'g-1');
  assert.equal(stamped.sessionId, 's-1');
});

test('a missing row is not stamped', async () => {
  const identities = fakeIdentities({ get: () => undefined });
  await callRemote(runtimeFailingWith('unknown_group', identities));

  // Nothing to mark: inventing a row here would create a membership the user never had.
  assert.equal(identities.calls.upsert.length, 0);
});

test('the ledger clears the stamp when told the membership is reachable again', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-a2a-clear-'));
  try {
    const ledger = createMembershipLedger({ home, logger: { info() {}, warn() {}, debug() {} }, clock: () => Date.now() });
    ledger.upsert({ sessionId: 's', groupId: 'g', personId: 'p', personKey: 'k', unreachableAt: Date.now() });
    assert.ok(ledger.get('g', 's').unreachableAt !== undefined, 'the stamp is set');

    // Recovery must be one ordinary success away, not a separate repair step the user has to know about.
    ledger.upsert({ sessionId: 's', groupId: 'g', reachable: true });
    assert.equal(ledger.get('g', 's').unreachableAt, undefined, 'a success clears it');
    assert.equal(ledger.get('g', 's').personKey, 'k', 'and keeps the credential');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the stamp survives a reload of the ledger file', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-a2a-persist-'));
  try {
    const clock = () => Date.now();
    const logger = { info() {}, warn() {}, debug() {} };
    const first = createMembershipLedger({ home, logger, clock });
    first.upsert({ sessionId: 's', groupId: 'g', personId: 'p', personKey: 'k', unreachableAt: 123 });
    first.flush?.();

    // A stamp that only lives in memory would be lost on restart, which is precisely when a host is most likely to
    // come back with its real data.
    const second = createMembershipLedger({ home, logger, clock });
    assert.equal(second.get('g', 's').unreachableAt, 123);
    assert.equal(second.get('g', 's').personKey, 'k');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
