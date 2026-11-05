/**
 * The role tool must be able to set the personal headline.
 *
 * WHY THIS TEST EXISTS
 *
 * `persons.headline` was stored, editable from the panel, and rendered on every colleague card — but no TOOL
 * wrote it. An agent asked to "update my introduction" could only answer "use the panel". The data path was
 * complete and the tool surface had a hole in it, which is exactly the kind of gap that no type check finds.
 *
 * The two fields mean different things and the tests keep them apart:
 *
 *   about     what I do in THIS group — a membership row
 *   headline  who I am — a person row, shown on every card
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
import { TOOL_SPECS } from '../lib/shared/tool-specs.js';

/** A runtime wired to a real store, with one group this instance owns. */
function harness() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-a2a-headline-'));
  const logger = { info() {}, warn() {}, debug() {} };
  const config = normalizeConfig({ groups: { gatewayBase: 'http://gw/a2a', agentName: 'agent-test' } });
  const store = createGroupStore({ home, logger, clock: () => Date.now(), config });
  const identities = createMembershipLedger({ home, logger, clock: () => Date.now() });

  const created = store.create({ name: '发票重构', ownerDisplayName: '张三' });
  const groupId = created.group.groupId;
  const sessionId = 'session-test';

  identities.upsert({
    sessionId,
    groupId,
    personId: created.group.owner.personId,
    personKey: created.ownerKey,
    local: true,
    groupName: created.group.name,
    role: 'owner',
    lastSeq: 0,
  });

  const runtime = createToolRuntime({ store, identities, config, logger, clock: () => Date.now() });
  return {
    store,
    identities,
    runtime,
    groupId,
    sessionId,
    personId: created.group.owner.personId,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

test('the role tool declares a headline parameter', () => {
  const spec = TOOL_SPECS.find((entry) => entry.name === 'a2a_group_role');
  assert.ok(spec, 'a2a_group_role must exist');
  assert.ok(spec.parameters.properties.headline, 'the tool must accept a headline');
  assert.match(
    spec.parameters.properties.headline.description,
    /every colleague card|independent of any group/i,
    'the description must say the headline is not group-scoped, or a model will confuse it with about',
  );
});

test('setting a headline writes the person row and leaves about alone', async () => {
  const env = harness();
  try {
    await env.runtime.call('a2a_group_role', {
      groupId: env.groupId,
      about: '负责对账',
      headline: '后端工程师',
    }, { sessionId: env.sessionId });

    // The two live in different rows; setting one must not blank the other.
    const person = env.store.listPersons().find((row) => row.personId === env.personId);
    assert.equal(person.headline, '后端工程师');

    // snapshot returns counts, not rows, so the roster comes from members. It authenticates too, hence
    // the credential from the ledger — a bare personId throws not_member, which reads like "the write broke".
    const record = env.identities.get(env.groupId, env.sessionId);
    const roster = env.store.members({ groupId: env.groupId, member: { personId: env.personId, personKey: record.personKey } });
    const member = roster.find((row) => row.personId === env.personId);
    assert.equal(member.roleAbout, '负责对账');
  } finally {
    env.cleanup();
  }
});

test('omitting the headline leaves the stored one untouched', async () => {
  const env = harness();
  try {
    await env.runtime.call('a2a_group_role', { groupId: env.groupId, headline: '后端工程师' }, { sessionId: env.sessionId });

    // Changing only the group-scoped part must not wipe the person-scoped one. This is the mistake a caller
    // makes naturally: they pass what they are editing and nothing else.
    const result = await env.runtime.call('a2a_group_role', { groupId: env.groupId, about: '兼产品' }, { sessionId: env.sessionId });

    assert.equal(result.headline, '后端工程师', 'the response must report the headline that is still stored');
    const person = env.store.listPersons().find((row) => row.personId === env.personId);
    assert.equal(person.headline, '后端工程师');
  } finally {
    env.cleanup();
  }
});

test('an empty string clears the headline', async () => {
  const env = harness();
  try {
    await env.runtime.call('a2a_group_role', { groupId: env.groupId, headline: '后端工程师' }, { sessionId: env.sessionId });
    await env.runtime.call('a2a_group_role', { groupId: env.groupId, headline: '' }, { sessionId: env.sessionId });

    // Clearing must be possible: a headline that can only be overwritten is a field people cannot retract.
    const person = env.store.listPersons().find((row) => row.personId === env.personId);
    assert.equal(person.headline, '');
  } finally {
    env.cleanup();
  }
});