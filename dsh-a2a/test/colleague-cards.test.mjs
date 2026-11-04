/**
 * Tests for the colleague-card aggregation.
 *
 * A card answers "who is this and what do they do", aggregated from the rosters a Session
 * already fetched. Two properties matter and are easy to get wrong:
 *
 *   1. one person appears ONCE even when they are in several of my groups, with the union of
 *      what they declared — because being a developer in one group and the product owner in
 *      another is the normal case, not an inconsistency;
 *   2. nothing is invented. An empty tag list stays empty; a person who never declared a role
 *      gets no headline rather than the word "member".
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { aggregateColleagueCards } from '../lib/core/colleague-cards.js';

test('one person in two groups becomes one card with both groups', () => {
  const cards = aggregateColleagueCards([
    { groupId: 'g-1', groupName: '发票重构', members: [{ personId: 'm-1', displayName: '张工', tags: ['研发'] }] },
    { groupId: 'g-2', groupName: '合同评审', members: [{ personId: 'm-1', displayName: '张工', tags: ['产品'] }] },
  ]);
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0].groups.sort(), ['发票重构', '合同评审']);
  assert.deepEqual(cards[0].tags.sort(), ['产品', '研发']);
});

test('the headline is the first role they declared, not a placeholder', () => {
  const cards = aggregateColleagueCards([
    { groupId: 'g-1', groupName: 'A', members: [{ personId: 'm-1', displayName: '张工', roleAbout: '兼产品' }] },
  ]);
  assert.equal(cards[0].headline, '兼产品');
});

test('a person who declared no role gets no headline at all', () => {
  const cards = aggregateColleagueCards([
    { groupId: 'g-1', groupName: 'A', members: [{ personId: 'm-1', displayName: '张工' }] },
  ]);
  // Not "member", not "成员": an absent self-description must stay absent, or every card
  // would look like it knows something it does not.
  assert.equal(cards[0].headline, '');
  assert.deepEqual(cards[0].tags, []);
});

test('the same tag in several groups is deduplicated', () => {
  const cards = aggregateColleagueCards([
    { groupId: 'g-1', groupName: 'A', members: [{ personId: 'm-1', displayName: '张工', tags: ['研发'] }] },
    { groupId: 'g-2', groupName: 'B', members: [{ personId: 'm-1', displayName: '张工', tags: ['研发'] }] },
  ]);
  assert.deepEqual(cards[0].tags, ['研发']);
});

test('people are ordered by how many of my groups they are in', () => {
  const cards = aggregateColleagueCards([
    {
      groupId: 'g-1',
      groupName: 'A',
      members: [
        { personId: 'm-1', displayName: '只在一个群' },
        { personId: 'm-2', displayName: '在两个群' },
      ],
    },
    { groupId: 'g-2', groupName: 'B', members: [{ personId: 'm-2', displayName: '在两个群' }] },
  ]);
  assert.equal(cards[0].name, '在两个群', 'the more connected person comes first');
});

test('online is true when any roster saw the person recently', () => {
  const cards = aggregateColleagueCards([
    { groupId: 'g-1', groupName: 'A', members: [{ personId: 'm-1', displayName: '张工', online: false }] },
    { groupId: 'g-2', groupName: 'B', members: [{ personId: 'm-1', displayName: '张工', online: true }] },
  ]);
  assert.equal(cards[0].online, true);
});

test('a roster without member ids falls back to the display name as the key', () => {
  const cards = aggregateColleagueCards([
    { groupId: 'g-1', groupName: 'A', members: [{ displayName: '张工' }] },
    { groupId: 'g-2', groupName: 'B', members: [{ displayName: '张工' }] },
  ]);
  assert.equal(cards.length, 1, 'the same name must not become two cards');
  assert.equal(cards[0].personId, '');
});

test('a record with no roster contributes no cards', () => {
  assert.deepEqual(aggregateColleagueCards([{ groupId: 'g-1', groupName: 'A' }]), []);
  assert.deepEqual(aggregateColleagueCards([{ groupId: 'g-1', groupName: 'A', members: [] }]), []);
});

test('a malformed roster row is skipped rather than becoming a nameless card', () => {
  const cards = aggregateColleagueCards([
    { groupId: 'g-1', groupName: 'A', members: [null, 42, { personId: 'm-1' }, { displayName: '张工' }] },
  ]);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].name, '张工');
});

test('a group with no name uses its id, so a card never claims a blank group', () => {
  const cards = aggregateColleagueCards([
    { groupId: 'g-1', members: [{ personId: 'm-1', displayName: '张工' }] },
  ]);
  assert.deepEqual(cards[0].groups, ['g-1']);
});

// ---------------------------------------------------------------------------
// my own card

test('my card is first, even when somebody else is in more groups', () => {
  // The question "what do others see when they look at me" comes before "who else is around",
  // and mine is the only card the reader can change.
  const cards = aggregateColleagueCards([
    {
      groupId: 'g-1',
      groupName: 'A',
      personId: 'm-me',
      members: [
        { personId: 'm-other', displayName: '在三个群的人' },
        { personId: 'm-me', displayName: '我' },
      ],
    },
    { groupId: 'g-2', groupName: 'B', personId: 'm-me', members: [{ personId: 'm-other', displayName: '在三个群的人' }] },
    { groupId: 'g-3', groupName: 'C', personId: 'm-me', members: [{ personId: 'm-other', displayName: '在三个群的人' }] },
  ]);
  assert.equal(cards[0].isSelf, true, 'my card must come first');
  assert.equal(cards[0].name, '我');
});

test('exactly one card is mine, identified by member id rather than name', () => {
  // Two people can share a display name; matching on it would mark a stranger's card as mine
  // and offer an edit that changes the wrong profile.
  const cards = aggregateColleagueCards([
    {
      groupId: 'g-1',
      groupName: 'A',
      personId: 'm-me',
      members: [
        { personId: 'm-me', displayName: '张工' },
        { personId: 'm-other', displayName: '张工' },
      ],
    },
  ]);
  assert.equal(cards.filter((card) => card.isSelf).length, 1);
  assert.equal(cards.find((card) => card.isSelf).personId, 'm-me');
});

test('nobody is marked as me when the ledger names no member id', () => {
  const cards = aggregateColleagueCards([
    { groupId: 'g-1', groupName: 'A', members: [{ personId: 'm-1', displayName: '张工' }] },
  ]);
  assert.equal(cards.some((card) => card.isSelf), false, 'an unknown self must not be guessed');
});

test('a record without a personId does not mark the first roster row as mine', () => {
  // The dangerous version of this feature: treating "the only row" or "the first row" as self
  // would put an edit affordance on a stranger's card.
  const cards = aggregateColleagueCards([
    { groupId: 'g-1', groupName: 'A', members: [{ personId: 'm-1', displayName: '张工' }] },
    { groupId: 'g-2', groupName: 'B', members: [{ personId: 'm-2', displayName: '李四' }] },
  ]);
  assert.equal(cards.every((card) => card.isSelf !== true), true);
});