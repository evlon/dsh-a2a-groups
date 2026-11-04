/**
 * Tests for mentions and delivery grading.
 *
 * The property being tested is not "a field is stored" but "the group stops being
 * noise". Three facts have to hold together:
 *
 *   1. a post records who it addressed, and the record survives a reload;
 *   2. a post that names you is graded differently from one that does not;
 *   3. an un-addressed post still DELIVERS (to the inbox, not the turn), because
 *      dropping it would be worse than interrupting with it.
 *
 * Resolution is tested too: a caller writes "@李四" far more naturally than "m-6e97cb19",
 * but resolving that must never guess when two members share a name — waking the wrong
 * person is worse than waking nobody.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGroupStore, MENTION_ALL, MAX_MENTIONS_PER_POST } from '../lib/core/groups.js';

/** A store in a throwaway directory, torn down after the test. */
function harness() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-a2a-mentions-'));
  const store = createGroupStore({
    home,
    logger: { info() {}, warn() {}, debug() {} },
    clock: () => Date.now(),
    config: { groups: { gatewayBase: 'http://gw/a2a', agentName: 'host' } },
  });
  return { home, store, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/**
 * A group with three members.
 *
 * Created through the public API because the point is the post path, not the fixtures:
 * owner, and two joiners with names that a human would type.
 */
function seed(store) {
  const created = store.create({ name: '发票重构', ownerDisplayName: '张工' });
  const groupId = created.group.groupId;
  const owner = { personId: created.group.owner.personId, personKey: created.ownerKey };

  const addMember = (displayName) => {
    const invite = store.invite({ groupId, ownerKey: created.ownerKey });
    const joined = store.join({ groupId, token: invite.token, displayName });
    return { personId: joined.member.personId, personKey: joined.personKey };
  };

  return { groupId, owner, li: addMember('李四'), wang: addMember('王五') };
}

test('a post with no mentions records none, so it reads as ordinary', () => {
  const env = harness();
  try {
    const { groupId, owner } = seed(env.store);
    const posted = env.store.post({ groupId, member: owner, text: '对账逻辑梳理完了' });
    assert.deepEqual(posted.mentions, []);
    const page = env.store.read({ groupId, member: owner, sinceSeq: 0 });
    const entry = page.entries.at(-1);
    assert.equal(entry.mentions, undefined, 'no mentions means the field is absent, not empty');
  } finally {
    env.cleanup();
  }
});

test('a member id is kept as a mention', () => {
  const env = harness();
  try {
    const { groupId, owner, li } = seed(env.store);
    const posted = env.store.post({
      groupId,
      member: owner,
      text: '看下这个 MR',
      mentions: [li.personId],
    });
    assert.deepEqual(posted.mentions, [li.personId]);
    const page = env.store.read({ groupId, member: owner, sinceSeq: 0 });
    assert.deepEqual(page.entries.at(-1).mentions, [li.personId]);
  } finally {
    env.cleanup();
  }
});

test('a display name resolves to the member, because that is what a caller types', () => {
  const env = harness();
  try {
    const { groupId, owner, li } = seed(env.store);
    const posted = env.store.post({ groupId, member: owner, text: '@李四 看下', mentions: ['李四'] });
    assert.deepEqual(posted.mentions, [li.personId]);
  } finally {
    env.cleanup();
  }
});

test('@all collapses any individual names into the sentinel', () => {
  const env = harness();
  try {
    const { groupId, owner, li } = seed(env.store);
    for (const spelling of [MENTION_ALL, 'all', '@所有人', '所有人']) {
      const posted = env.store.post({ groupId, member: owner, text: '明天上线', mentions: [spelling, li.personId] });
      assert.deepEqual(posted.mentions, [MENTION_ALL], `spelling ${spelling} must mean everyone`);
    }
  } finally {
    env.cleanup();
  }
});

test('an ambiguous display name is dropped rather than guessed', () => {
  const env = harness();
  try {
    const { groupId, owner, li } = seed(env.store);
    // Two members named the same: waking either one would be a guess.
    const invite = env.store.invite({ groupId, ownerKey: owner.personKey });
    env.store.join({ groupId, token: invite.token, displayName: '李四' });

    const posted = env.store.post({ groupId, member: owner, text: '@李四 看下', mentions: ['李四'] });
    assert.deepEqual(posted.mentions, [], 'an ambiguous name addresses nobody');
    void li;
  } finally {
    env.cleanup();
  }
});

test('an unknown name and a non-string entry are ignored, not fatal', () => {
  const env = harness();
  try {
    const { groupId, owner } = seed(env.store);
    const posted = env.store.post({
      groupId,
      member: owner,
      text: 'hi',
      mentions: ['张三不存在', 42, null, '', '  '],
    });
    assert.deepEqual(posted.mentions, []);
  } finally {
    env.cleanup();
  }
});

test('the mention list is bounded', () => {
  const env = harness();
  try {
    const { groupId, owner, li } = seed(env.store);
    const many = Array.from({ length: MAX_MENTIONS_PER_POST + 50 }, (_, index) => `nobody-${index}`);
    many.push(li.personId);
    const posted = env.store.post({ groupId, member: owner, text: 'hi', mentions: many });
    assert.ok(posted.mentions.length <= MAX_MENTIONS_PER_POST, `got ${posted.mentions.length}`);
  } finally {
    env.cleanup();
  }
});

test('mentions survive a reload, so a restart does not lose the addressing', () => {
  const env = harness();
  try {
    const { groupId, owner, li } = seed(env.store);
    env.store.post({ groupId, member: owner, text: '@李四 看下', mentions: [li.personId] });
    env.store.flush();

    const reloaded = createGroupStore({
      home: env.home,
      logger: { info() {}, warn() {}, debug() {} },
      clock: () => Date.now(),
      config: { groups: { gatewayBase: 'http://gw/a2a', agentName: 'host' } },
    });
    const page = reloaded.read({ groupId, member: owner, sinceSeq: 0 });
    const entry = page.entries.at(-1);
    assert.deepEqual(entry.mentions, [li.personId]);
  } finally {
    env.cleanup();
  }
});

test('a system entry carries no mentions', () => {
  const env = harness();
  try {
    const { groupId, owner } = seed(env.store);
    const page = env.store.read({ groupId, member: owner, sinceSeq: 0 });
    const system = page.entries.find((entry) => entry.kind === 'system');
    assert.ok(system, 'the group should have system entries from create/join');
    assert.equal(system.mentions, undefined);
  } finally {
    env.cleanup();
  }
});
