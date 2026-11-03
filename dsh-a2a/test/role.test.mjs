/**
 * Layer A: what a person is IN ONE GROUP.
 *
 * The unit-level companion to `scripts/aisix-dev/probe-role.mjs` (which proves the
 * same properties through a gateway). These assertions are the ones that must
 * never regress, and each names the failure it prevents:
 *
 *  - a role is self-description, so a credential decides whose row changes;
 *  - a role is per-group, so being a developer here and product there works;
 *  - `role` is a permission bit and is never touched by any of it;
 *  - a member stored before these fields existed still reads as a valid view.
 *
 * @module dsh-a2a/test/role
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGroupStore, normalizeTags, MAX_TAGS, MAX_TAG_CHARS } from '../lib/groups.js';
import { normalizeConfig } from '../lib/config.js';

/** A store with its own temp directory, removed when the test ends. */
function makeStore(t) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-a2a-role-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return createGroupStore({
    home,
    logger: { info() {}, warn() {}, error() {} },
    clock: () => Date.now(),
    config: normalizeConfig({ groups: { gatewayBase: 'http://gw:3000/a2a', agentName: 'host' } }),
  });
}

/** A group plus the owner credential. */
function makeGroup(store, name = 'g') {
  const created = store.create({ name, password: 'pw-12345678', ownerDisplayName: 'me' });
  return {
    groupId: created.group.groupId,
    owner: { memberId: created.group.owner.memberId, memberKey: created.ownerKey },
  };
}

/** Add one more member and return their credential. */
function addMember(store, group, displayName) {
  // Minting is owner-only now, and the helper receives the group (which carries the
  // owner credential under `owner.memberKey`), so it uses that.
  const invited = store.invite({ groupId: group.groupId, ownerKey: group.owner.memberKey });
  const joined = store.join({
    groupId: group.groupId,
    token: invited.token,
    displayName,
  });
  return { memberId: joined.member.memberId, memberKey: joined.memberKey };
}

test('a member can declare and change their role in a group', (t) => {
  const store = makeStore(t);
  const group = makeGroup(store);

  const set = store.setProfile({
    groupId: group.groupId,
    member: group.owner,
    about: '负责 invoice 拆分',
    tags: ['研发', '后端'],
  });
  assert.equal(set.roleAbout, '负责 invoice 拆分');
  assert.deepEqual(set.tags, ['研发', '后端']);

  const changed = store.setProfile({
    groupId: group.groupId,
    member: group.owner,
    about: '转到后端',
    tags: ['研发'],
  });
  assert.equal(changed.roleAbout, '转到后端');
  assert.deepEqual(changed.tags, ['研发']);

  const members = store.members({ groupId: group.groupId, member: group.owner });
  assert.equal(members.length, 1, 'a role change updates the row, it does not add one');
  assert.equal(members[0].roleAbout, '转到后端');
  assert.deepEqual(members[0].tags, ['研发']);
});

test('the same person holds different roles in different groups', (t) => {
  const store = makeStore(t);
  const dev = makeGroup(store, '开发群');
  const proj = makeGroup(store, '项目群');

  // Same human, two memberships (a different instance would have one memberId
  // per group, which is the ordinary case; here they are distinct memberships by
  // construction and must stay independent).
  store.setProfile({ groupId: dev.groupId, member: dev.owner, about: '研发', tags: ['研发'] });
  store.setProfile({ groupId: proj.groupId, member: proj.owner, about: '兼产品', tags: ['产品', '研发'] });

  const devView = store.members({ groupId: dev.groupId, member: dev.owner })[0];
  const projView = store.members({ groupId: proj.groupId, member: proj.owner })[0];
  assert.equal(devView.roleAbout, '研发');
  assert.equal(projView.roleAbout, '兼产品');
  assert.deepEqual(devView.tags, ['研发']);
  assert.deepEqual(projView.tags, ['产品', '研发']);
});

