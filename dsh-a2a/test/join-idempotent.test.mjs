/**
 * `group/join` must be idempotent per person.
 *
 * WHAT HAPPENED
 *
 * A group ended up with 张三, 李四 and TWO different 王五 rows, because join ran twice for the same person. The join
 * response is the only place a member credential is ever handed out, so the second call minted a key nobody would
 * use, and the first row became a ghost that would never speak again.
 *
 * WHAT MAKES A RETRY LIKELY
 *
 * A flaky network, an agent retrying a timeout, a person double clicking, a script run twice. None is a mistake the
 * user can see, and all of them look identical on the wire.
 *
 * THE FIX
 *
 * When the caller names an identity that is already a member, treat it as the same person: keep one row, reissue the
 * credential (the caller needs a working one), and add no second 「加入了群」 line.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGroupStore } from '../lib/core/groups.js';
import { normalizeConfig } from '../lib/core/config.js';

const LOGGER = { info() {}, warn() {}, debug() {} };

/** A store with one group and one invite. */
function harness() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-a2a-join-idem-'));
  const config = normalizeConfig({ groups: { gatewayBase: 'http://gw/a2a', agentName: 'agent-test' } });
  const store = createGroupStore({ home, logger: LOGGER, clock: () => Date.now(), config });
  const created = store.create({ name: '发票重构', ownerDisplayName: '张三' });
  const groupId = created.group.groupId;
  const invite = store.invite({ groupId, ownerKey: created.ownerKey });
  return { store, groupId, created, token: invite.token, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/** The roster, read with a working credential. */
function rosterOf(env, member) {
  return env.store.members({ groupId: env.groupId, member });
}

test('joining twice as the same person keeps one member', () => {
  const env = harness();
  try {
    const first = env.store.join({ groupId: env.groupId, token: env.token, displayName: '王五' });

    // A retry names the identity it already holds, which is what a real client does.
    const second = env.store.join({
      groupId: env.groupId,
      token: env.token,
      displayName: '王五',
      personId: first.member.personId,
    });

    assert.equal(second.member.personId, first.member.personId, 'the same person keeps the same id');
    assert.equal(second.rejoined, true, 'the response says it was a rejoin');

    const roster = rosterOf(env, { personId: second.member.personId, personKey: second.personKey });
    assert.equal(roster.length, 2, 'owner plus one 王五, not two');
    assert.equal(roster.filter((row) => row.displayName === '王五').length, 1);
  } finally {
    env.cleanup();
  }
});

test('a rejoin issues a working credential and retires the old one', () => {
  const env = harness();
  try {
    const first = env.store.join({ groupId: env.groupId, token: env.token, displayName: '王五' });
    const second = env.store.join({
      groupId: env.groupId,
      token: env.token,
      displayName: '王五',
      personId: first.member.personId,
    });

    // The caller needs a usable key, and a lost key is exactly why they would retry.
    assert.notEqual(second.personKey, first.personKey, 'the key is reissued');
    assert.doesNotThrow(
      () => rosterOf(env, { personId: second.member.personId, personKey: second.personKey }),
      'the new key works',
    );
    // The old key must not still work: two live credentials for one person is a worse problem than a lost one.
    assert.throws(
      () => rosterOf(env, { personId: first.member.personId, personKey: first.personKey }),
      (error) => error.code === 'not_member',
    );
  } finally {
    env.cleanup();
  }
});

test('a rejoin adds no second join line to the feed', () => {
  const env = harness();
  try {
    const first = env.store.join({ groupId: env.groupId, token: env.token, displayName: '王五' });
    const second = env.store.join({
      groupId: env.groupId,
      token: env.token,
      displayName: '王五',
      personId: first.member.personId,
    });

    const page = env.store.read({
      groupId: env.groupId,
      member: { personId: second.member.personId, personKey: second.personKey },
      sinceSeq: 0,
    });

    // A second 「加入了群」 for somebody already there reads as a bug, and it also inflates every watcher's unread
    // count for no reason.
    const joins = page.entries.filter((entry) => entry.kind === 'system' && entry.text.includes('王五'));
    assert.equal(joins.length, 1, 'exactly one join line for 王五');
  } finally {
    env.cleanup();
  }
});

test('a DIFFERENT person joining is still a new member', () => {
  const env = harness();
  try {
    const first = env.store.join({ groupId: env.groupId, token: env.token, displayName: '王五' });
    const second = env.store.join({ groupId: env.groupId, token: env.token, displayName: '赵六' });

    // The guard is per named identity, not per name: two colleagues called 王五 are two people.
    assert.notEqual(second.member.personId, first.member.personId);
    const roster = rosterOf(env, { personId: second.member.personId, personKey: second.personKey });
    assert.equal(roster.length, 3);
  } finally {
    env.cleanup();
  }
});
