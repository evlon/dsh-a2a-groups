/**
 * Layer B: the emergent identity in the agent card.
 *
 * The property under test is the one that makes this design worth having: the
 * identity is DERIVED, so it cannot go stale. Each test names the failure it
 * prevents — a card that says "owner", a card that leaks a credential, a card that
 * breaks when the aggregation has nothing to say.
 *
 * @module dsh-a2a/test/profile
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildProfile, profileField } from '../lib/dsh/profile.js';
import { buildCard } from '../lib/core/card.js';
import { normalizeConfig } from '../lib/core/config.js';

/** A fake group store answering `has` and `memberView`. */
function fakeStore(views) {
  return {
    has: (groupId) => Object.hasOwn(views, groupId),
    memberView: ({ groupId, memberId }) => {
      const view = views[groupId];
      if (view === undefined || view.memberId !== memberId) return undefined;
      return view;
    },
  };
}

/** A fake membership ledger. */
function fakeIdentities(records) {
  return { list: () => records };
}

const DEV_GROUP = {
  groupId: 'g-dev',
  memberId: 'm-1',
  local: true,
  groupName: '开发群',
  role: 'owner',
};

const PROJ_GROUP = {
  groupId: 'g-proj',
  memberId: 'm-2',
  local: true,
  groupName: '项目群',
  role: 'owner',
};

test('the profile is aggregated from the groups this instance belongs to', () => {
  const store = fakeStore({
    'g-dev': { memberId: 'm-1', displayName: '张工', roleAbout: '负责后端', tags: ['研发'], role: 'owner' },
    'g-proj': { memberId: 'm-2', displayName: '张工', roleAbout: '兼产品', tags: ['产品', '研发'], role: 'owner' },
  });
  const profile = buildProfile({ identities: fakeIdentities([DEV_GROUP, PROJ_GROUP]), store, config: {} });

  assert.equal(profile.groups.length, 2);
  assert.equal(profile.name, '张工', 'the most common real display name wins');
  assert.deepEqual(profile.tags, ['研发', '产品'], 'tags ranked by how many groups declared them');
  assert.equal(profile.groups.find((group) => group.groupId === 'g-dev').roleAbout, '负责后端');
  assert.equal(profile.groups.find((group) => group.groupId === 'g-proj').roleAbout, '兼产品');
});

test('a placeholder display name never becomes the identity', () => {
  // `owner` is what the store fills in when a caller names nobody. Putting it on
  // the card tells a peer nothing and looks like a bug.
  const store = fakeStore({
    'g-dev': { memberId: 'm-1', displayName: 'owner', roleAbout: '', tags: [], role: 'owner' },
  });
  const profile = buildProfile({ identities: fakeIdentities([DEV_GROUP]), store, config: {} });
  assert.equal(profile.name, undefined, 'owner is skipped rather than used');

  const withReal = fakeStore({
    'g-dev': { memberId: 'm-1', displayName: 'owner', roleAbout: '', tags: [], role: 'owner' },
    'g-proj': { memberId: 'm-2', displayName: '张工', roleAbout: '', tags: [], role: 'owner' },
  });
  const profile2 = buildProfile({ identities: fakeIdentities([DEV_GROUP, PROJ_GROUP]), store: withReal, config: {} });
  assert.equal(profile2.name, '张工', 'a real name outranks a placeholder even when less frequent');
});

test('an explicit config name wins over the derived one', () => {
  const store = fakeStore({
    'g-dev': { memberId: 'm-1', displayName: '张工', roleAbout: '', tags: [], role: 'owner' },
  });
  const config = normalizeConfig({ agent: { name: '发票重构-研发', description: '负责 invoice 服务' } });
  const profile = buildProfile({ identities: fakeIdentities([DEV_GROUP]), store, config });
  assert.equal(profile.name, '发票重构-研发');
  assert.equal(profile.headline, '负责 invoice 服务');
});

