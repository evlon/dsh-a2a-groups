/**
 * The channel directory: the one credential-free read in the store.
 *
 * Because it needs no membership, it is also the read most able to leak. Every
 * test below pins one boundary:
 *
 *  - it says a group EXISTS (name, topic, counts) and nothing about WHO or WHAT
 *    was said;
 *  - an `unlisted` group is absent entirely, not present-but-flagged — a flag
 *    would still confirm that a group with that id exists;
 *  - paging and filtering are bounded, so one call cannot dump the whole host.
 *
 * @module dsh-a2a/test/directory
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createGroupStore,
  DIRECTORY_DEFAULT_LIMIT,
  DIRECTORY_MAX_LIMIT,
} from '../lib/core/groups.js';
import { normalizeConfig } from '../lib/core/config.js';

/** A store with its own temp directory, removed when the test ends. */
function makeStore(t) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-a2a-dir-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return createGroupStore({
    home,
    logger: { info() {}, warn() {}, error() {} },
    clock: () => Date.now(),
    config: normalizeConfig({ groups: { gatewayBase: 'http://gw:3000/a2a', agentName: 'host' } }),
  });
}

/** Create a group and return `{groupId, owner}`. */
function makeGroup(store, name, options = {}) {
  const created = store.create({
    name,
    topic: options.topic ?? '',
    ownerDisplayName: options.owner ?? '群主',
    settings: options.settings,
  });
  return {
    groupId: created.group.groupId,
    owner: { memberId: created.group.owner.memberId, memberKey: created.ownerKey },
  };
}

test('the directory lists a public group with counts and no identities', (t) => {
  const store = makeStore(t);
  const group = makeGroup(store, '发票重构', { topic: '拆分 invoice 服务', owner: '张工' });

  const page = store.listDirectory();
  assert.equal(page.groups.length, 1);
  const row = page.groups[0];
  assert.equal(row.groupId, group.groupId);
  assert.equal(row.name, '发票重构');
  assert.equal(row.topic, '拆分 invoice 服务');
  assert.equal(row.memberCount, 1);
  // No `joinPolicy`: a group has no admission mode to advertise any more. Anyone
  // can ASK (the owner decides), and an invite link needs the owner to mint one —
  // both are per-request facts, not a property of the group worth publishing.
  assert.equal(row.joinPolicy, undefined, 'the directory does not advertise an admission mode');

  // The whole point: a credential-free read must not name anybody.
  const serialized = JSON.stringify(page);
  assert.ok(!serialized.includes('张工'), 'the owner display name must not appear');
  assert.ok(!serialized.includes(group.owner.memberId), 'no member ids');
  assert.ok(!serialized.includes(group.owner.memberKey), 'no member keys');
});

test('an unlisted group is absent, not flagged', (t) => {
  const store = makeStore(t);
  const visible = makeGroup(store, '公开群');
  const hidden = makeGroup(store, '秘密群', { settings: { visibility: 'unlisted' } });

  const page = store.listDirectory();
  assert.equal(page.groups.length, 1);
  assert.equal(page.groups[0].groupId, visible.groupId);
  // Absent entirely: returning it with `visibility: 'unlisted'` would still answer
  // "yes, there is a group with that id", which is what unlisted is for.
  assert.ok(!page.groups.some((row) => row.groupId === hidden.groupId));
});

test('the directory never carries feed text even when the feed has content', (t) => {
  const store = makeStore(t);
  const group = makeGroup(store, '活跃群');
  store.post({
    groupId: group.groupId,
    member: group.owner,
    text: '这句话不该出现在目录里',
  });

  const page = store.listDirectory();
  const serialized = JSON.stringify(page);
  assert.ok(!serialized.includes('这句话不该出现在目录里'), 'feed content must not leak');
  assert.ok(!serialized.includes('"text"'), 'no text field at all');
  assert.ok(!serialized.includes('"entries"'));
  assert.ok(!serialized.includes('"members"'), 'no member array');
  // The count is fine — it is a number, not a roster.
  assert.equal(page.groups[0].memberCount, 1);
  assert.ok(page.groups[0].lastSeq >= 1, 'a sequence number is a coarse activity signal, not content');
});

test('the query filters by name and topic, case-insensitively', (t) => {
  const store = makeStore(t);
  makeGroup(store, 'Invoice Refactor', { topic: 'split the service' });
  makeGroup(store, '合同评审', { topic: '法务流程' });

  assert.equal(store.listDirectory({ query: 'invoice' }).groups.length, 1);
  assert.equal(store.listDirectory({ query: 'INVOICE' }).groups.length, 1);
  assert.equal(store.listDirectory({ query: '法务' }).groups.length, 1, 'topic is searched too');
  assert.equal(store.listDirectory({ query: 'nothing' }).groups.length, 0);
});

test('the directory is paged and bounded', (t) => {
  const store = makeStore(t);
  for (let index = 0; index < 5; index += 1) makeGroup(store, `群 ${index}`);

  const first = store.listDirectory({ limit: 2 });
  assert.equal(first.returned, 2);
  assert.equal(first.total, 5);
  assert.equal(first.hasMore, true);

  const second = store.listDirectory({ limit: 2, offset: 2 });
  assert.equal(second.returned, 2);
  assert.notEqual(second.groups[0].groupId, first.groups[0].groupId, 'pages do not overlap');

  // A caller cannot ask for everything at once.
  const greedy = store.listDirectory({ limit: 10_000 });
  assert.ok(greedy.returned <= DIRECTORY_MAX_LIMIT, `clamped to ${DIRECTORY_MAX_LIMIT}`);

  // A nonsense limit is clamped INTO the valid range, not treated as "no limit".
  // The distinction matters: "return everything" is exactly what an unbounded call
  // would do, and clamping a negative to the floor (1) is the safe reading —
  // whereas falling back to the default would silently return 20 rows for a
  // caller who asked for -5.
  const nonsense = store.listDirectory({ limit: -5 });
  assert.equal(nonsense.returned, 1, 'a negative limit clamps to the smallest page');

  // An absent limit uses the default page size.
  const defaulted = store.listDirectory({});
  assert.equal(defaulted.returned, Math.min(DIRECTORY_DEFAULT_LIMIT, 5));
});

test('the directory orders by latest activity, not by name', (t) => {
  const store = makeStore(t);
  const older = makeGroup(store, 'A 老群');
  const newer = makeGroup(store, 'B 新群');
  // Posting in the older group makes it the most recently active, which is what a
  // directory should surface first.
  store.post({ groupId: older.groupId, member: older.owner, text: 'still alive' });

  const page = store.listDirectory();
  assert.equal(page.groups[0].groupId, older.groupId, 'most recently active first');
  assert.notEqual(page.groups[0].groupId, newer.groupId);
});

test('an empty host reports an empty directory rather than failing', (t) => {
  const store = makeStore(t);
  const page = store.listDirectory();
  assert.deepEqual(page.groups, []);
  assert.equal(page.total, 0);
  assert.equal(page.hasMore, false);
});
