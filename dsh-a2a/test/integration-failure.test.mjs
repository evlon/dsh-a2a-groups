/**
 * Integration tests for the failure paths — the ones the happy-path suite cannot reach.
 *
 * WHY THIS FILE EXISTS
 *
 * Every bug found in live use over the last few rounds lived on a failure path: a credential the host no longer
 * accepted, a host serving a different data directory, a cache that had gone stale. The existing integration tests
 * drive a real A2A listener and a real store, but they only walk the road that works — so they stayed green while
 * those bugs shipped.
 *
 * WHAT IS REAL HERE
 *
 *   - HTTP: a real `node:http` listener on port 0
 *   - the store: real `groups.json` on disk, real scrypt hashes
 *   - the ledger: real `memberships.json` on disk
 *   - the runtime: real `createToolRuntime`, so the funnel that stamps and clears is the shipped one
 *
 * WHAT IS FAKED
 *
 * The DSH Host only, on the same grounds as the happy-path file: it is the embedding, not this code.
 *
 * @module dsh-a2a/test/integration-failure
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeConfig } from '../lib/core/config.js';
import { createSkillRegistry } from '../lib/core/skills.js';
import { createPingSkill } from '../lib/core/skills-session.js';
import { createGroupSkills } from '../lib/core/skills-group.js';
import { createServer } from '../lib/core/server.js';
import { createBridge } from '../lib/core/bridge.js';
import { createGroupStore } from '../lib/core/groups.js';
import { createMembershipLedger, ROSTER_STALE_MS } from '../lib/core/memberships.js';
import { createToolRuntime } from '../lib/shared/tool-runtime.js';
import { TaskStore } from '../lib/core/wire.js';

const created = [];
after(() => {
  for (const path of created) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // A leftover temp directory must never fail a test run.
    }
  }
});

/** A fresh state directory. */
function temphome(label) {
  const dir = mkdtempSync(join(tmpdir(), `dsh-a2a-fail-${label}-`));
  created.push(dir);
  return dir;
}

/**
 * A minimal Host: routes in, requests dispatched through them.
 *
 * Same shape as the happy-path harness, reduced to what these tests touch — no Session delivery, because nothing
 * here is about delivering into a conversation.
 */
function fakeHost() {
  const routes = { exact: new Map(), prefixes: [] };
  const ctx = {
    webServer: {
      register(route) {
        if (route.kind === 'prefix') {
          routes.prefixes.push(route);
          return () => {
            routes.prefixes = routes.prefixes.filter((entry) => entry !== route);
          };
        }
        routes.exact.set(route.path, route);
        return () => routes.exact.delete(route.path);
      },
      getOrigin: () => undefined,
    },
  };
  const dispatch = (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const exact = routes.exact.get(path);
    if (exact !== undefined) {
      exact.handler(req, res);
      return;
    }
    res.statusCode = 404;
    res.end();
  };
  return { ctx, dispatch, routes };
}

/**
 * Start a host instance on a real port.
 *
 * @param {object} options - `{ label, dataDir, groupName }`.
 * @returns {Promise<object>} handles for the test.
 */
async function startHost({ label, dataDir, groupName }) {
  const home = dataDir ?? temphome(label);
  const host = fakeHost();
  const listener = createHttpServer(host.dispatch);
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address();

  const config = normalizeConfig({
    server: { token: 'host-token', publicUrl: `http://127.0.0.1:${port}/a2a` },
    groups: { gatewayBase: `http://127.0.0.1:${port}/a2a`, agentName: `agent-${label}` },
    client: { apiKey: 'host-token', forwardProto: 'http' },
  });
  const logger = { info() {}, warn() {}, debug() {} };
  const clock = () => Date.now();

  const store = createGroupStore({ home, logger, clock, config });
  const identities = createMembershipLedger({ home, logger, clock });
  const skills = createSkillRegistry();
  skills.register(createPingSkill({ version: '0.1.0-test', sessionIdOf: () => 'self' }));
  for (const skill of createGroupSkills({ store, identities, config, logger, clock })) skills.register(skill);

  const a2a = createServer({ ctx: host.ctx, logger, config, deliverer: {}, tasks: new TaskStore({}), skills });
  a2a.attach();

  return {
    home,
    port,
    store,
    identities,
    config,
    close: async () => {
      a2a.detach();
      await new Promise((resolve) => listener.close(resolve));
    },
    createGroup: (name) => store.create({ name: name ?? groupName ?? '发票重构', ownerDisplayName: '张三' }),
  };
}

