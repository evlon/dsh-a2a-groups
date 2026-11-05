/**
 * Every field `publicEntry` publishes must survive every mapper on the way to a reader.
 *
 * THE PATTERN THIS EXISTS FOR
 *
 * Five times now, a field has been written to the feed, survived the store, and then silently disappeared in a
 * whitelist mapper — `publicEntry`, then the `group/read` skill, then the tool runtime, then the panel normaliser.
 * Each time the symptom looked different, and each time the cause was the same sentence: an object rebuilt
 * field-by-field, with the new field not added to the list.
 *
 * These tests are deliberately structural rather than behavioural. A behavioural test would have to know which field
 * to check, and the whole problem is that nobody remembers to add one.
 *
 * @module dsh-a2a/test/feed-field-parity
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { readFileSync } from 'node:fs';

const GROUPS = readFileSync('lib/core/groups.js', 'utf8');
const SKILLS = readFileSync('lib/core/skills-group.js', 'utf8');
const RUNTIME = readFileSync('lib/shared/tool-runtime.js', 'utf8');

/** The body of `function publicEntry(...)`, by brace matching. */
function publicEntryBody() {
  const start = GROUPS.indexOf('function publicEntry(');
  assert.ok(start > -1, 'publicEntry must exist');
  const open = GROUPS.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < GROUPS.length; index += 1) {
    if (GROUPS[index] === '{') depth += 1;
    else if (GROUPS[index] === '}') {
      depth -= 1;
      if (depth === 0) return GROUPS.slice(open, index + 1);
    }
  }
  throw new Error('publicEntry body did not close');
}

/** Field names `publicEntry` can put on a view. */
function publishedFields() {
  const body = publicEntryBody();
  const fields = new Set();
  for (const match of body.matchAll(/view\.([A-Za-z][A-Za-z0-9]*)\s*=/gu)) fields.add(match[1]);
  for (const match of body.matchAll(/^\s{4,}([A-Za-z][A-Za-z0-9]*):/gmu)) fields.add(match[1]);
  return fields;
}

/** The fields the `group/read` skill copies out of each entry. */
function skillReadFields() {
  const at = SKILLS.indexOf("id: 'group/read'");
  assert.ok(at > -1);
  const body = SKILLS.slice(at, SKILLS.indexOf("id: 'group/subscribe'", at));
  const fields = new Set();
  for (const match of body.matchAll(/^\s{16}([A-Za-z][A-Za-z0-9]*):/gmu)) fields.add(match[1]);
  return fields;
}

test('the envelope fields are published', () => {
  const fields = publishedFields();
  // These are what a reader needs to render one entry or follow a thread.
  for (const required of ['seq', 'from', 'text', 'kind', 'at', 'msgId']) {
    assert.ok(fields.has(required), `publicEntry must publish ${required}`);
  }
});

test('the thread and addressability fields are published', () => {
  const fields = publishedFields();
  // `mentions` decides who was woken; `replyTo` makes a conversation followable. Both have been dropped before.
  assert.ok(fields.has('mentions'), 'a reader must be able to see who an entry addressed');
  assert.ok(fields.has('replyTo'), 'a reader must be able to see what an entry answers');
});

test('the read skill forwards every field publicEntry publishes', () => {
  const published = publishedFields();
  const forwarded = skillReadFields();

  // The skill rebuilds each entry, so anything it omits is invisible to a peer even though the store returned it.
  // `payload` is intentionally excluded (it is large and only some callers need it), so it is not asserted here.
  const optional = new Set(['payload', 'atIso']);
  for (const field of published) {
    if (optional.has(field)) continue;
    assert.ok(
      forwarded.has(field),
      `group/read must forward \`${field}\`: publicEntry publishes it, so dropping it here hides it from every peer`,
    );
  }
});

test('the tool runtime forwards the thread fields too', () => {
  // The member-side tool has the same shape of mapper as the host-side skill, and it dropped `mentions` once already
  // on the LOCAL branch while the remote branch sent it — so a hosted group never woke anybody.
  const at = RUNTIME.indexOf("'a2a_group_post': async function a2a_group_post");
  assert.ok(at > -1);
  const body = RUNTIME.slice(at, RUNTIME.indexOf("'a2a_group_stream'", at) > -1 ? RUNTIME.indexOf("'a2a_group_stream'", at) : at + 3000);
  assert.match(body, /mentions: args\.mentions/u, 'the local branch must forward mentions');
  assert.match(body, /replyTo: args\.replyTo/u, 'and the reply target');
});

test('posting a reply returns the answered seq, not the person', () => {
  const at = GROUPS.indexOf('function post(input = {})');
  assert.ok(at > -1);
  const body = GROUPS.slice(at, GROUPS.indexOf('function ', GROUPS.indexOf('return {', at)) > -1 ? GROUPS.indexOf('function ', GROUPS.indexOf('return {', at)) : at + 4000);
  // A caller reporting "replied to #42" needs the number; the recipient is already in `mentions`.
  assert.match(body, /replyTo: replyToEntry === undefined \? undefined : replyToEntry\.seq/u);
});
