/**
 * A group must be able to see that it is running mixed versions.
 *
 * THE PROBLEM THIS SOLVES
 *
 * Every debugging session this month opened with "is this instance on the new code?" — and twice the answer was no.
 * Once the process predated the edit; once a directory was shared between three profiles. Neither was visible from the
 * group, so both were found by comparing file timestamps by hand.
 *
 * A group whose members run different builds behaves inconsistently, and the symptom reads as a bug in the GROUP. The
 * version has to be visible for that to be a five-second check instead of an investigation.
 *
 * WHERE THE VALUE COMES FROM
 *
 * The only process that knows which build is running is the one running it, so each member reports its own version on
 * its heartbeat. `touch` carries it: it already runs every fifty seconds, so the value refreshes within a minute of an
 * upgrade and costs nothing extra.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not enforce. A mixed group is still a working group, and refusing an old member would strand them
 * mid-upgrade. The version is recorded and shown; the decision stays with the people.
 *
 * @module dsh-a2a/test/version-visibility
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGroupStore } from '../lib/core/groups.js';
import { normalizeConfig } from '../lib/core/config.js';

const LOGGER = { info() {}, warn() {}, debug() {} };

/** A store with one group and one invited member. */
function harness() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-a2a-ver-'));
  const clock = () => Date.now();
  const config = normalizeConfig({ groups: { gatewayBase: 'http://gw/a2a', agentName: 'agent-test' } });
  const store = createGroupStore({ home, logger: LOGGER, clock, config });

  const created = store.create({ name: '发票重构', ownerDisplayName: '张三' });
  const groupId = created.group.groupId;
  const owner = { personId: created.group.owner.personId, personKey: created.ownerKey };

  const invite = store.invite({ groupId, ownerKey: created.ownerKey });
  const joined = store.join({ groupId, token: invite.token, displayName: '李四' });
  const other = { personId: joined.member.personId, personKey: joined.personKey };

  return { store, groupId, owner, other, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/** One member row from the roster. */
function rowOf(env, personId) {
  return env.store.members({ groupId: env.groupId, member: env.owner }).find((row) => row.personId === personId);
}

test('a heartbeat records the version the caller reports', () => {
  const env = harness();
  try {
    env.store.touch({ groupId: env.groupId, member: env.owner, version: '0.1.7' });

    // The host must never guess: only the running process knows its own build.
    assert.equal(rowOf(env, env.owner.personId).clientVersion, '0.1.7');
  } finally {
    env.cleanup();
  }
});

test('an upgrade updates the recorded version', () => {
  const env = harness();
  try {
    env.store.touch({ groupId: env.groupId, member: env.owner, version: '0.1.6' });
    assert.equal(rowOf(env, env.owner.personId).clientVersion, '0.1.6');

    // The next heartbeat after a restart must replace it, or the panel would show a version that is no longer running.
    env.store.touch({ groupId: env.groupId, member: env.owner, version: '0.1.7' });
    assert.equal(rowOf(env, env.owner.personId).clientVersion, '0.1.7');
  } finally {
    env.cleanup();
  }
});

test('a member that never reported has no version, not a default one', () => {
  const env = harness();
  try {
    // Freshly joined and not yet heartbeated. Reporting "unknown" is honest; reporting a guess would make a skew
    // invisible exactly when it matters.
    assert.equal(rowOf(env, env.other.personId).clientVersion, undefined);
  } finally {
    env.cleanup();
  }
});

test('a heartbeat with no version leaves the recorded one alone', () => {
  const env = harness();
  try {
    env.store.touch({ groupId: env.groupId, member: env.owner, version: '0.1.7' });
    // A caller that omits the field must not erase what was known — an older client still proves presence.
    env.store.touch({ groupId: env.groupId, member: env.owner });
    assert.equal(rowOf(env, env.owner.personId).clientVersion, '0.1.7');
  } finally {
    env.cleanup();
  }
});

test('an absurdly long version is bounded', () => {
  const env = harness();
  try {
    // A member controls this string, so it must not be able to grow the state file without limit.
    env.store.touch({ groupId: env.groupId, member: env.owner, version: 'x'.repeat(500) });
    assert.equal(rowOf(env, env.owner.personId).clientVersion.length <= 32, true);
  } finally {
    env.cleanup();
  }
});

test('the version survives a reload', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-a2a-ver2-'));
  try {
    const clock = () => Date.now();
    const config = normalizeConfig({ groups: { gatewayBase: 'http://gw/a2a', agentName: 'agent-test' } });
    const first = createGroupStore({ home, logger: LOGGER, clock, config });
    const created = first.create({ name: '发票重构', ownerDisplayName: '张三' });
    first.touch({
      groupId: created.group.groupId,
      member: { personId: created.group.owner.personId, personKey: created.ownerKey },
      version: '0.1.7',
    });

    // A restart is precisely when a version check matters, so the value must not live only in memory.
    const second = createGroupStore({ home, logger: LOGGER, clock, config });
    const row = second.members({
      groupId: created.group.groupId,
      member: { personId: created.group.owner.personId, personKey: created.ownerKey },
    })[0];
    assert.equal(row.clientVersion, '0.1.7');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The wiring: every layer must forward the field
// ---------------------------------------------------------------------------

test('the store publishes the version on the roster', () => {
  const source = readFileSync('lib/core/groups.js', 'utf8');
  const at = source.indexOf('function publicMember(');
  const body = source.slice(at, source.indexOf('function publicEntry(', at));
  // Sixth time a whitelist mapper has been the place a field disappears.
  assert.match(body, /clientVersion/u);
});

test('the local host skill sends it to a remote member', () => {
  const skills = readFileSync('lib/core/skills-group.js', 'utf8');
  const at = skills.indexOf("id: 'group/info'");
  const body = skills.slice(at, skills.indexOf("id: 'group/members'", at));
  assert.match(body, /clientVersion/u, 'a remote member learns the roster through group/info');
});

test('the touch skill forwards what the caller reported', () => {
  const skills = readFileSync('lib/core/skills-group.js', 'utf8');
  const at = skills.indexOf("id: 'group/touch'");
  const body = skills.slice(at, skills.indexOf("id: 'group/away'", at));
  assert.match(body, /version:/u, 'the heartbeat is the only carrier that refreshes after an upgrade');
});

test('the heartbeat sends this instance version', () => {
  const index = readFileSync('lib/index.js', 'utf8');
  assert.match(index, /version: pluginVersion\(\)/u);
});

test('both roster caches carry the field', () => {
  // There are two writers — the refresh endpoint and the member-side tool — and a field added to one and not the other
  // produces a panel that is right or wrong depending on which path last ran.
  for (const file of ['lib/index.js', 'lib/shared/tool-runtime.js']) {
    const source = readFileSync(file, 'utf8');
    assert.match(source, /clientVersion: typeof member\.clientVersion/u, `${file} must carry clientVersion`);
  }
});

test('the panel receives its own version and each member version', () => {
  const client = readFileSync('client.js', 'utf8');
  assert.match(client, /selfVersion/u, 'the page cannot read package.json, so the Host must send it');
  assert.match(client, /clientVersion: pickString/u, 'and each member row must carry theirs');
});

test('the panel flags a mismatch but never invents one', () => {
  const client = readFileSync('client.js', 'utf8');
  // An empty member version means "has not reported", which is not the same as "differs from me".
  assert.match(client, /member\.clientVersion !== "" && member\.clientVersion !== selfVersion/u);
});

test('a version is recorded, never enforced', () => {
  const source = readFileSync('lib/core/groups.js', 'utf8');
  const at = source.indexOf('function touch(');
  const body = source.slice(at, source.indexOf('function markAway(', at));
  // Refusing an old member would strand them mid-upgrade; the point is visibility, not a gate.
  assert.equal(/throw .*version/u.test(body), false, 'a version difference must not refuse the call');
});

// ---------------------------------------------------------------------------
// Declaration order, which is a runtime failure and not a type error
// ---------------------------------------------------------------------------

test('the version comparison is declared after the roster it reads', () => {
  // `const versionMismatch = ... members.filter(...)` placed BEFORE `const members = rosterOf(group)` throws a
  // ReferenceError inside the component, and the whole pane renders blank. No assertion about the version fields
  // catches that, because every field was correct; only the ORDER was wrong.
  const client = readFileSync('client.js', 'utf8');
  const membersAt = client.indexOf('const members = rosterOf(group);');
  const mismatchAt = client.indexOf('const versionMismatch = (function () {');

  assert.ok(membersAt > -1, 'the roster must be computed');
  assert.ok(mismatchAt > -1, 'the comparison must exist');
  assert.equal(mismatchAt > membersAt, true, 'reading `members` before it is declared blanks the pane');
});

test('the panel renders when every member reports the same version', () => {
  // The no-mismatch path is the common one and must not throw: an empty array is the correct answer, and the
  // warning branch is skipped entirely.
  const client = readFileSync('client.js', 'utf8');
  assert.match(client, /if \(selfVersion === ""\) return \[\];/u, 'no known version means no comparison');
  assert.match(client, /versionMismatch\.length === 0/u, 'and the warning is skipped rather than rendered empty');
});
