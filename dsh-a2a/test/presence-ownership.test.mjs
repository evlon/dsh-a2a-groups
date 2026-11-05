/**
 * Presence belongs to the running process, and leaving can be announced.
 *
 * THE BUG THIS WOULD HAVE CAUGHT
 *
 * `lastSeenAt` was refreshed only by `group/subscribe`'s heartbeat. Three instances ran for hours with no subscription,
 * so nothing called `touch`, so `lastSeenAt` froze at start-up — and two minutes later every member was shown offline
 * while all three were alive and posting.
 *
 * WHY THE OLD TESTS MISSED IT
 *
 * Every presence test asserted the FORMULA (`now - lastSeenAt <= ONLINE_WINDOW`) with a clock that never advanced.
 * The bug was not in the formula; it was that nothing kept the input fresh. A test that never lets time pass cannot
 * observe a value that decays with time.
 *
 * So these tests take a fake clock and MOVE it, which is the only way to express "two minutes later, is this still
 * true?". That gap — not a missing assertion, a missing dimension — is why the defect shipped twice.
 *
 * @module dsh-a2a/test/presence-ownership
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

import { createGroupStore, ONLINE_WINDOW_MS } from '../lib/core/groups.js';
import { normalizeConfig } from '../lib/core/config.js';

const LOGGER = { info() {}, warn() {}, debug() {} };

/**
 * A store on a clock the test controls.
 *
 * The point of this harness is the `advance` function: presence is a function of elapsed time, so every assertion here
 * moves the clock rather than trusting `Date.now()`.
 */
function harness() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-a2a-own-'));
  let tick = 1_800_000_000_000;
  const clock = () => tick;
  const config = normalizeConfig({ groups: { gatewayBase: 'http://gw/a2a', agentName: 'agent-test' } });
  const store = createGroupStore({ home, logger: LOGGER, clock, config });

  const created = store.create({ name: '发票重构', ownerDisplayName: '张三' });
  const groupId = created.group.groupId;
  const owner = { personId: created.group.owner.personId, personKey: created.ownerKey };

  return {
    store,
    groupId,
    owner,
    /** Move time forward, in milliseconds. */
    advance: (ms) => {
      tick += ms;
    },
    now: () => tick,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

/** The roster row for one person. */
function rowOf(env, personId) {
  return env.store.members({ groupId: env.groupId, member: env.owner }).find((row) => row.personId === personId);
}

test('a member goes offline by itself once the window passes', () => {
  const env = harness();
  try {
    // Just joined, so present.
    assert.equal(rowOf(env, env.owner.personId).online, true);

    // Nothing happens for longer than the window. This is the assertion the old suite could not make.
    env.advance(ONLINE_WINDOW_MS + 1000);
    assert.equal(rowOf(env, env.owner.personId).online, false, 'presence must decay without a heartbeat');
  } finally {
    env.cleanup();
  }
});

test('a heartbeat keeps a member online indefinitely', () => {
  const env = harness();
  try {
    // Ten minutes of ticks, never longer than the window: the member must stay visibly present the whole time.
    for (let elapsed = 0; elapsed < 600_000; elapsed += 50_000) {
      env.advance(50_000);
      env.store.touch({ groupId: env.groupId, member: env.owner });
      assert.equal(rowOf(env, env.owner.personId).online, true, `still online at +${elapsed + 50_000}ms`);
    }
  } finally {
    env.cleanup();
  }
});

test('a missed tick does not flicker a member offline', () => {
  const env = harness();
  try {
    env.store.touch({ groupId: env.groupId, member: env.owner });
    // One tick missed: 100s elapsed against a 120s window.
    env.advance(100_000);
    assert.equal(rowOf(env, env.owner.personId).online, true, 'a single dropped tick must not disconnect anybody');
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Announcing the departure
// ---------------------------------------------------------------------------

test('markAway takes a member offline immediately', () => {
  const env = harness();
  try {
    assert.equal(rowOf(env, env.owner.personId).online, true);

    env.store.markAway({ groupId: env.groupId, member: env.owner });

    // No waiting out the window: a clean shutdown should be visible at once, not two minutes later.
    assert.equal(rowOf(env, env.owner.personId).online, false);
  } finally {
    env.cleanup();
  }
});

test('markAway refuses a bad credential instead of marking somebody else away', () => {
  const env = harness();
  try {
    // Setting another member's presence from a wrong key would be a way to hide a colleague.
    assert.throws(
      () => env.store.markAway({ groupId: env.groupId, member: { personId: env.owner.personId, personKey: 'mk_wrong' } }),
      (error) => error.code === 'not_member',
    );
    assert.equal(rowOf(env, env.owner.personId).online, true, 'the real member is untouched');
  } finally {
    env.cleanup();
  }
});

test('coming back after an away is possible', () => {
  const env = harness();
  try {
    env.store.markAway({ groupId: env.groupId, member: env.owner });
    assert.equal(rowOf(env, env.owner.personId).online, false);

    // A restart touches again; presence must recover without any repair step.
    env.store.touch({ groupId: env.groupId, member: env.owner });
    assert.equal(rowOf(env, env.owner.personId).online, true);
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// The wiring: a heartbeat that is not inside a subscription
// ---------------------------------------------------------------------------

test('the presence timer lives in the plugin, not in the subscribe skill', () => {
  // This is the structural fix. If it moves back into `group/subscribe`, presence becomes a side effect of watching
  // the inbox again — which is exactly how three live instances were shown as offline.
  const index = readFileSync('lib/index.js', 'utf8');
  assert.match(index, /const presenceHeartbeat = \(\) =>/u);
  assert.match(index, /setInterval\(presenceHeartbeat, PRESENCE_TICK_MS\)/u);
  assert.match(index, /presenceHeartbeat\(\);/u, 'one immediate tick, so a fresh start is online at once');
});

test('the timer is cleared and a goodbye is sent on dispose', () => {
  const index = readFileSync('lib/index.js', 'utf8');
  const at = index.indexOf('presenceHeartbeat');
  assert.ok(at > -1);
  assert.match(index, /clearInterval\(presenceTimer\)/u, 'a disposed plugin must not leave a timer running');
  assert.match(index, /skill: 'group\/away'/u, 'and should say goodbye while it still can');
});

test('the host serves both skills the heartbeat needs', () => {
  const skills = readFileSync('lib/core/skills-group.js', 'utf8');
  // Without these the heartbeat calls fall on a host that does not know them, and presence silently never updates.
  assert.match(skills, /id: 'group\/touch'/u);
  assert.match(skills, /id: 'group\/away'/u);
});

test('touch is cheap: it refreshes presence and returns', () => {
  const skills = readFileSync('lib/core/skills-group.js', 'utf8');
  const at = skills.indexOf("id: 'group/touch'");
  const body = skills.slice(at, skills.indexOf("id: 'group/away'", at));
  // It runs every fifty seconds per group on every member's machine.
  assert.match(body, /store\.touch\(\{ groupId, member \}\)/u);
  assert.equal(/sendPersonMessage|appendSystem/u.test(body), false, 'a heartbeat must not write to the feed');
});
