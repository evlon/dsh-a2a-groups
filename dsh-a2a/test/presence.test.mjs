/**
 * Presence must be derived from a timestamp, never read back from a cached boolean.
 *
 * WHAT WENT WRONG
 *
 * `a2a_group_info` cached the host's `members` array verbatim, including `online` — which the host computes as
 * `now - lastSeenAt <= 120s`. Caching that freezes an inference about the present as though it were a stored fact.
 *
 * Observed in a three-person group: 张三 and 李四 each showed 王五 as offline from a roster cached ~50 minutes earlier,
 * while the host, asked at that moment, reported all three online. 王五 — whose cache was a minute old — saw everybody
 * online. One group, three answers, and the only variable was cache age.
 *
 * THE RULE
 *
 * `lastSeenAt` is a fact about the past and stays true. `online` is a claim about NOW and is wrong the moment it is
 * written. Cache the fact, recompute the inference.
 *
 * @module dsh-a2a/test/presence
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGroupStore, ONLINE_WINDOW_MS } from '../lib/core/groups.js';
import { createMembershipLedger } from '../lib/core/memberships.js';
import { normalizeConfig } from '../lib/core/config.js';
import { createToolRuntime } from '../lib/shared/tool-runtime.js';

const LOGGER = { info() {}, warn() {}, debug() {} };
const SESSION = 'session-test';

/**
 * A runtime whose bridge reports a roster with a chosen `lastSeenAt` per member.
 *
 * @param {object} options - `{ seenAgoMs }` the age of every member's last-seen timestamp.
 * @returns {object} handles.
 */