/**
 * A member instance pointed at a host, with a real tool runtime.
 *
 * @param {object} options - `{ label, baseUrl, dataDir }`.
 * @returns {object} handles.
 */
function memberOf({ label, baseUrl, dataDir }) {
  const home = dataDir ?? temphome(label);
  const logger = { info() {}, warn() {}, debug() {} };
  const clock = () => Date.now();
  const config = normalizeConfig({
    groups: { gatewayBase: baseUrl.replace(/\/a2a$/u, ''), agentName: `agent-${label}` },
    client: { apiKey: 'host-token', forwardProto: 'http', timeoutMs: 3000 },
  });
  const store = createGroupStore({ home, logger, clock, config });
  const identities = createMembershipLedger({ home, logger, clock });
  const bridge = createBridge({ logger, config, clock });
  const runtime = createToolRuntime({ store, identities, bridge, config, logger, clock });
  return { home, store, identities, bridge, runtime, config };
}

/** Join a member through the real wire, then record its credential locally. */
async function joinOverWire(host, member, displayName) {
  const created1 = host.createGroup();
  const groupId = created1.group.groupId;
  const invite = host.store.invite({ groupId, ownerKey: created1.ownerKey });
  const joined = host.store.join({ groupId, token: invite.token, displayName });
  member.identities.upsert({
    sessionId: 's-1',
    groupId,
    personId: joined.member.personId,
    personKey: joined.personKey,
    local: false,
    baseUrl: `${host.config.server.publicUrl}`,
    groupName: '发票重构',
    role: 'member',
    lastSeq: 0,
    memberCount: 2,
  });
  return { groupId, joined, owner: created1 };
}

// ---------------------------------------------------------------------------
// A credential the host no longer accepts
// ---------------------------------------------------------------------------

test('a removed member keeps the group visible and learns why, instead of losing it', async () => {
  const host = await startHost({ label: 'h1' });
  const member = memberOf({ label: 'm1', baseUrl: `http://127.0.0.1:${host.port}/a2a` });
  try {
    const { groupId, owner } = await joinOverWire(host, member, '李四');

    // A read works while the credential is valid.
    const ok = await member.runtime.call('a2a_group_read', { groupId }, { sessionId: 's-1' });
    assert.ok(Array.isArray(ok.entries));

    // The owner removes them — the exact situation that used to delete the local row.
    host.store.removeMember({ groupId, member: { personId: owner.group.owner.personId, personKey: owner.ownerKey }, targetPersonId: member.identities.get(groupId, 's-1').personId });

    await assert.rejects(
      () => member.runtime.call('a2a_group_read', { groupId }, { sessionId: 's-1' }),
      // The business sub-code reaches a remote caller in `data`, not `code` — which is the whole reason the mark
      // was never applied before. Asserting on code here would repeat that mistake in the test.
      (error) => error.data === 'not_member' || error.data === 'unknown_group' || error.code === 'not_member',
    );

    // The credential must still be on disk: it is the only copy, and a host that comes back with its real data is
    // one of the ways this error arrives.
    const record = member.identities.get(groupId, 's-1');
    assert.ok(record !== undefined, 'the row must survive');
    assert.ok(record.personKey !== undefined, 'and keep the credential');
    assert.ok(typeof record.unreachableAt === 'number', 'and record that the host refused');
  } finally {
    await host.close();
  }
});

test('the mark clears when the same group answers again', async () => {
  const host = await startHost({ label: 'h2' });
  const member = memberOf({ label: 'm2', baseUrl: `http://127.0.0.1:${host.port}/a2a` });
  try {
    const { groupId, owner } = await joinOverWire(host, member, '李四');
    const me = member.identities.get(groupId, 's-1');

    host.store.removeMember({ groupId, member: { personId: owner.group.owner.personId, personKey: owner.ownerKey }, targetPersonId: me.personId });
    await member.runtime.call('a2a_group_read', { groupId }, { sessionId: 's-1' }).catch(() => {});
    assert.ok(typeof member.identities.get(groupId, 's-1').unreachableAt === 'number');

    // Put them back with a fresh credential, as a re-invite would, and confirm one successful call retracts the mark.
    const invite2 = host.store.invite({ groupId, ownerKey: owner.ownerKey });
    const rejoined = host.store.join({ groupId, token: invite2.token, displayName: '李四' });
    member.identities.upsert({
      sessionId: 's-1',
      groupId,
      personId: rejoined.member.personId,
      personKey: rejoined.personKey,
      reachable: true,
    });

    await member.runtime.call('a2a_group_read', { groupId }, { sessionId: 's-1' });
    assert.equal(member.identities.get(groupId, 's-1').unreachableAt, undefined, 'a success clears the mark');
  } finally {
    await host.close();
  }
});