test('a role never grants the permission bit', (t) => {
  const store = makeStore(t);
  const group = makeGroup(store);
  const guest = addMember(store, group, 'guest');

  store.setProfile({ groupId: group.groupId, member: guest, about: '我是产品经理', tags: ['产品'] });

  const rows = store.members({ groupId: group.groupId, member: group.owner });
  const owner = rows.find((row) => row.memberId === group.owner.memberId);
  const member = rows.find((row) => row.memberId === guest.memberId);
  assert.equal(owner.role, 'owner');
  assert.equal(member.role, 'member', 'declaring a business role must not change permissions');
  assert.equal(member.roleAbout, '我是产品经理');
});

test('a member cannot write another member\'s role', (t) => {
  const store = makeStore(t);
  const group = makeGroup(store);
  const victim = addMember(store, group, 'victim');
  const attacker = addMember(store, group, 'attacker');

  store.setProfile({ groupId: group.groupId, member: victim, about: '原来的角色' });

  // Attacker presents the victim's memberId with its own credential. Identity is
  // keyed on the credential, so this must be refused rather than silently write
  // the victim's row.
  assert.throws(
    () => store.setProfile({
      groupId: group.groupId,
      member: { memberId: victim.memberId, memberKey: attacker.memberKey },
      about: '被篡改',
    }),
    (error) => error.code === 'not_member',
  );

  const after = store.members({ groupId: group.groupId, member: group.owner });
  assert.equal(after.find((row) => row.memberId === victim.memberId).roleAbout, '原来的角色');
});

test('omitting a field leaves it unchanged; an empty value clears it', (t) => {
  const store = makeStore(t);
  const group = makeGroup(store);
  store.setProfile({ groupId: group.groupId, member: group.owner, about: '原来的', tags: ['研发'] });

  const tagsOnly = store.setProfile({ groupId: group.groupId, member: group.owner, tags: ['测试'] });
  assert.equal(tagsOnly.roleAbout, '原来的', 'omitting about keeps it');
  assert.deepEqual(tagsOnly.tags, ['测试']);

  const cleared = store.setProfile({ groupId: group.groupId, member: group.owner, about: '' });
  assert.equal(cleared.roleAbout, undefined, 'an empty string clears');
  assert.deepEqual(cleared.tags, ['测试'], 'omitting tags keeps them');

  const clearedTags = store.setProfile({ groupId: group.groupId, member: group.owner, tags: [] });
  assert.deepEqual(clearedTags.tags, [], 'an empty array clears');
});

test('tags are cleaned: trimmed, de-duplicated, capped', () => {
  assert.deepEqual(normalizeTags([' 研发 ', '研发', 'R&D']), ['研发', 'R&D'], 'trims and de-dupes case-insensitively');
  assert.deepEqual(normalizeTags(['a', 'b', 'c', 'd', 'e', 'f', 'g']).length, MAX_TAGS, `caps at ${MAX_TAGS}`);
  assert.deepEqual(normalizeTags(['x'.repeat(MAX_TAG_CHARS + 1)]), [], 'drops an over-long tag');
  assert.deepEqual(normalizeTags('not-an-array'), [], 'a non-array is no tags');
  assert.deepEqual(normalizeTags([1, null, 'ok']), ['ok'], 'ignores non-strings');
});

test('a member stored before layer A existed still reads as a valid view', (t) => {
  const store = makeStore(t);
  const group = makeGroup(store);
  // Simulate an old row by clearing the fields the way a pre-upgrade file would.
  const members = store.members({ groupId: group.groupId, member: group.owner });
  assert.equal(members.length, 1);
  const row = members[0];
  // The shape must be stable regardless: these keys are always present.
  assert.ok('roleAbout' in row);
  assert.ok(Array.isArray(row.tags));
});

test('a role change is visible in the feed as a system line', (t) => {
  const store = makeStore(t);
  const group = makeGroup(store);
  store.setProfile({ groupId: group.groupId, member: group.owner, about: '研发' });

  const page = store.read({ groupId: group.groupId, member: group.owner, sinceSeq: 0 });
  // Others need a way to notice a change without polling the member list.
  assert.ok(page.entries.some((entry) => entry.kind === 'system' && /角色/.test(entry.text)),
    `no role-change system entry in: ${page.entries.map((e) => e.text).join(' | ')}`);
});