test('the headline names the busiest roles, and says so plainly when none are declared', () => {
  const withTags = fakeStore({
    'g-dev': { memberId: 'm-1', displayName: '张工', roleAbout: '', tags: ['研发', '后端'], role: 'owner' },
    'g-proj': { memberId: 'm-2', displayName: '张工', roleAbout: '', tags: ['产品', '研发'], role: 'owner' },
  });
  const one = buildProfile({ identities: fakeIdentities([DEV_GROUP, PROJ_GROUP]), store: withTags, config: {} });
  assert.match(one.headline, /2 个协作群/);
  assert.match(one.headline, /研发/);

  const noTags = fakeStore({
    'g-dev': { memberId: 'm-1', displayName: '张工', roleAbout: '', tags: [], role: 'owner' },
  });
  const two = buildProfile({ identities: fakeIdentities([DEV_GROUP]), store: noTags, config: {} });
  assert.match(two.headline, /尚未声明角色/, 'says so instead of emitting a blank field');
});

test('an empty ledger yields no profile rather than a broken one', () => {
  const profile = buildProfile({ identities: fakeIdentities([]), store: fakeStore({}), config: {} });
  assert.deepEqual(profile.groups, []);
  assert.equal(profile.headline, undefined);
  assert.equal(profileField(profile), undefined, 'no extension when there is nothing to say');
});

test('a joined group contributes its name but no invented role', () => {
  // Only the host knows what was declared there; the ledger records that the
  // membership exists. Reading the host's member list would put a network call
  // inside card rendering, so the role is left empty instead of guessed.
  const remote = { groupId: 'g-remote', memberId: 'm-9', local: false, groupName: '远端群', role: 'member' };
  const profile = buildProfile({ identities: fakeIdentities([remote]), store: fakeStore({}), config: {} });
  assert.equal(profile.groups.length, 1);
  assert.equal(profile.groups[0].groupName, '远端群');
  assert.equal(profile.groups[0].roleAbout, '', 'no invented role');
  assert.deepEqual(profile.groups[0].tags, []);
});

test('the card carries the profile as a vendor extension and never a credential', () => {
  const profile = {
    name: '张工',
    headline: '在 2 个协作群里，主要角色：研发、产品',
    tags: ['研发', '产品'],
    groups: [
      { groupId: 'g-dev', groupName: '开发群', roleAbout: '负责后端', tags: ['研发'], permission: 'owner', local: true },
    ],
  };
  const card = buildCard({ config: normalizeConfig({}), skills: { list: () => [] }, url: 'http://x/a2a', profile });

  assert.equal(card.name, '张工', 'the derived name reaches the card');
  assert.equal(card.description, profile.headline, 'the derived headline reaches the card');
  assert.ok(card['x-agent-profiles'] !== undefined);
  assert.equal(card['x-agent-profiles'].groups.length, 1);
  assert.deepEqual(card['x-agent-profiles'].tags, ['研发', '产品']);

  const serialized = JSON.stringify(card);
  for (const forbidden of ['memberKey', 'keyHash', 'passwordHash', 'tokenHash']) {
    assert.ok(!serialized.includes(forbidden), `the card must not contain ${forbidden}`);
  }
});

test('a card with no profile still renders its defaults', () => {
  const card = buildCard({ config: normalizeConfig({}), skills: { list: () => [] }, url: 'http://x/a2a' });
  assert.equal(card.name, 'dsh-a2a');
  assert.match(card.description, /Exposes a DSH Session/);
  assert.equal(card['x-agent-profiles'], undefined, 'no extension when there is no profile');
});

test('a profile provider that throws degrades to no extension, not a broken card', () => {
  // Exercised through `createServer`'s `readProfile`, but the contract is worth
  // pinning here too: `buildProfile` must not throw for a store that misbehaves.
  const hostile = {
    list: () => [{ groupId: 'g-1', memberId: 'm-1', local: true }],
    has: () => true,
    memberView: () => {
      throw new Error('store exploded');
    },
  };
  const profile = buildProfile({ identities: hostile, store: hostile, config: {} });
  assert.equal(profile.groups.length, 1, 'the group is still listed');
  assert.equal(profile.groups[0].roleAbout, '', 'the failed lookup degrades to no role');
});
