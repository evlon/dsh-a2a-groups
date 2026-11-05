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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  // The helper returns the whole LEDGER RECORD, not just the id: rejoining without an invite requires the credential
  // as proof, and a bare personId is a claim rather than evidence.
  assert.match(runtime, /const adopt = existingMembershipFor/u);
  assert.match(runtime, /const adoptRemote = existingMembershipFor/u);
});

test('the host accepts a personId when joining', async () => {
  const skills = (await import('node:fs')).readFileSync('lib/core/skills-group.js', 'utf8');
  // Without this the remote path sends a personId the host ignores, and the duplicate 张三 comes back.
  assert.match(skills, /personId: typeof data\.personId === 'string'/u);
});

// ---------------------------------------------------------------------------
// The panel must be able to OFFER it, or the backend work is unreachable
// ---------------------------------------------------------------------------

test('the host publishes a rejoinable row per ledger record, not per group', () => {
  const index = readFileSync('lib/index.js', 'utf8');

  // The row used to be skipped whenever ANY Session held the group, which is always true once a person has joined —
  // so the offer could never appear for the one case it exists for.
  assert.equal(
    /if \(joinedIds\.has\(groupId\)\) continue;/u.test(index),
    false,
    'skipping by group hides the offer from every other Session',
  );
  assert.match(index, /canRejoinAs: true/u);
});

test('the normaliser carries the rejoin fields to the pane', () => {
  const client = readFileSync('client.js', 'utf8');
  // Another whitelist mapper. Adding the field to the host snapshot without adding it here is how it never arrives.
  assert.match(client, /canRejoinAs: raw\.canRejoinAs === true/u);
  assert.match(client, /knownAs: pickString\(raw\.knownAs\)/u);
});

test('the offer is keyed on the CURRENT Session, not on the row', () => {
  const client = readFileSync('client.js', 'utf8');
  // A group this conversation is already in must not offer to rejoin it; one held by ANOTHER conversation must.
  assert.match(client, /holdingSession === currentSession/u, 'the pane must compare the holding Session to its own');
  // And the pane needs the current Session passed in, or the comparison has nothing to compare against.
  assert.match(client, /UnboundMembersPane, \{ inputActions: inputActions, snapshot: snapshot, sessionId: sessionId \}/u);
});

test('the offer lists each GROUP once, however many records it has', () => {
  // A person who moved twice has several ledger records for one group — one per abandoned working directory — and all
  // of them pass the "held by another Session" test. Rendering one button each showed 「发票与对账平台」 twice with
  // identical labels, which read as "it says two joined groups and that cannot be right".
  const client = readFileSync('client.js', 'utf8');
  const at = client.indexOf('const rejoinable = (function () {');
  assert.ok(at > -1, 'the rejoin list must be built explicitly');
  const body = client.slice(at, client.indexOf('})();', at));
  assert.match(body, /const seen = \{\}/u, 'dedupe by group id');
  assert.match(body, /if \(seen\[key\] === true\) continue;/u);
});

test('the copy no longer says a group will not follow you', () => {
  const client = readFileSync('client.js', 'utf8');
  // That sentence described the behaviour before identity adoption, and contradicts the offer rendered above it.
  assert.equal(/不会自动跟过来/u.test(client), false, 'the old wording must be gone');
  assert.match(client, /你已经在这些群里/u, 'and the offer must be named');
});
// ---------------------------------------------------------------------------
// The prefill must actually run
// ---------------------------------------------------------------------------

/**
 * REGRESSION: the rejoin button filled the composer with an instruction that could not succeed.
 *
 * ROOT CAUSE: `join` accepted exactly one proof of right-to-enter, an invite token. A member changing working
 * directory has no token — theirs is spent — so the prefilled `a2a_group_join` call failed with `invite_invalid`.
 * The panel looked right, the backend looked right, and the path between them was broken.
 *
 * Found by clicking the button and running what it said, which is the only way this class of bug surfaces.
 */
test('a member can rejoin with their own credential and no invite token', () => {
  const env = harness();
  try {
    const rejoined = env.store.join({
      groupId: env.groupId,
      displayName: '张三',
      // No token at all: the credential IS the proof.
      personId: env.ownerPersonId,
      personKey: env.ownerKey,
    });

    assert.equal(rejoined.member.personId, env.ownerPersonId, 'same person');
    assert.equal(typeof rejoined.personKey, 'string', 'and a usable credential comes back');
    assert.equal(env.store.snapshot({ groupId: env.groupId }).memberCount, 1, 'the group gains nobody');
  } finally {
    env.cleanup();
  }
});

test('a wrong credential is refused without a token', () => {
  const env = harness();
  try {
    // Accepting a bare personId, or a wrong key, would let anybody rejoin as anybody.
    assert.throws(
      () => env.store.join({ groupId: env.groupId, displayName: '冒充', personId: env.ownerPersonId, personKey: 'mk_wrong' }),
      (error) => error.code === 'not_member',
    );
  } finally {
    env.cleanup();
  }
});

test('a bare personId is still not enough', () => {
  const env = harness();
  try {
    // The claim without the proof must fall back to requiring an invite.
    assert.throws(
      () => env.store.join({ groupId: env.groupId, displayName: '冒充', personId: env.ownerPersonId }),
      (error) => error.code === 'invite_invalid' || error.code === 'not_member',
    );
  } finally {
    env.cleanup();
  }
});

test('a genuine newcomer still needs an invite token', () => {
  const env = harness();
  try {
    // The takeover path must not have opened a hole for people who were never members.
    assert.throws(
      () => env.store.join({ groupId: env.groupId, displayName: '路人' }),
      (error) => error.code === 'invite_invalid',
    );
  } finally {
    env.cleanup();
  }
});

test('the tool sends the credential, not just the id', () => {
  const runtime = readFileSync('lib/shared/tool-runtime.js', 'utf8');
  // A bare personId would be a claim; the store needs the secret to accept a tokenless join.
  assert.match(runtime, /personKey: adoptPersonKey/u);
  assert.match(runtime, /personKey: adoptRemotePersonKey/u);
});

test('the host skill forwards personKey, not only personId', () => {
  // The chain has FOUR hops — panel prefill, tool, host skill, store — and each must carry the credential. The host
  // skill forwarded only `personId`, so `claimsExisting` was always false and every tokenless join fell back to
  // demanding an invite. The panel looked right, the store was right, and the link between them dropped the secret.
  const skills = readFileSync('lib/core/skills-group.js', 'utf8');
  const at = skills.indexOf("id: 'group/join'");
  const body = skills.slice(at, skills.indexOf("id: 'group/invite'", at));
  assert.match(body, /personId: typeof data\.personId/u);
  assert.match(body, /personKey: typeof data\.personKey/u, 'the proof must travel with the claim');
});
