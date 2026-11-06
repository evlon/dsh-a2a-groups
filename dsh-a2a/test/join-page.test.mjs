/**
 * Tests for the join page: the one-time token, the instruction it produces, and the page it renders.
 *
 * THE FOUR PROPERTIES THAT MATTER
 *
 *   1. a token works once. The page carries credentials, so a URL left in a chat history must stop working.
 *   2. the instruction names everything needed. A paragraph missing a field produces a half-configured plugin,
 *      and the failure surfaces far from here.
 *   3. the instruction tells the assistant to SHOW THE CHANGE FIRST. We are asking to modify a file on
 *      somebody's machine; a request that says "paste this and your config changes" is indistinguishable from an
 *      attack, and refusing it is the right instinct.
 *   4. user-supplied text is escaped. A group name is chosen by a colleague, and it renders into HTML.
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  JOIN_TOKEN_TTL_MS,
  buildJoinInstruction,
  createJoinTokenStore,
  renderJoinErrorPage,
  renderJoinPage,
} from '../lib/core/join-page.js';

/** A store with a controllable clock and predictable tokens. */
function harness() {
  let time = 1_000_000;
  let counter = 0;
  const store = createJoinTokenStore({
    newToken: () => `tok-${++counter}`,
    now: () => time,
    ttlMs: JOIN_TOKEN_TTL_MS,
  });
  return { store, advance: (ms) => { time += ms; }, setTime: (value) => { time = value; } };
}

const VALUES = {
  groupName: '发票重构',
  groupId: 'g-abc',
  gatewayBase: 'http://gw:3000/a2a',
  agentName: 'agent-group-host',
  apiKey: 'sk-test',
  publicUrl: 'http://127.0.0.1:3091/a2a',
  serverToken: 'server-token-value',
};

test('a token works exactly once', () => {
  const env = harness();
  const { token } = env.store.mint();

  assert.deepEqual(env.store.consume(token), { ok: true });
  // Second visit must be refused: the page carries credentials and the URL may have been forwarded.
  assert.deepEqual(env.store.consume(token), { ok: false, reason: 'used' });
});

test('an expired token is refused, and says so', () => {
  const env = harness();
  const { token, expiresAt } = env.store.mint();

  env.setTime(expiresAt);
  assert.deepEqual(env.store.consume(token), { ok: false, reason: 'expired' });

  // "expired" and "unknown" are different messages on purpose: one tells the reader to ask for a new link, the
  // other tells them they mistyped something.
  assert.match(renderJoinErrorPage('expired'), /过期/);
  assert.match(renderJoinErrorPage('unknown'), /无效/);
});

test('an unknown token is refused', () => {
  const env = harness();
  assert.deepEqual(env.store.consume('never-issued'), { ok: false, reason: 'unknown' });
});

test('sweep drops expired tokens without touching live ones', () => {
  const env = harness();
  const first = env.store.mint();
  env.advance(JOIN_TOKEN_TTL_MS - 1);
  const second = env.store.mint();

  env.advance(2);
  env.store.sweep();

  assert.deepEqual(env.store.consume(first.token), { ok: false, reason: 'unknown' }, 'swept entries look unknown');
  assert.deepEqual(env.store.consume(second.token), { ok: true }, 'a live token survives a sweep');
});

test('the instruction carries every value the assistant needs', () => {
  const text = buildJoinInstruction(VALUES);

  // Only the values the assistant actually WRITES belong in the instruction. publicUrl and serverToken were for the
  // optional `server:` block, which is no longer part of the core instruction (see the "进阶" section on the page) —
  // so asserting them here would re-claim the bug this change removes.
  for (const value of [VALUES.groupName, VALUES.groupId, VALUES.gatewayBase, VALUES.agentName, VALUES.apiKey]) {
    assert.ok(text.includes(value), `the instruction must name ${value}`);
  }
  assert.ok(!/\{groupName\}|\{apiKey\}|\{agentName\}/u.test(text), 'no placeholder may survive');
});

test('the instruction omits the optional server block', () => {
  const text = buildJoinInstruction(VALUES);
  // Joining a group must not ask a newcomer to expose themselves as an A2A server; that is an optional advanced step.
  assert.ok(!/server:\s*\n\s*enabled: true/.test(text), 'the core instruction must not carry a server block');
  assert.ok(!text.includes('serverToken'), 'and must not mention the server token');
});

test('the instruction asks for a diff before writing', () => {
  const text = buildJoinInstruction(VALUES);

  // This is the difference between a helpful paragraph and a phishing attempt. Both ask an assistant to modify a
  // config file; only one says "tell me first".
  assert.match(text, /先给我看改动|先给我看|确认后再写/u, 'it must ask the assistant to show the change first');
  assert.match(text, /bundles/u, 'it must mention the bundle registration step, or the UI stays empty');
});

test('the page renders the instruction and says it is one-time', () => {
  const html = renderJoinPage({ ...VALUES, expiresAt: Date.now() + 10 * 60 * 1000 });

  assert.match(html, /发票重构/u);
  assert.match(html, /一次有效|作废/u);
  assert.ok(html.includes('sk-test'), 'the page must show the key it is asking the reader to paste');
  // The warning about modifying files has to be on the page, not only in the pasted text.
  assert.match(html, /改你机器上的配置文件/u);
});

test('a group name cannot break out of the HTML', () => {
  const html = renderJoinPage({
    ...VALUES,
    groupName: '<script>alert(1)</script>',
    expiresAt: Date.now() + 60_000,
  });

  assert.ok(!html.includes('<script>alert(1)</script>'), 'the name must be escaped');
  assert.ok(html.includes('&lt;script&gt;'), 'it must appear escaped');
});

test('the instruction never contains a raw placeholder when a value is empty', () => {
  // A field the host could not fill must read as empty, not as `{apiKey}` — a literal placeholder pasted into a
  // YAML file is a parse error the reader will not connect to this page.
  const text = buildJoinInstruction({ ...VALUES, apiKey: '' });
  assert.ok(!text.includes('{apiKey}'), 'an empty value must not leave the placeholder behind');
});