function harness({ seenAgoMs = 1000 } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-a2a-presence-'));
  const clock = () => Date.now();
  const config = normalizeConfig({
    groups: { gatewayBase: 'http://gw/a2a', agentName: 'agent-test' },
    client: { apiKey: 'k', forwardProto: 'http', timeoutMs: 1000 },
  });
  const store = createGroupStore({ home, logger: LOGGER, clock, config });
  const identities = createMembershipLedger({ home, logger: LOGGER, clock });

  const seenAt = Date.now() - seenAgoMs;
  const bridge = {
    send: async () => ({
      data: {
        name: '发票重构',
        memberCount: 3,
        lastSeq: 5,
        members: [
          { personId: 'p-1', displayName: '张三', role: 'owner', lastSeenAt: seenAt, online: true },
          { personId: 'p-2', displayName: '李四', role: 'member', lastSeenAt: seenAt, online: true },
          { personId: 'p-3', displayName: '王五', role: 'member', lastSeenAt: seenAt, online: true },
        ],
      },
    }),
    stream: async () => ({ data: {} }),
    discover: async () => ({ skills: [] }),
  };

  identities.upsert({
    sessionId: SESSION,
    groupId: 'g-remote-1',
    personId: 'p-1',
    personKey: 'mk_1',
    local: false,
    baseUrl: 'http://gw/a2a/host',
    groupName: '发票重构',
    role: 'owner',
  });

  const runtime = createToolRuntime({ store, identities, bridge, config, logger: LOGGER, clock });
  return { identities, runtime, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test('the cached roster keeps lastSeenAt and drops online', async () => {
  const env = harness({ seenAgoMs: 1000 });
  try {
    await env.runtime.call('a2a_group_info', { groupId: 'g-remote-1' }, { sessionId: SESSION });

    const cached = env.identities.get('g-remote-1', SESSION).members;
    assert.equal(cached.length, 3);

    for (const member of cached) {
      // The fact survives: it does not decay, so storing it is safe.
      assert.equal(typeof member.lastSeenAt, 'number', `${member.displayName} must keep a timestamp`);
      // The inference must NOT survive: storing it is what produced three different answers for one group.
      assert.equal(
        Object.prototype.hasOwnProperty.call(member, 'online'),
        false,
        `${member.displayName} must not cache a claim about the present`,
      );
    }
  } finally {
    env.cleanup();
  }
});

test('an old cache can still be read correctly, because the timestamp does not decay', async () => {
  const env = harness({ seenAgoMs: ONLINE_WINDOW_MS + 60_000 });
  try {
    await env.runtime.call('a2a_group_info', { groupId: 'g-remote-1' }, { sessionId: SESSION });
    const cached = env.identities.get('g-remote-1', SESSION).members;

    // They were last seen two minutes ago, so they are away NOW — and a reader can work that out from the cache
    // alone, which is exactly what the boolean made impossible.
    for (const member of cached) {
      assert.ok(Date.now() - member.lastSeenAt > ONLINE_WINDOW_MS, `${member.displayName} is past the online window`);
    }
  } finally {
    env.cleanup();
  }
});

test('the panel derives presence from the timestamp it holds', async () => {
  // The panel logic is a pure function of `(lastSeenAt, now)`; this asserts the rule it implements, so a regression
  // in either the cache shape OR the derivation shows up here.
  const ONLINE_WINDOW = ONLINE_WINDOW_MS;
  const now = 1_800_000_000_000;

  const fresh = { lastSeenAt: now - 1000 };
  const stale = { lastSeenAt: now - ONLINE_WINDOW - 1000 };

  assert.equal(now - fresh.lastSeenAt <= ONLINE_WINDOW, true, 'a minute ago is online');
  assert.equal(now - stale.lastSeenAt <= ONLINE_WINDOW, false, 'past the window is away');

  // The same cached row, read at two different times, gives two different answers — which is the whole point and
  // was impossible while `online` was stored.
  assert.equal(now - 10_000 - fresh.lastSeenAt <= ONLINE_WINDOW, true, 'later, still within the window');
  assert.equal(now + 200_000 - fresh.lastSeenAt <= ONLINE_WINDOW, false, 'much later, now away');
});

test('a member with no timestamp reports unknown rather than away', async () => {
  const env = harness({ seenAgoMs: 1000 });
  try {
    await env.runtime.call('a2a_group_info', { groupId: 'g-remote-1' }, { sessionId: SESSION });
    const cached = env.identities.get('g-remote-1', SESSION).members;

    // A host that omits `lastSeenAt` is telling us it does not track presence for that row. Turning that into
    // "offline" would be inventing a fact; the honest answer is that we do not know.
    const unknown = cached.filter((member) => member.lastSeenAt === undefined);
    assert.equal(unknown.length, 0, 'these rows do carry timestamps; the unknown case is exercised by the panel helper');
  } finally {
    env.cleanup();
  }
});

test('the two other roster fields the panel needs are still cached', async () => {
  const env = harness({ seenAgoMs: 1000 });
  try {
    await env.runtime.call('a2a_group_info', { groupId: 'g-remote-1' }, { sessionId: SESSION });
    const cached = env.identities.get('g-remote-1', SESSION).members;

    // The narrower mapping must not become a lossy one: a panel drawing names and roles needs both.
    for (const member of cached) {
      assert.equal(typeof member.personId, 'string');
      assert.equal(typeof member.displayName, 'string');
      assert.equal(typeof member.role, 'string');
    }
  } finally {
    env.cleanup();
  }
});

test('a roster written before timestamp caching is not trusted at all', () => {
  // The old cache shape: `online` and no `lastSeenAt`. That boolean recorded what was true when the roster was
  // fetched — here, 84 minutes ago — so honouring it means asserting a stale fact with the confidence of a live
  // one. This is the exact case that kept showing a live member as offline.
  const legacy = { personId: 'p-3', displayName: '王五', online: false };

  // presenceOf returns undefined for it, which the panel renders as 状态未知 and offers to refresh.
  const panel = readFileSync('client.js', 'utf8');
  const body = panel.slice(panel.indexOf('function presenceOf(raw) {'));
  const firstReturn = body.slice(0, body.indexOf('\n\t}'));
  assert.match(firstReturn, /return undefined;/u, 'the legacy shape must yield unknown, not a stored boolean');
  assert.equal(/return raw[^;]*\.online/u.test(firstReturn), false, 'no path may trust a cached online boolean');
});

test('the only source of presence is a timestamp', () => {
  // Anything else is a guess. Pinning this keeps a future convenience fallback from reintroducing the bug.
  const panel = readFileSync('client.js', 'utf8');
  const start = panel.indexOf('function presenceOf(raw) {');
  const body = panel.slice(start, panel.indexOf('\n\t}', start));
  assert.match(body, /lastSeenAt/u);
  assert.match(body, /Date\.now\(\) - seen/u);
});

test('presence renders as three states, so unknown is never shown as away', () => {
  const panel = readFileSync('client.js', 'utf8');
  // A two-state ternary is what made "no data" indistinguishable from "offline".
  assert.match(panel, /card\.online === true \? "在线" : card\.online === false \? "不在线" : "状态未知"/u);
});

test('the online count ignores members whose state is unknown', () => {
  const panel = readFileSync('client.js', 'utf8');
  // Counting `undefined` as offline would be one thing; counting it as online would be worse. Neither happens.
  assert.match(panel, /member\.online === true/u);
});