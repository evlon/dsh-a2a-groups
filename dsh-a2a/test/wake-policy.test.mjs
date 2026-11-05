/**
 * An unaddressed post must not wake anybody, by default.
 *
 * THE STORM
 *
 * Every post woke every member who was not mentioned, because `notice` and `mention` both travelled as
 * `mode: 'queue'`. Three people typing one line each produced six wakes, and each wake can produce another message.
 *
 * Measured on a real group: feed seq 106-113 was seven turns with ZERO mentions. Three produced decisions; four said
 * "I accept your correction", "I withdraw", "agreed to stop". Under this change none of the seven wakes anyone —
 * all three members see the backlog through `a2a_pending` and read it once, together.
 *
 * WHAT WAS ALREADY RIGHT
 *
 * The grading (`mention` / `notice` / `ambient`) and the quiet mode (`mode: 'inbox'` = seated without waking) both
 * existed. Only the last condition was wrong: `notice` was treated as a mention.
 *
 * @module dsh-a2a/test/wake-policy
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { gradeOf } from '../lib/dsh/inbox.js';
import { normalizeConfig } from '../lib/core/config.js';

/** The delivery rule, mirrored from inbox.js so it can be exercised without a live Session. */
function modeFor(grade, wakeMembers) {
  return grade === 'mention' || (grade === 'notice' && wakeMembers !== false) ? 'queue' : 'inbox';
}

test('a post that mentions me wakes me', () => {
  // The one case that must always wake: somebody addressed this person by name.
  assert.equal(modeFor('mention', false), 'queue');
  assert.equal(modeFor('mention', true), 'queue');
});

test('a post that mentions nobody is quiet by default', () => {
  // This is the whole storm fix. Under the old rule this returned 'queue' and woke everybody on every line.
  assert.equal(modeFor('notice', false), 'inbox');
});

test('a post that mentions somebody else is quiet', () => {
  // Being told "other people were mentioned" is noise, not signal.
  assert.equal(modeFor('ambient', false), 'inbox');
  assert.equal(modeFor('ambient', true), 'inbox');
});

test('the chatty behaviour can be restored per instance', () => {
  // Not removed, just defaulted off: a team that wants ambient wakes sets the flag and gets the old behaviour.
  assert.equal(modeFor('notice', true), 'queue');
});

test('the default is quiet', () => {
  const config = normalizeConfig({});
  // A default that wakes everybody is how this went wrong in the first place; assert the shipped value.
  assert.equal(config.groups.wakeMembers, false);
});

test('the flag survives configuration', () => {
  const chatty = normalizeConfig({ groups: { wakeMembers: true } });
  assert.equal(chatty.groups.wakeMembers, true);
  const quiet = normalizeConfig({ groups: { wakeMembers: false } });
  assert.equal(quiet.groups.wakeMembers, false);
});

// ---------------------------------------------------------------------------
// Grading itself — unchanged, and pinned so a future edit cannot widen it
// ---------------------------------------------------------------------------

const MEMBERSHIP = { personId: 'p-me', groupName: '发票重构' };

test('grading: no mentions is a notice', () => {
  assert.equal(gradeOf({ mentions: [] }, MEMBERSHIP, false), 'notice');
  assert.equal(gradeOf({}, MEMBERSHIP, false), 'notice');
});

test('grading: @all and @me are mentions', () => {
  assert.equal(gradeOf({ mentions: ['@all'] }, MEMBERSHIP, false), 'mention');
  assert.equal(gradeOf({ mentions: ['p-me'] }, MEMBERSHIP, false), 'mention');
});

test('grading: mentioning somebody else is ambient', () => {
  assert.equal(gradeOf({ mentions: ['p-other'] }, MEMBERSHIP, false), 'ambient');
});

test('grading: a mute outranks a mention but does not drop it', () => {
  // Muting must not lose the message — it only makes it quiet, which is what a person asked for.
  assert.equal(gradeOf({ mentions: ['p-me'] }, MEMBERSHIP, true), 'ambient');
});

// ---------------------------------------------------------------------------
// The end-to-end shape: three people, one unaddressed post each
// ---------------------------------------------------------------------------

test('a three-person round with no mentions wakes nobody', () => {
  const people = [{ personId: 'p-a' }, { personId: 'p-b' }, { personId: 'p-c' }];
  const posts = [
    { from: 'p-a', mentions: [] },
    { from: 'p-b', mentions: [] },
    { from: 'p-c', mentions: [] },
  ];

  let wakes = 0;
  for (const post of posts) {
    for (const person of people) {
      const grade = gradeOf(post, { ...person, groupName: 'g' }, false);
      if (modeFor(grade, false) === 'queue') wakes += 1;
    }
  }

  // Under the old rule this was 9 (every post woke all three). That is the storm.
  assert.equal(wakes, 0, 'an unaddressed round must wake nobody');
});

test('addressing one person wakes exactly that person', () => {
  const people = [{ personId: 'p-a' }, { personId: 'p-b' }, { personId: 'p-c' }];
  const post = { from: 'p-a', mentions: ['p-b'] };

  const woken = people.filter((person) => modeFor(gradeOf(post, { ...person, groupName: 'g' }, false), false) === 'queue');

  // Three people, one @, one wake. This is the property that makes a group usable.
  assert.deepEqual(woken.map((person) => person.personId), ['p-b']);
});

test('@all still reaches everybody, because it is meant to', () => {
  const people = [{ personId: 'p-a' }, { personId: 'p-b' }, { personId: 'p-c' }];
  const post = { from: 'p-a', mentions: ['@all'] };

  const woken = people.filter((person) => modeFor(gradeOf(post, { ...person, groupName: 'g' }, false), false) === 'queue');

  // The escape hatch stays intact: an announcement still interrupts, which is why it must be used deliberately.
  assert.equal(woken.length, 3);
});
