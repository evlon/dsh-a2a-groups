/**
 * Tests for the two modes the join page can be in.
 *
 * WHY TWO MODES
 *
 * Joining the COLLABORATION and joining a GROUP are different things, and the first version conflated them:
 *
 *   - a host with no groups returned 503, because the page's content was built from "the first group". Configuring
 *     an instance against the host is the step that PRECEDES groups, so the normal fresh-install path was broken.
 *   - every page described whichever group sorted first, so an invitation for group A could land somebody in group
 *     B — after which their invitation was still unused and they were in the wrong place.
 *
 * And a new colleague could not tell which case they were in: the same wall of YAML appeared either way. So the
 * page now names its mode, and only mentions groups when there is one.
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';

import { buildJoinInstruction, renderJoinPage } from '../lib/core/join-page.js';

const BASE = {
  gatewayBase: 'http://gw:3000/a2a',
  agentName: 'agent-group-host',
  apiKey: 'sk-test',
  publicUrl: 'http://127.0.0.1:3091/a2a',
  serverToken: 'tok',
  expiresAt: Date.now() + 600000,
};

const WITH_GROUP = { ...BASE, groupName: '发票重构', groupId: 'g-abc' };
const NO_GROUP = { ...BASE, groupName: '', groupId: '' };

test('a page with a group says so, and names it', () => {
  const html = renderJoinPage(WITH_GROUP);
  assert.match(html, /加入协作群/);
  assert.ok(html.includes('发票重构'));
  // The reader must be able to tell which group; a bare "join a group" leaves them guessing.
  assert.ok(html.includes('g-abc'));
});

test('a page without a group says it is the collaboration, not a group', () => {
  const html = renderJoinPage(NO_GROUP);
  assert.match(html, /加入协作模式/);
  // The failure this replaces: an invitation to a group with no name.
  assert.ok(!html.includes('加入协作群「」'), 'an empty group name must not read as a group invitation');
});

test('a configure-only page does not pretend there is a group to join', () => {
  const html = renderJoinPage(NO_GROUP);
  // Wording matters here: the page must say the group comes later, or the reader waits for an invitation that is
  // not part of this step.
  assert.match(html, /不含具体群|不加入具体的群/);
  assert.match(html, /a2a_group_directory/);
});

test('the instruction does not open with an empty group name', () => {
  const text = buildJoinInstruction(NO_GROUP);
  assert.ok(!text.includes('「」'), 'empty quotes must not appear');
  assert.ok(!text.includes('群名：'), 'a configure-only page must not list a group name at all');
});

test('the instruction still carries every connection value in both modes', () => {
  for (const values of [WITH_GROUP, NO_GROUP]) {
    const text = buildJoinInstruction(values);
    // These are the values the assistant writes into the profile; missing one produces a half-configured plugin.
    assert.ok(text.includes(BASE.gatewayBase), 'gateway');
    assert.ok(text.includes(BASE.agentName), 'agent name');
    assert.ok(text.includes(BASE.apiKey), 'api key');
    assert.ok(text.includes(BASE.bundles === undefined ? 'dsh.profile.bundles' : 'x'), 'bundle step');
  }
});

test('both modes ask for a diff before writing', () => {
  for (const values of [WITH_GROUP, NO_GROUP]) {
    assert.match(buildJoinInstruction(values), /先给我看改动|确认后再写/u);
  }
});

test('both modes render a share link and a copy button', () => {
  for (const values of [WITH_GROUP, NO_GROUP]) {
    const html = renderJoinPage(values);
    assert.ok(html.includes('id="shareLink"'), 'the share field');
    assert.ok(html.includes('copyShare'), 'the share button');
  }
});

test('the group is carried in the share link when there is one', () => {
  const html = renderJoinPage(WITH_GROUP);
  // Without this the colleague lands on a configure-only page while holding an invitation.
  assert.match(html, /get\('g'\)/);
});
