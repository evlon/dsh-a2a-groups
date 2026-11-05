/**
 * Coverage for the membership ledger's queries, its removal forms, and its tolerance of a broken file.
 *
 * WHY THIS FILE
 *
 * `memberships.js` held 91% of its lines but only 56% of its branches, and the missing half was almost entirely the
 * paths that run when something is WRONG: a corrupt file, a version-1 file, a record missing an id, the cap that
 * drops the oldest entries. Those are the paths a member hits exactly once and never forgets — their ledger is the
 * only copy of every credential they hold.
 *
 * They were also the paths most likely to be wrong, because nobody had ever run them.
 *
 * @module dsh-a2a/test/memberships-ledger
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMembershipLedger } from '../lib/core/memberships.js';

const LOGGER = { info() {}, warn() {}, debug() {} };

/** A ledger over a fresh directory. */
function ledgerAt(home, clock = () => Date.now()) {
  return createMembershipLedger({ home, logger: LOGGER, clock });
}

/** A fresh directory holding an `a2a` state folder with the given file content. */
function withStateFile(content) {
  // The ledger takes the STATE DIRECTORY itself as \home\ and writes memberships.json directly into it — unlike
  // the group store, which is handed an \2a\ folder. Getting this wrong wrote the fixture somewhere the ledger
  // never looked, and the test passed a wrong assertion for a while.
  const home = mkdtempSync(join(tmpdir(), 'dsh-a2a-ledger-'));
  writeFileSync(join(home, 'memberships.json'), content, 'utf8');
  return home;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

test('has answers whether any Session of this instance is in the group', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-a2a-q-'));
  try {
    const ledger = ledgerAt(home);
    ledger.upsert({ sessionId: 's-1', groupId: 'g-1', personId: 'p', personKey: 'k', local: true });

    // Used to decide "do I host this?", so a false negative sends a local operation over the network.
    assert.equal(ledger.has('g-1'), true);
    assert.equal(ledger.has('g-2'), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('membershipsOf returns only the named Session', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-a2a-q2-'));
  try {
    const ledger = ledgerAt(home);
    ledger.upsert({ sessionId: 's-1', groupId: 'g-1', personId: 'p', personKey: 'k' });
    ledger.upsert({ sessionId: 's-1', groupId: 'g-2', personId: 'p', personKey: 'k' });
    ledger.upsert({ sessionId: 's-2', groupId: 'g-3', personId: 'q', personKey: 'k2' });

    // The panel and the inbox both scope by Session; leaking another Session rows would show somebody else groups.
    assert.equal(ledger.membershipsOf('s-1').length, 2);
    assert.equal(ledger.membershipsOf('s-2').length, 1);
    assert.equal(ledger.membershipsOf('s-none').length, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('local and remote memberships are separated by the local flag', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-a2a-q3-'));
  try {
    const ledger = ledgerAt(home);
    ledger.upsert({ sessionId: 's', groupId: 'g-local', personId: 'p', personKey: 'k', local: true });
    ledger.upsert({ sessionId: 's', groupId: 'g-remote', personId: 'p', personKey: 'k', local: false });

    // The two sets take different code paths — in-process store versus network — so mixing them up is a wire bug.
    assert.deepEqual(ledger.localMemberships().map((row) => row.groupId), ['g-local']);
    assert.deepEqual(ledger.remoteMemberships().map((row) => row.groupId), ['g-remote']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

test('remove deletes one membership by group and Session', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-a2a-r-'));
  try {
    const ledger = ledgerAt(home);
    ledger.upsert({ sessionId: 's-1', groupId: 'g-1', personId: 'p', personKey: 'k' });
    ledger.upsert({ sessionId: 's-1', groupId: 'g-2', personId: 'p', personKey: 'k' });

    assert.equal(ledger.remove({ groupId: 'g-1', sessionId: 's-1' }), 1);
    // The second group must survive: removal is scoped, and a broad sweep would wipe the ledger.
    assert.equal(ledger.get('g-2', 's-1').groupName === undefined ? 'still-there' : 'still-there', 'still-there');
    assert.ok(ledger.get('g-2', 's-1') !== undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('remove with only a sessionId clears that Session everywhere', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-a2a-r2-'));
  try {
    const ledger = ledgerAt(home);
    ledger.upsert({ sessionId: 's-1', groupId: 'g-1', personId: 'p', personKey: 'k' });
    ledger.upsert({ sessionId: 's-1', groupId: 'g-2', personId: 'p', personKey: 'k' });
    ledger.upsert({ sessionId: 's-2', groupId: 'g-1', personId: 'q', personKey: 'k2' });

    // A deleted Session leaves credentials nobody can use; keeping them is a leak with no upside.
    assert.equal(ledger.remove({ sessionId: 's-1' }), 2);
    assert.equal(ledger.get('g-1', 's-2') !== undefined, true, 'the other Session is untouched');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('remove with no selector removes nothing', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-a2a-r3-'));
  try {
    const ledger = ledgerAt(home);
    ledger.upsert({ sessionId: 's', groupId: 'g', personId: 'p', personKey: 'k' });

    // An empty selector must not mean "everything": that is how a bug becomes a wiped ledger.
    assert.equal(ledger.remove({}), 0);
    assert.ok(ledger.get('g', 's') !== undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tolerance of a broken file
// ---------------------------------------------------------------------------

test('a corrupt file starts empty rather than crashing', () => {
  const home = withStateFile('{ this is not json');
  try {
    // Starting empty is recoverable — the person re-joins. Throwing on load would make the plugin refuse to start,
    // which is worse than losing a cache.
    const ledger = ledgerAt(home);
    assert.equal(ledger.list().length, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a version-1 file is dropped rather than guessed at', () => {
  // Version 1 had no sessionId; there is no correct Session to attach an old membership to.
  const home = withStateFile(JSON.stringify({ version: 1, memberships: [{ groupId: 'g-1', personId: 'p' }] }));
  try {
    const ledger = ledgerAt(home);
    assert.equal(ledger.list().length, 0, 'an unassignable membership must not be invented');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('records missing an id are skipped, and the rest are kept', () => {
  const home = withStateFile(JSON.stringify({
    version: 2,
    memberships: [
      { groupId: 'g-1', sessionId: 's-1', personId: 'p', personKey: 'k' },
      { groupId: '', sessionId: 's-1' },
      { groupId: 'g-2' },
      { sessionId: 's-2' },
      { groupId: 'g-3', sessionId: 's-3', personId: 'q', personKey: 'k3' },
    ],
  }));
  try {
    const ledger = ledgerAt(home);
    // One bad row must not cost the others: a partial file is the normal result of a crash mid-write.
    assert.deepEqual(ledger.list().map((row) => row.groupId).sort(), ['g-1', 'g-3']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a missing file is simply an empty ledger', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-a2a-none-'));
  try {
    // A first run has no file; that is not an error condition.
    assert.equal(ledgerAt(home).list().length, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The cap
// ---------------------------------------------------------------------------

test('the oldest memberships are dropped when the ledger exceeds its cap', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-a2a-cap-'));
  try {
    let tick = 1_700_000_000_000;
    const ledger = ledgerAt(home, () => (tick += 1000));

    // An instance that joins hundreds of groups has a bug; an unbounded state file is worse than forgetting.
    for (let index = 0; index < 520; index += 1) {
      ledger.upsert({ sessionId: 's', groupId: `g-${index}`, personId: 'p', personKey: 'k' });
    }

    const rows = ledger.list();
    assert.ok(rows.length <= 500, `the cap must hold, saw ${rows.length}`);
    // The newest must survive and the oldest must be the ones dropped, or a busy instance would lose today work.
    assert.ok(ledger.get('g-519', 's') !== undefined, 'the newest survives');
    assert.equal(ledger.get('g-0', 's'), undefined, 'the oldest was dropped');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Persistence round trip
// ---------------------------------------------------------------------------

test('every field survives a reload, including the ones added late', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-a2a-rt-'));
  try {
    const ledger = ledgerAt(home);
    ledger.upsert({
      sessionId: 's',
      groupId: 'g',
      personId: 'p',
      personKey: 'mk_secret',
      local: false,
      baseUrl: 'http://gw/a2a/host',
      groupName: '发票重构',
      groupTopic: '对账',
      role: 'owner',
      lastSeq: 42,
      memberCount: 3,
      onlineCount: 2,
      isOwner: true,
      members: [{ personId: 'p', displayName: '张三' }],
      rosterCachedAt: 1_700_000_000_000,
      unreachableAt: 1_700_000_001_000,
    });
    ledger.flush?.();

    // Reloading is what a restart does. A field the loader forgets is a field that silently becomes undefined on
    // every restart — which is how the unreachable stamp survived nothing at all for one revision.
    const reloaded = ledgerAt(home);
    const row = reloaded.get('g', 's');
    assert.equal(row.personKey, 'mk_secret');
    assert.equal(row.groupName, '发票重构');
    assert.equal(row.memberCount, 3);
    assert.equal(row.lastSeq, 42);
    assert.equal(row.unreachableAt, 1_700_000_001_000);
    assert.equal(row.rosterCachedAt, 1_700_000_000_000);
    assert.equal(row.isOwner, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the file on disk carries no plaintext credential in a readable field name it should not have', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-a2a-disk-'));
  try {
    const ledger = ledgerAt(home);
    ledger.upsert({ sessionId: 's', groupId: 'g', personId: 'p', personKey: 'mk_plain', local: true });
    ledger.flush?.();

    const raw = readFileSync(join(home, 'memberships.json'), 'utf8');
    // The member key IS stored in plaintext here by design — this machine must be able to present it. The test
    // records that fact so nobody "fixes" it into a hash and breaks every member's ability to post.
    assert.ok(raw.includes('mk_plain'), 'the member key lives here on purpose: it is the only copy');
    assert.ok(!raw.includes('password'), 'but nothing password-shaped belongs in this file');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
