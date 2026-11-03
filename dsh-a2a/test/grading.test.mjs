/**
 * Tests for delivery grading: the rule that decides whether a post interrupts someone.
 *
 * This is the highest-consequence policy in the plugin. Too eager and the group gets
 * muted — after which the one message that mattered is lost. Too shy and nobody answers.
 * So each grade is pinned individually, including the two edge cases that are easy to
 * get backwards:
 *
 *   - a muted group must still DELIVER a mention (quietly), not drop it;
 *   - a post that mentions somebody ELSE must not wake a third party.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { gradeOf } from '../lib/inbox.js';

const membership = { sessionId: 's-1', groupId: 'g-1', memberId: 'm-me' };
const other = 'm-other';

/** Build a feed entry with the given mentions. */
function post(mentions) {
  return mentions === undefined
    ? { seq: 1, from: { memberId: other, displayName: '张工' }, text: 'hi' }
    : { seq: 1, mentions, from: { memberId: other, displayName: '张工' }, text: 'hi' };
}

test('an ordinary post is a notice: it wakes, but it is not "for you"', () => {
  assert.equal(gradeOf(post(undefined), membership, false), 'notice');
});

test('a post naming me is a mention', () => {
  assert.equal(gradeOf(post(['m-me']), membership, false), 'mention');
});

test('a post to @all is a mention for every member', () => {
  assert.equal(gradeOf(post(['@all']), membership, false), 'mention');
});

test('a post naming somebody else is ambient: it must not wake me', () => {
  // The easy mistake is to treat "this post has mentions" as "this post mentions me".
  assert.equal(gradeOf(post([other]), membership, false), 'ambient');
});

test('muting outranks everything, including a mention', () => {
  // Muting is an explicit instruction from the person. A mention still arrives, but as
  // ambient: it lands in the inbox and does not start a turn.
  assert.equal(gradeOf(post(['m-me']), membership, true), 'ambient');
  assert.equal(gradeOf(post(['@all']), membership, true), 'ambient');
  assert.equal(gradeOf(post(undefined), membership, true), 'ambient');
});

test('an empty mention list falls back to notice, not mention', () => {
  // A caller that passed `mentions: []` addressed nobody; that is an ordinary post.
  assert.equal(gradeOf(post([]), membership, false), 'notice');
});

test('a malformed mentions field is treated as no mentions', () => {
  // A hand-written or older feed entry may carry something that is not an array.
  assert.equal(gradeOf({ seq: 1, mentions: 'm-me' }, membership, false), 'notice');
  assert.equal(gradeOf({ seq: 1, mentions: null }, membership, false), 'notice');
});

test('the grade does not depend on who authored the post', () => {
  // A member mentioning themselves is still a mention; the rule is about the addressee.
  const selfPost = { seq: 1, mentions: ['m-me'], from: { memberId: 'm-me', displayName: 'me' } };
  assert.equal(gradeOf(selfPost, membership, false), 'mention');
});
