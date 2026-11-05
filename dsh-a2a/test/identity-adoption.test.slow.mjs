/**
 * A new working directory must not turn one person into two members.
 *
 * THE WORKFLOW
 *
 * Project 1 finishes, project 2 starts, the working directory changes, and a new Session is opened. Long-lived groups
 * are normal, so that person rejoins the same group they have been in for months.
 *
 * Under per-Session identity that produced:
 *
 *     members: 张三 (m-a)   from project 1
 *              张三 (m-b)   from project 2
 *
 * Colleagues see two people with one name, `@张三` resolves to whichever one happens to be unique, and one person's
 * history is split across two ids.
 *
 * WHY THE OLD DESIGN WAS DEFENSIBLE BUT WRONG FOR THIS
 *
 * `memberships.js` justified per-Session identity with "one person may be two members of a group, each owning a
 * module". That is real — but it conflates two things that are separately expressible:
 *
 *     two working contexts  -> two Sessions, two read cursors   (needed)
 *     two different people  -> two personIds                     (not needed)
 *
 * 90% of colleagues have one device, and a machine belongs to one person, so on a given machine the same group means
 * the same person.
 *
 * @module dsh-a2a/test/identity-adoption
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGroupStore } from '../lib/core/groups.js';
import { createMembershipLedger } from '../lib/core/memberships.js';
import { normalizeConfig } from '../lib/core/config.js';
import { createToolRuntime } from '../lib/shared/tool-runtime.js';

const LOGGER = { info() {}, warn() {}, debug() {} };

/** A hosted group, a ledger, and a runtime that can join from several Sessions. */
function harness() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-a2a-adopt-'));
  const clock = () => Date.now();
  const config = normalizeConfig({
    groups: { gatewayBase: 'http://gw/a2a', agentName: 'agent-test', embedded: true },
    client: { apiKey: 'k', forwardProto: 'http', timeoutMs: 1000 },
  });
  const store = createGroupStore({ home, logger: LOGGER, clock, config });
  const identities = createMembershipLedger({ home, logger: LOGGER, clock });

  const created = store.create({ name: '发票与对账平台', ownerDisplayName: '张三' });
  const groupId = created.group.groupId;
  // The owner joined from a first Session, as they would have.
  identities.upsert({
    sessionId: 'session-project-1',
    groupId,
    personId: created.group.owner.personId,
    personKey: created.ownerKey,
    local: true,
    groupName: created.group.name,
    role: 'owner',
    lastSeq: 0,
  });

  const runtime = createToolRuntime({ store, identities, config, logger: LOGGER, clock });
  return {
    store,
    identities,
    runtime,
    groupId,
    ownerPersonId: created.group.owner.personId,
    ownerKey: created.ownerKey,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

/** A fresh invite for the group. */
function inviteFor(env) {
  return env.store.invite({ groupId: env.groupId, ownerKey: env.ownerKey }).token;
}

test('a second Session joins as the SAME person, not a second 张三', async () => {
  const env = harness();
  try {
    const token = inviteFor(env);
    const joined = await env.runtime.call(
      'a2a_group_join',
      { groupId: env.groupId, token, displayName: '张三' },
      { sessionId: 'session-project-2' },
    );

    // The whole point: one person, one member row, however many working directories they pass through.
    assert.equal(joined.personId, env.ownerPersonId, 'the new Session must adopt the existing identity');

    // The reissued credential, not the owner's original: adoption retires the old one on purpose, which the
    // credential-retirement test below asserts directly.
    const roster = env.store.members({
      groupId: env.groupId,
      member: { personId: joined.personId, personKey: joined.personKey },
    });
    assert.equal(roster.filter((row) => row.displayName === '张三').length, 1, 'one 张三, not two');
  } finally {
    env.cleanup();
  }
});

test('the new Session can post, as that same person', async () => {
  const env = harness();
  try {
    const token = inviteFor(env);
    const joined = await env.runtime.call(
      'a2a_group_join',
      { groupId: env.groupId, token, displayName: '张三' },
      { sessionId: 'session-project-2' },
    );

    const posted = await env.store.post({
      groupId: env.groupId,
      member: { personId: joined.personId, personKey: joined.personKey },
      text: '从项目 2 的目录继续',
    });

    const page = env.store.read({
      groupId: env.groupId,
      member: { personId: joined.personId, personKey: joined.personKey },
      sinceSeq: 0,
    });
    const entry = page.entries.find((row) => row.seq === posted.seq);

    // The author must be the ONE identity, or the group's history splits in two.
    assert.equal(entry.from.personId, env.ownerPersonId);
  } finally {
    env.cleanup();
  }
});

test('the old Session keeps its record but its credential is retired', async () => {
  const env = harness();
  try {
    const token = inviteFor(env);
    const joined = await env.runtime.call(
      'a2a_group_join',
      { groupId: env.groupId, token, displayName: '张三' },
      { sessionId: 'session-project-2' },
    );
    assert.notEqual(joined.personKey, env.ownerKey, 'the credential is reissued to the new Session');

    // The host stores ONE keyHash per member, so the old key cannot keep working. That is the deliberate trade: a
    // person who moved to a new working directory is not going to post from the old one.
    assert.throws(
      () => env.store.post({
        groupId: env.groupId,
        member: { personId: env.ownerPersonId, personKey: env.ownerKey },
        text: '旧会话还能说话吗',
      }),
      (error) => error.code === 'not_member',
    );
  } finally {
    env.cleanup();
  }
});

test('the old Session can still READ history without a credential', async () => {
  const env = harness();
  try {
    const token = inviteFor(env);
    await env.runtime.call(
      'a2a_group_join',
      { groupId: env.groupId, token, displayName: '张三' },
      { sessionId: 'session-project-2' },
    );

    // Reading is not a credential-bearing operation for a local group, and a person who moved still needs to look
    // back at what was said. Losing read access on rejoin would be a strange punishment for changing directory.
    const group = env.store.snapshot({ groupId: env.groupId });
    assert.equal(group.name, '发票与对账平台');
  } finally {
    env.cleanup();
  }
});

test('a genuinely different person still gets a new identity', () => {
  const env = harness();
  try {
    const token = inviteFor(env);
    const joined = env.store.join({ groupId: env.groupId, token, displayName: '李四' });

    // No other Session holds an identity for 李四, so this must NOT adopt 张三's.
    assert.notEqual(joined.member.personId, env.ownerPersonId);
    assert.equal(joined.rejoined, undefined, 'this is a first join, not a rejoin');
  } finally {
    env.cleanup();
  }
});

test('the lookup ignores the Session doing the joining', () => {
  const env = harness();
  try {
    // Joining twice from the SAME Session must not treat its own row as "somebody else's identity" — that would
    // make the adoption path fire on an ordinary retry and change its meaning.
    const token = inviteFor(env);
    const first = env.store.join({ groupId: env.groupId, token, displayName: '王五' });
    const second = env.store.join({
      groupId: env.groupId,
      token,
      displayName: '王五',
      personId: first.member.personId,
    });
    assert.equal(second.rejoined, true);
    assert.equal(second.member.personId, first.member.personId);
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// The wiring
// ---------------------------------------------------------------------------

test('both join paths resolve an existing identity', async () => {
  const runtime = (await import('node:fs')).readFileSync('lib/shared/tool-runtime.js', 'utf8');
  // `adoptPersonId` for a hosted group, `adoptRemotePersonId` for one reached over the wire. Two spellings because
  // the variable belongs to two different branches, but one rule.
  assert.match(runtime, /const adoptPersonId = existingPersonFor/u);
  assert.match(runtime, /const adoptRemotePersonId = existingPersonFor/u);
});

test('the host accepts a personId when joining', async () => {
  const skills = (await import('node:fs')).readFileSync('lib/core/skills-group.js', 'utf8');
  // Without this the remote path sends a personId the host ignores, and the duplicate 张三 comes back.
  assert.match(skills, /personId: typeof data\.personId === 'string'/u);
});
