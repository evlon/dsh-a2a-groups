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

import { SETUP_PATH, buildJoinInstruction, renderJoinPage } from '../lib/core/join-page.js';

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

// ---------------------------------------------------------------------------
// The permanent (token-free) entry point
// ---------------------------------------------------------------------------

/**
 * REGRESSION: the configure-only page existed but no command could produce its URL.
 *
 * `mintJoinToken` is only handed to `group/invite`, and that skill always names a group — so the one page written for
 * a colleague who has not been invited anywhere yet was unreachable. And `/join?t=<32 hex>` is paste-only: useless to
 * say out loud or type into a document.
 *
 * `/setup` fixes both. It is ALSO permanent on purpose: the first design minted a token per visit, which means five
 * colleagues opening it at once leave five unused one-time tokens, and a refresh loop leaves unbounded ones.
 */
test('the permanent page does not claim to be a one-time link', () => {
  const html = renderJoinPage({ ...NO_GROUP, permanent: true });
  // A page that says 「一次性有效，N 分钟后作废」 while being bookmarkable is worse than no notice at all.
  assert.ok(!html.includes('一次性有效'), 'a permanent page must not warn about expiry');
  assert.ok(html.includes('可以收藏'), 'it should say the address is worth keeping');
});

test('the permanent page shares /setup, not a token URL', () => {
  const html = renderJoinPage({ ...NO_GROUP, permanent: true });
  // The share link is computed in the page's own script, so the path appears there rather than as a rendered value.
  assert.ok(html.includes('/setup'), 'the share link must point at the stable path');
  // The branch is guarded by `permanent`, so the token URL is never built for this page.
  assert.ok(html.includes('if (permanent) return'), 'the share link must branch on permanence');
});

test('the token page still warns about expiry', () => {
  // The guard above must not have removed the notice where it IS true.
  const html = renderJoinPage(WITH_GROUP);
  assert.ok(html.includes('一次性有效'), 'an invitation page carries a credential and must say so');
  assert.ok(!html.includes('可以收藏'));
});

test('SETUP_PATH is a short stable path, not a query-carrying link', () => {
  // Sayable over the phone is the whole point; a path with a query string is not.
  assert.equal(SETUP_PATH, '/setup');
  assert.ok(!SETUP_PATH.includes('?'), 'the address must not need a token to be valid');
});
