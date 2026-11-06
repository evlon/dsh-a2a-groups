/**
 * Coverage for the A2A skill layer itself.
 *
 * WHY A SEPARATE FILE FROM THE TOOL TESTS
 *
 * Tools and skills are two faces over the same store: a tool is what a model calls, a skill is what an A2A peer
 * calls. They run in different processes (a member's tool reaches a host's skill over the wire), which is why the
 * same operation exists twice and why a bug can live in one and not the other — the `from` shape and the membership
 * marking both did exactly that.
 *
 * Driving the skills directly is also the cheapest way to reach their refusal paths: each skill validates its own
 * arguments and returns a coded error, and those branches were almost entirely unexecuted.
 *
 * @module dsh-a2a/test/skill-coverage
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGroupStore } from '../lib/core/groups.js';
import { createMembershipLedger } from '../lib/core/memberships.js';
import { createGroupSkills } from '../lib/core/skills-group.js';
import { normalizeConfig } from '../lib/core/config.js';

const LOGGER = { info() {}, warn() {}, debug() {} };

/** A skill registry over a real store, plus a group to operate on. */
function harness() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-a2a-skills-'));
  const clock = () => Date.now();
  const config = normalizeConfig({
    groups: { gatewayBase: 'http://gw/a2a', agentName: 'agent-host' },
    client: { apiKey: 'k', forwardProto: 'http' },
  });
  const store = createGroupStore({ home, logger: LOGGER, clock, config });
  const identities = createMembershipLedger({ home, logger: LOGGER, clock });

  /** token → skill, for calling one by id. */
  const skills = new Map();
  for (const skill of createGroupSkills({ store, identities, config, logger: LOGGER, clock })) {
    skills.set(skill.id, skill);
  }

  /** Run one skill as a peer would: `{ text, data }` in, `{ text, meta }` out. */
  const run = async (id, data, text = id) => {
    const skill = skills.get(id);
    assert.ok(skill !== undefined, `skill ${id} must exist`);
    return skill.run({ text, data }, { taskId: 't', skill: id });
  };

  const created = store.create({ name: '发票重构', ownerDisplayName: '张三' });
  const groupId = created.group.groupId;

  return {
    home,
    store,
    skills,
    run,
    groupId,
    owner: { personId: created.group.owner.personId, personKey: created.ownerKey },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// The registry itself
// ---------------------------------------------------------------------------

test('every advertised skill has an id, a description and a runnable body', () => {
  const env = harness();
  try {
    assert.ok(env.skills.size >= 20, 'the surface is roughly twenty skills');
    for (const [id, skill] of env.skills) {
      // A card advertises these; a skill missing a description makes the card useless for discovery.
      assert.equal(typeof id, 'string');
      assert.ok(skill.description.length > 10, `${id} needs a real description`);
      assert.equal(typeof skill.run, 'function');
    }
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Argument validation — the refusal paths
// ---------------------------------------------------------------------------

test('a skill with a missing required argument fails with a code, not a crash', async () => {
  const env = harness();
  try {
    for (const [id, data] of [
      ['group/create', {}],
      ['group/info', { groupId: env.groupId }],
      ['group/post', { groupId: env.groupId }],
      ['group/rename', { groupId: env.groupId }],
    ]) {
      await assert.rejects(
        () => env.run(id, data),
        (error) => typeof error.code === 'string' && error.code !== '',
        `${id} must refuse a request missing an argument`,
      );
    }
  } finally {
    env.cleanup();
  }
});

test('a credential that does not belong to the group is refused', async () => {
  const env = harness();
  try {
    // The host must never take a caller at its word about who it is.
    await assert.rejects(
      () => env.run('group/post', {
        groupId: env.groupId,
        personId: env.owner.personId,
        personKey: 'mk_wrong',
        text: '冒充',
      }),
      (error) => error.code === 'not_member',
    );
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// The group lifecycle, driven as a peer would
// ---------------------------------------------------------------------------

test('create then invite then join then post then read, all through skills', async () => {
  const env = harness();
  try {
    const created = await env.run('group/create', { name: '技能链路', ownerDisplayName: '张三' });
    const groupId = created.meta.groupId;
    const owner = { groupId, personId: created.meta.personId, personKey: created.meta.ownerKey };

    const invited = await env.run('group/invite', owner);
    // The prompt is what the owner forwards; a link without an explanation gets sent bare.
    assert.ok(invited.meta.link.includes('agent-a2a://'));
    assert.ok(invited.meta.prompt.length > 0);

    const token = /[?&]t=([A-Za-z0-9_-]+)/u.exec(invited.meta.link)[1];
    const joined = await env.run('group/join', { groupId, token, displayName: '李四' });
    assert.ok(joined.meta.personId.startsWith('m-'));

    const posted = await env.run('group/post', { ...owner, text: '对账接口好了' });
    assert.ok(posted.meta.seq > 0);

    const read = await env.run('group/read', { ...owner, sinceSeq: 0 });
    assert.ok(read.meta.entries.some((entry) => entry.text === '对账接口好了'));
    // `from` is an object at the SKILL layer; the tool layer collapses it. Both must be deliberate.
    assert.equal(typeof read.meta.entries.find((entry) => entry.text === '对账接口好了').from.displayName, 'string');
  } finally {
    env.cleanup();
  }
});

test('group/info reports the roster with roles', async () => {
  const env = harness();
  try {
    const info = await env.run('group/info', { groupId: env.groupId, ...env.owner });
    assert.equal(info.meta.name, '发票重构');
    assert.equal(info.meta.members.length, 1);
    assert.equal(info.meta.members[0].role, 'owner');
  } finally {
    env.cleanup();
  }
});

test('group/members lists names without leaking credentials', async () => {
  const env = harness();
  try {
    const listed = await env.run('group/members', { groupId: env.groupId, ...env.owner });
    const serialized = JSON.stringify(listed.meta);
    // A roster travels to every member; a key hash in it would hand out the group.
    assert.ok(!serialized.includes('personKey'));
    assert.ok(!serialized.includes('keyHash'));
  } finally {
    env.cleanup();
  }
});

test('group/directory needs no credential and hides what it should', async () => {
  const env = harness();
  try {
    const directory = await env.run('group/directory', {});
    assert.ok(directory.meta.groups.length >= 1);

    const row = directory.meta.groups.find((entry) => entry.groupId === env.groupId);
    // The topic is public on purpose: it is how somebody decides whether to ask to join. Bodies are not.
    assert.ok(row !== undefined);
    const serialized = JSON.stringify(row);
    assert.ok(!serialized.includes('personKey'));
    assert.ok(!serialized.includes('keyHash'));
  } finally {
    env.cleanup();
  }
});

test('group/role updates only the caller own row', async () => {
  const env = harness();
  try {
    const updated = await env.run('group/role', { groupId: env.groupId, ...env.owner, about: '负责验收', tags: ['产品'] });
    assert.equal(updated.meta.about, '负责验收');

    // There is deliberately no target: a role is what you say about yourself.
    const info = await env.run('group/info', { groupId: env.groupId, ...env.owner });
    assert.equal(info.meta.members[0].roleAbout, '负责验收');
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// The request / approve / claim flow
// ---------------------------------------------------------------------------

test('request, approve and claim admits a member who never had a link', async () => {
  const env = harness();
  try {
    const requested = await env.run('group/request', { groupId: env.groupId, displayName: '王五', reason: '对账' });
    // The claim key is the secret half: knowing a request exists must not be enough to take it.
    assert.ok(typeof requested.meta.claimKey === 'string' && requested.meta.claimKey.length > 10);

    const queued = await env.run('group/requests', { groupId: env.groupId, ...env.owner });
    assert.ok(queued.meta.requests.some((entry) => entry.requestId === requested.meta.requestId));

    await env.run('group/decide', { groupId: env.groupId, ...env.owner, requestId: requested.meta.requestId, approve: true });

    const claimed = await env.run('group/claim', {
      groupId: env.groupId,
      requestId: requested.meta.requestId,
      claimKey: requested.meta.claimKey,
    });
    assert.ok(claimed.meta.personKey.startsWith('mk_'));
  } finally {
    env.cleanup();
  }
});

test('a rejected request cannot be claimed', async () => {
  const env = harness();
  try {
    const requested = await env.run('group/request', { groupId: env.groupId, displayName: '王五' });
    await env.run('group/decide', { groupId: env.groupId, ...env.owner, requestId: requested.meta.requestId, approve: false });

    // An approval is a decision, and a refusal must be as final as a grant.
    await assert.rejects(
      () => env.run('group/claim', {
        groupId: env.groupId,
        requestId: requested.meta.requestId,
        claimKey: requested.meta.claimKey,
      }),
      (error) => typeof error.code === 'string',
    );
  } finally {
    env.cleanup();
  }
});

test('a claim with the wrong key is refused', async () => {
  const env = harness();
  try {
    const requested = await env.run('group/request', { groupId: env.groupId, displayName: '王五' });
    await env.run('group/decide', { groupId: env.groupId, ...env.owner, requestId: requested.meta.requestId, approve: true });

    await assert.rejects(
      () => env.run('group/claim', { groupId: env.groupId, requestId: requested.meta.requestId, claimKey: 'wrong' }),
      (error) => typeof error.code === 'string',
    );
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Management
// ---------------------------------------------------------------------------

test('group/rename and group/archive change what the caller sees', async () => {
  const env = harness();
  try {
    const renamed = await env.run('group/rename', { groupId: env.groupId, ...env.owner, name: '新名字' });
    assert.equal(renamed.meta.name, '新名字');

    const archived = await env.run('group/archive', { groupId: env.groupId, ...env.owner });
    assert.equal(archived.meta.archived, true);

    // An archived group stays readable: the history is the point of keeping it.
    const read = await env.run('group/read', { groupId: env.groupId, ...env.owner, sinceSeq: 0 });
    assert.ok(Array.isArray(read.meta.entries));
  } finally {
    env.cleanup();
  }
});

test('group/remove requires the owner', async () => {
  const env = harness();
  try {
    const invited = await env.run('group/invite', { groupId: env.groupId, ...env.owner });
    const token = /[?&]t=([A-Za-z0-9_-]+)/u.exec(invited.meta.link)[1];
    const joined = await env.run('group/join', { groupId: env.groupId, token, displayName: '李四' });
    const member = { personId: joined.meta.personId, personKey: joined.meta.personKey };

    // A member removing somebody would let anyone clear the roster.
    await assert.rejects(
      () => env.run('group/remove', { groupId: env.groupId, ...member, targetPersonId: env.owner.personId }),
      (error) => error.code === 'not_owner',
    );

    const removed = await env.run('group/remove', { groupId: env.groupId, ...env.owner, targetPersonId: member.personId });
    assert.equal(removed.meta.personId, member.personId);
  } finally {
    env.cleanup();
  }
});

test('group/leave lets a member remove themselves', async () => {
  const env = harness();
  try {
    const invited = await env.run('group/invite', { groupId: env.groupId, ...env.owner });
    const token = /[?&]t=([A-Za-z0-9_-]+)/u.exec(invited.meta.link)[1];
    const joined = await env.run('group/join', { groupId: env.groupId, token, displayName: '李四' });

    const left = await env.run('group/leave', {
      groupId: env.groupId,
      personId: joined.meta.personId,
      personKey: joined.meta.personKey,
    });
    assert.ok(left !== undefined);

    // After leaving, the credential must stop working.
    await assert.rejects(
      () => env.run('group/post', { groupId: env.groupId, personId: joined.meta.personId, personKey: joined.meta.personKey, text: '还在吗' }),
      (error) => error.code === 'not_member',
    );
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// group/wait — the host-side long poll the MCP client leans on
// ---------------------------------------------------------------------------

test('group/wait holds until a post lands and returns only what is new', async () => {
  const env = harness();
  try {
    // A member posts first, then the waiter reads from a cursor past that post.
    const invited = await env.run('group/invite', { groupId: env.groupId, ...env.owner });
    const token = /[?&]t=([A-Za-z0-9_-]+)/u.exec(invited.meta.link)[1];
    const joined = await env.run('group/join', { groupId: env.groupId, token, displayName: '李四' });
    const member = { personId: joined.meta.personId, personKey: joined.meta.personKey };
    const posted = await env.run('group/post', { groupId: env.groupId, ...member, text: '先发的' });

    // The wait must return IMMEDIATELY for a message already above the cursor.
    const waited = await env.run('group/wait', { groupId: env.groupId, ...member, sinceSeq: 0, timeoutMs: 3000 });
    assert.equal(waited.meta.hasNew, true);
    assert.equal(waited.meta.waitedMs, 0);
    assert.ok(waited.meta.entries.some((entry) => entry.text === '先发的'));

    // From a cursor AT the current head, the wait must block and wake on the next post.
    // Schedule the post to land AFTER the wait has subscribed, so the blocking path is genuinely exercised.
    const head = env.store.snapshot({ groupId: env.groupId }).lastSeq;
    const start = Date.now();
    const laterPost = new Promise((resolve) => {
      setTimeout(() => resolve(env.run('group/post', { groupId: env.groupId, ...env.owner, text: '后发的' })), 150);
    });
    const blocking = await env.run('group/wait', { groupId: env.groupId, ...member, sinceSeq: head, timeoutMs: 5000 });
    await laterPost;

    assert.equal(blocking.meta.hasNew, true);
    assert.ok(blocking.meta.entries.some((entry) => entry.text === '后发的'));
    // The blocking wait must be answered by the post, not by waiting out the window.
    assert.ok(Date.now() - start < 4000, 'group/wait must wake on the post');
  } finally {
    env.cleanup();
  }
});

test('group/wait times out with hasNew=false rather than failing', async () => {
  const env = harness();
  try {
    const head = env.store.snapshot({ groupId: env.groupId }).lastSeq;
    const waited = await env.run('group/wait', { groupId: env.groupId, ...env.owner, sinceSeq: head, timeoutMs: 1000 });
    assert.equal(waited.meta.hasNew, false);
    assert.deepEqual(waited.meta.entries, []);
  } finally {
    env.cleanup();
  }
});

test('group/wait refuses a caller without a valid membership', async () => {
  const env = harness();
  try {
    await assert.rejects(
      () => env.run('group/wait', { groupId: env.groupId, personId: env.owner.personId, personKey: 'mk_wrong' }),
      (error) => error.code === 'not_member',
    );
  } finally {
    env.cleanup();
  }
});