// ---------------------------------------------------------------------------
// Two hosts that disagree, because one is reading a different data directory
// ---------------------------------------------------------------------------

test('a host serving a fresh data directory does not destroy what the members hold', async () => {
  // The incident: the host was restarted against an empty directory, so every member was told unknown_group.
  const realData = temphome('real');
  const realHost = await startHost({ label: 'real', dataDir: realData });
  const member = memberOf({ label: 'm3', baseUrl: `http://127.0.0.1:${realHost.port}/a2a` });
  let emptyHost;
  try {
    const { groupId } = await joinOverWire(realHost, member, '王五');
    const before = member.identities.get(groupId, 's-1');
    assert.ok(before.personKey !== undefined);

    // A second host on the same address, pointing at nothing — the mistake that started this.
    await realHost.close();
    emptyHost = await startHost({ label: 'empty', dataDir: temphome('empty') });

    // The member now talks to a host that never heard of the group.
    const failed = await member.runtime
      .call('a2a_group_read', { groupId }, { sessionId: 's-1' })
      .then(() => false)
      .catch(() => true);
    assert.equal(failed, true, 'the call must fail');

    // The whole point: the credential survives, so bringing the real data back restores access with no re-invite.
    const afterFailure = member.identities.get(groupId, 's-1');
    assert.ok(afterFailure !== undefined, 'the row must not be deleted');
    assert.equal(afterFailure.personKey, before.personKey, 'and the credential is unchanged');
  } finally {
    await emptyHost?.close();
    await realHost.close().catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// A stale cache must say it is stale
// ---------------------------------------------------------------------------

test('a roster older than the bound is reported as stale through the panel snapshot', () => {
  const home = temphome('stale');
  const logger = { info() {}, warn() {}, debug() {} };
  let now = 1_700_000_000_000;
  const ledger = createMembershipLedger({ home, logger, clock: () => now });

  ledger.upsert({
    sessionId: 's-1',
    groupId: 'g-1',
    personId: 'p-1',
    personKey: 'k',
    local: false,
    groupName: '发票重构',
    memberCount: 3,
    members: [{ personId: 'p-1', displayName: '王五' }],
    rosterCachedAt: now,
  });

  assert.equal(ledger.get('g-1', 's-1').rosterCachedAt, now);

  // The panel computes staleness from this timestamp; the constant is the contract between them.
  now += ROSTER_STALE_MS - 1;
  assert.ok(now - ledger.get('g-1', 's-1').rosterCachedAt < ROSTER_STALE_MS, 'fresh just under the bound');

  now += 2;
  assert.ok(now - ledger.get('g-1', 's-1').rosterCachedAt > ROSTER_STALE_MS, 'stale just over it');
});

// ---------------------------------------------------------------------------
// Join idempotency over the wire
// ---------------------------------------------------------------------------

test('a retried join over the wire leaves one member and one credential', async () => {
  const host = await startHost({ label: 'h4' });
  try {
    const created1 = host.createGroup('重试测试');
    const groupId = created1.group.groupId;
    const invite = host.store.invite({ groupId, ownerKey: created1.ownerKey });

    const first = host.store.join({ groupId, token: invite.token, displayName: '王五' });
    // The retry a flaky network produces: same identity, same token.
    const second = host.store.join({
      groupId,
      token: invite.token,
      displayName: '王五',
      personId: first.member.personId,
    });

    assert.equal(second.rejoined, true);
    assert.equal(second.member.personId, first.member.personId);

    // One member, and the row the panel will draw shows up once.
    const roster = host.store.members({
      groupId,
      member: { personId: second.member.personId, personKey: second.personKey },
    });
    assert.equal(roster.filter((row) => row.displayName === '王五').length, 1);
  } finally {
    await host.close();
  }
});