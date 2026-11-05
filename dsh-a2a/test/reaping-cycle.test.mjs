/**
 * The full stamp-and-recover cycle, through the real tool runtime.
 *
 * The previous tests pin each half separately. This one asserts the property that actually matters to a user whose
 * host went away for a while: after a failure marks the membership and a later call succeeds, the mark is gone and
 * the credential is intact — with no repair step in between.
 *
 * That is the difference between "your group is temporarily unreachable" and "you have been removed and must be
 * re-invited". The old code chose the second, permanently, on the strength of one answer from a host that might have
 * been restarted against the wrong data directory.
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMembershipLedger } from '../lib/core/memberships.js';
import { createToolRuntime } from '../lib/shared/tool-runtime.js';

const HOME_LOGGER = { info() {}, warn() {}, debug() {} };

/** A ledger on disk, with one remote membership already recorded. */
function harness() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-a2a-cycle-'));
  const ledger = createMembershipLedger({ home, logger: HOME_LOGGER, clock: () => Date.now() });
  ledger.upsert({
    sessionId: 's-1',
    groupId: 'g-1',
    personId: 'p-1',
    personKey: 'secret-key',
    local: false,
    baseUrl: 'http://gw/a2a/host',
    groupName: '发票重构',
    role: 'member',
    lastSeq: 7,
  });
  return { home, ledger, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/** A runtime whose bridge outcome is chosen per test. */
function runtimeWith(ledger, outcome) {
  const send = async () => {
    if (outcome === 'ok') return { data: { entries: [], lastSeq: 7 } };
    const error = new Error(outcome);
    error.code = outcome;
    throw error;
  };
  return createToolRuntime({
    identities: ledger,
    logger: HOME_LOGGER,
    bridge: { send, stream: send, discover: async () => ({ skills: [] }) },
    config: { groups: {}, client: { timeoutMs: 1000 } },
  });
}

test('a failure marks the group, and a later success clears the mark', async () => {
  const env = harness();
  try {
    // 1. The host answers as if the membership did not exist.
    await runtimeWith(env.ledger, 'unknown_group')
      .call('a2a_group_read', { groupId: 'g-1' }, { sessionId: 's-1' })
      .catch(() => {});

    const marked = env.ledger.get('g-1', 's-1');
    assert.ok(marked !== undefined, 'the row must survive the failure');
    assert.ok(typeof marked.unreachableAt === 'number', 'it must be marked');
    assert.equal(marked.personKey, 'secret-key', 'and keep the credential, which exists nowhere else');

    // 2. The host comes back with its real data.
    await runtimeWith(env.ledger, 'ok')
      .call('a2a_group_read', { groupId: 'g-1' }, { sessionId: 's-1' })
      .catch(() => {});

    const recovered = env.ledger.get('g-1', 's-1');
    assert.equal(recovered.unreachableAt, undefined, 'the mark must be gone after one success');
    assert.equal(recovered.personKey, 'secret-key', 'and the credential still there');
    assert.equal(recovered.groupName, '发票重构', 'and the cached name, so the panel still reads correctly');
  } finally {
    env.cleanup();
  }
});

test('the mark survives a restart, so recovery works across the restart that caused it', () => {
  const env = harness();
  try {
    env.ledger.upsert({ sessionId: 's-1', groupId: 'g-1', unreachableAt: 999 });
    env.ledger.flush?.();

    // Reload from disk: this is what a DSH restart does, and it is exactly when a host is likely to return with its
    // real data. A stamp that only lived in memory would be gone here, and the group would be re-marked by the next
    // failure — but worse, the panel could not explain the gap.
    const reloaded = createMembershipLedger({ home: env.home, logger: HOME_LOGGER, clock: () => Date.now() });
    assert.equal(reloaded.get('g-1', 's-1').unreachableAt, 999);
  } finally {
    env.cleanup();
  }
});

test('a failure on one group does not mark another', async () => {
  const env = harness();
  try {
    env.ledger.upsert({
      sessionId: 's-1',
      groupId: 'g-2',
      personId: 'p-2',
      personKey: 'other-key',
      local: false,
      groupName: '另一个群',
    });

    await runtimeWith(env.ledger, 'unknown_group')
      .call('a2a_group_read', { groupId: 'g-1' }, { sessionId: 's-1' })
      .catch(() => {});

    // One stale credential must not become a wiped ledger.
    assert.ok(typeof env.ledger.get('g-1', 's-1').unreachableAt === 'number');
    assert.equal(env.ledger.get('g-2', 's-1').unreachableAt, undefined);
    assert.equal(env.ledger.get('g-2', 's-1').personKey, 'other-key');
  } finally {
    env.cleanup();
  }
});
