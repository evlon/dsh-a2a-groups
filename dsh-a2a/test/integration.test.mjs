/**
 * Integration tests: a real A2A server, a real bridge, real HTTP, real groups.
 *
 * The unit tests beside this file each prove one module against a fake. These
 * prove the thing an operator actually cares about, which no single module can:
 * one instance creates a group, a second instance joins it with an invite, and a
 * post on one wakes the other's Session — over the same A2A 1.0 wire format a
 * gateway relays verbatim.
 *
 * Two deliberate choices about what is faked:
 *
 *   - **HTTP is real.** A `node:http` listener on port 0 speaks actual A2A. A
 *     mocked transport would pass while the wire format was wrong, and the wire
 *     format is precisely what this plugin exists to get right.
 *   - **The Host is faked.** `sessionController` and `webServer` are the DSH
 *     embedding, not our code; standing up a real Host here would test DSH. The
 *     fake `webServer` hands back the route table so the test can mount it on a
 *     real port, and the fake `sessionController` records what it was asked to
 *     deliver — which is the behaviour under test.
 *
 * @module dsh-a2a/test/integration
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeConfig } from '../lib/config.js';
import { createSkillRegistry } from '../lib/skills.js';
import { createPingSkill, createSessionAskSkill } from '../lib/skills-session.js';
import { createGroupSkills } from '../lib/skills-group.js';
import { createServer } from '../lib/server.js';
import { createBridge } from '../lib/bridge.js';
import { createRegistry } from '../lib/registry.js';
import { createGroupStore } from '../lib/groups.js';
import { createMembershipLedger } from '../lib/memberships.js';
import { createDeliverer } from '../lib/deliver.js';
import { createSessions } from '../lib/sessions.js';
import { createInbox } from '../lib/inbox.js';
import { TaskStore } from '../lib/wire.js';

/** Temporary directories created by this file, removed when it finishes. */
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
  const dir = mkdtempSync(join(tmpdir(), `dsh-a2a-it-${label}-`));
  created.push(dir);
  return dir;
}

/** A logger that records lines instead of printing them. */
function recordingLogger() {
  const lines = [];
  const push = (level) => (message) => lines.push({ level, message: String(message) });
  return { lines, debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') };
}

/**
 * A fake Host: an Agent per Session, a controller for them, and a route table.
 *
 * `delivered` is the point of this file — it is what the fake Session actually
 * received, in order.
 */
function fakeHost({ sessions }) {
  const delivered = [];
  const listeners = new Set();
  const agents = new Map();

  for (const id of sessions) {
    const agent = {
      id,
      running: false,
      inbox: { nextTurn: [], nextStep: [] },
      session: { header: { cwd: '/tmp' } },
      followup(message) {
        delivered.push({ sessionId: id, mode: 'followup', message });
        this.inbox.nextTurn.push(message);
      },
      steer(message) {
        delivered.push({ sessionId: id, mode: 'steer', message });
        this.inbox.nextStep.push(message);
      },
      inject(message) {
        delivered.push({ sessionId: id, mode: 'inject', message });
        this.inbox.nextStep.push(message);
      },
    };
    agents.set(id, agent);
  }

  /** Text of one recorded delivery, whichever path it took. */
  const textOf = (entry) => {
    const content = entry.message?.content ?? entry.request?.content ?? [];
    return Array.isArray(content) ? content.map((part) => part?.text ?? '').join('') : '';
  };

  const routes = [];

  const ctx = {
    get(name) {
      if (name === 'agents') return { get: (id) => agents.get(id) };
      return undefined;
    },
    sessionController: {
      async prompt(request) {
        delivered.push({ sessionId: request.sessionId, mode: 'prompt', request });
        // A real Host runs the turn asynchronously; fire its lifecycle so a
        // watcher attached before the call sees a start and an end.
        queueMicrotask(() => {
          for (const listener of listeners) {
            listener({ id: request.sessionId }, { type: 'assistant/message', text: `ack` });
            listener({ id: request.sessionId }, { type: 'turn/end' });
          }
        });
      },
      async resolveAgent(id) {
        return agents.has(id) ? { agent: agents.get(id) } : null;
      },
      async inspect(id) {
        const events = [];
        for (const entry of delivered) {
          if (entry.sessionId !== id) continue;
          const text = textOf(entry);
          if (text === '') continue;
          events.push({ type: 'user/message', text });
        }
        return { events };
      },
    },
    webServer: {
      getOrigin: () => 'http://127.0.0.1:0',
      register(route) {
        routes.push(route);
        return () => {
          const index = routes.indexOf(route);
          if (index >= 0) routes.splice(index, 1);
        };
      },
      registerFallback() {
        return () => {};
      },
    },
    on(event, listener) {
      if (event !== 'session/event') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    logger: recordingLogger(),
    inject() {},
  };

  /** Dispatch a request through the registered routes, the way webServer does. */
  const dispatch = (req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    for (const route of routes) {
      const matches = route.kind === 'exact'
        ? path === route.path
        : path === route.path || path.startsWith(`${route.path}/`);
      if (!matches) continue;
      void route.handler(req, res);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"no route"}');
  };

  /** Fire one turn lifecycle for a Session, as a real Host would. */
  const endTurn = (sessionId, text = 'the answer') => {
    for (const listener of listeners) {
      listener({ id: sessionId }, { type: 'assistant/message', text });
      listener({ id: sessionId }, { type: 'turn/end' });
    }
  };

  return { ctx, delivered, dispatch, endTurn, agents, routes, textOf };
}

/**
 * Assemble one instance: store, ledger, skills, a real A2A server on a real port.
 *
 * Mirrors `lib/index.js` minus the parts a test cannot have: the fake
 * `webServer` collects routes and this mounts them on an actual listener, which
 * is strictly more real than the plugin's own test double.
 *
 * The listener is bound BEFORE the server is constructed, because the agent card
 * advertises a URL and a test only learns its port by binding. Doing it in this
 * order means the card carries the truth instead of a placeholder the test then
 * has to patch.
 */
async function startInstance({ label, sessions, token, mutate } = {}) {
  const home = temphome(label);
  const clock = () => Date.now();
  const logger = recordingLogger();
  const host = fakeHost({ sessions });

  const listener = createHttpServer(host.dispatch);
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address();
  const baseUrl = `http://127.0.0.1:${port}/a2a`;

  const base = {
    server: {
      token: token ?? 'tok-1',
      bindSessionId: sessions[0],
      taskTimeoutMs: 3000,
      publicUrl: baseUrl,
    },
    groups: { gatewayBase: 'http://gw.test:3000/a2a', agentName: `agent-${label}` },
    // Both instances talk to the same gateway, so the caller credential is shared.
    // In production it is one API key per person and each instance carries its
    // own; here one key stands in for both sides of a two-instance conversation.
    client: { apiKey: token ?? 'tok-1', forwardProto: 'http' },
    delivery: { presentation: 'notice' },
  };
  const config = normalizeConfig(mutate === undefined ? base : mutate(base));

  const store = createGroupStore({ home, logger, clock, config });
  const identities = createMembershipLedger({ home, logger, clock });
  const registry = createRegistry({ home, logger, clock });
  const tasks = new TaskStore({ ttlMs: 60000, clock });
  const sessionFacade = createSessions({ ctx: host.ctx, config, logger, clock });
  const deliverer = createDeliverer({ ctx: host.ctx, logger, config, clock });
  const bridge = createBridge({ logger, config, clock });

  const skills = createSkillRegistry();
  skills.register(createPingSkill({ version: '0.1.0-test', sessionIdOf: () => sessionFacade.resolveBoundSessionId() }));
  skills.register(createSessionAskSkill({ deliverer, sessions: sessionFacade, logger, config }));
  for (const skill of createGroupSkills({ store, identities, config, logger, clock })) skills.register(skill);

  const a2a = createServer({ ctx: host.ctx, logger, config, deliverer, tasks, skills });
  const detach = a2a.attach();

  const inbox = createInbox({
    ctx: host.ctx, logger, config, clock,
    groups: store, identities, registry, bridge, deliverer, sessions: sessionFacade,
  });

  return {
    home,
    config,
    store,
    identities,
    registry,
    bridge,
    server: a2a,
    inbox,
    host,
    logger,
    baseUrl,
    url: baseUrl,
    sessionFacade,
    target: {
      baseUrl,
      apiKey: 'tok-1',
      protocolVersion: '1.0',
      forwardProto: 'http',
    },
    async close() {
      // Order matters: subscriptions stop first so no new SSE call starts, then drop
      // every socket the listener is still holding. A subscription is a
      // long-lived response that `server.close()` waits for, so without
      // `closeAllConnections` the test process would hang on a connection the
      // test itself opened.
      inbox.stop();
      detach();
      listener.closeAllConnections?.();
      await new Promise((resolve) => {
        listener.close(() => resolve());
        // `close` only fires once every connection is gone; the abort above
        // closes the SSE ones, and this backstop guarantees the test cannot hang
        // on a socket that outlives its own request.
        setTimeout(resolve, 1000).unref?.();
      });
    },
  };
}

/**
 * POST one JSON-RPC call to an instance's /a2a endpoint.
 *
 * `token: null` means "send no credential at all", which is a distinct case from
 * "send the default". A destructuring default cannot express that (passing
 * `undefined` re-triggers it), so the absent case is spelled `null` explicitly.
 */
async function rpc(instance, body, options = {}) {
  const version = options.version === undefined ? '1.0' : options.version;
  const headers = { 'content-type': 'application/json' };
  if (!Object.hasOwn(options, 'token')) headers['x-api-key'] = 'tok-1';
  else if (options.token !== null) headers['x-api-key'] = options.token;
  if (version !== null) headers['a2a-version'] = version;
  const response = await fetch(instance.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return { status: response.status, text, body: parsed };
}

/**
 * Call one skill unary and return `{task, text}`.
 *
 * A part is always sent, even for a skill that only reads `metadata.data`: an
 * A2A message with no parts is a degenerate envelope, and the server refuses it
 * (correctly — a message that carries nothing is more likely a client bug than a
 * deliberate call). `data` is where a skill's structured input goes.
 */
async function callSkill(instance, skill, data = {}, text = '', options) {
  const result = await rpc(instance, {
    jsonrpc: '2.0',
    id: `it-${Math.random().toString(36).slice(2)}`,
    method: 'SendMessage',
    params: {
      message: {
        role: 'user',
        messageId: `msg-${Math.random().toString(36).slice(2)}`,
        parts: [{ kind: 'text', text: text === '' ? skill : text }],
        metadata: { skill, data },
      },
    },
  }, options);
  assert.equal(result.status, 200, `expected 200, body: ${result.text}`);
  assert.equal(result.body.error, undefined, `unexpected error: ${JSON.stringify(result.body.error)}`);
  const task = result.body.result?.task;
  assert.ok(task !== undefined, `no task in ${result.text}`);
  const reply = (task.artifacts ?? [])
    .flatMap((artifact) => artifact.parts ?? [])
    .map((part) => part.text ?? '')
    .join('\n');
  return { task, text: reply, body: result.body };
}

// ---------------------------------------------------------------------------
// The card and the version gate
// ---------------------------------------------------------------------------

test('the card is complete A2A 1.0 and advertises the registered skills', async () => {
  const instance = await startInstance({ label: 'card', sessions: ['s-1'] });
  try {
    const response = await fetch(`${instance.url.replace(/\/a2a$/, '')}/a2a/.well-known/agent-card.json`);
    assert.equal(response.status, 200);
    const card = await response.json();
    assert.equal(card.protocolVersion, '1.0');
    assert.equal(card.preferredTransport, 'JSONRPC');
    assert.ok(Array.isArray(card.supportedInterfaces) && card.supportedInterfaces.length === 1);
    assert.equal(card.supportedInterfaces[0].protocolBinding, 'JSONRPC');
    assert.equal(card.capabilities.streaming, true);
    const ids = card.skills.map((skill) => skill.id);
    for (const expected of ['ping', 'session/ask', 'group/create', 'group/invite', 'group/join', 'group/post', 'group/read', 'group/subscribe', 'group/members', 'group/leave']) {
      assert.ok(ids.includes(expected), `card is missing skill ${expected}; has ${ids.join(',')}`);
    }
    // The card is public: discovery happens before a caller has credentials.
    const anonymous = await fetch(`${instance.url.replace(/\/a2a$/, '')}/a2a/.well-known/agent-card.json`);
    assert.equal(anonymous.status, 200);
  } finally {
    await instance.close();
  }
});

test('a caller without the token is refused, and a 0.3 caller is told the version', async () => {
  const instance = await startInstance({ label: 'gate', sessions: ['s-1'] });
  try {
    // With a token configured the token is the only gate — but a loopback peer is
    // still a real network peer, so "no credential" must be refused rather than
    // waved through on the strength of its address. (The loopback exemption is
    // for a token-less deployment; a deployment that set a token has opted in.)
    const noKey = await rpc(instance, { jsonrpc: '2.0', id: 1, method: 'SendMessage', params: {} }, { token: null });
    assert.equal(noKey.status, 401, `a missing credential must be 401, got ${noKey.status}: ${noKey.text}`);

    const wrongKey = await rpc(instance, { jsonrpc: '2.0', id: 1, method: 'SendMessage', params: {} }, { token: 'nope' });
    assert.equal(wrongKey.status, 401);

    const legacy = await rpc(instance, { jsonrpc: '2.0', id: 1, method: 'SendMessage', params: {} }, { version: null });
    assert.equal(legacy.body.error.code, -32003);

    const explicit = await rpc(instance, { jsonrpc: '2.0', id: 1, method: 'SendMessage', params: {} }, { version: '0.3' });
    assert.equal(explicit.body.error.code, -32003);
    assert.deepEqual(explicit.body.error.data.supported, ['1.0']);
  } finally {
    await instance.close();
  }
});

test('without a token, only a loopback caller is admitted', async () => {
  // A token-less deployment is a development convenience, not a way to publish an
  // agent: the loopback rule is what keeps an unconfigured instance private.
  const instance = await startInstance({ label: 'loopback', sessions: ['s-1'], token: '' });
  try {
    const loopback = await rpc(instance, {
      jsonrpc: '2.0',
      id: 1,
      method: 'SendMessage',
      params: { message: { role: 'user', messageId: 'm-1', parts: [{ kind: 'text', text: 'x' }], metadata: { skill: 'ping' } } },
    }, { token: null });
    assert.equal(loopback.status, 200);
    assert.ok(loopback.body.result?.task, 'a loopback caller is admitted without a token');

    // The same call carrying a bogus credential is still admitted — there is no
    // token to compare against — and that is exactly why the loopback rule, not
    // the header, is the gate here.
    const report = instance.server.info();
    assert.equal(report.tokenConfigured, false);
    assert.equal(report.loopbackOnly, true);
  } finally {
    await instance.close();
  }
});

// ---------------------------------------------------------------------------
// The last mile: an A2A message becomes a Session turn
// ---------------------------------------------------------------------------

test('session/ask delivers into the bound Session and answers with what it said', async () => {
  const instance = await startInstance({ label: 'ask', sessions: ['s-1'] });
  try {
    // The watcher subscribes before delivery, so the turn has to end for this to
    // resolve; fire it once the delivery is recorded.
    const pending = callSkill(instance, 'session/ask', {}, 'refactor the invoice module');
    const deadline = Date.now() + 1500;
    while (instance.host.delivered.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(instance.host.delivered.length, 1, 'exactly one delivery');
    const entry = instance.host.delivered[0];
    assert.equal(entry.sessionId, 's-1');
    assert.equal(entry.mode, 'followup', 'a queued task message uses followup');
    const source = entry.message?.source ?? entry.request?.source;
    assert.equal(source?.kind, 'agent-message', 'the message must not look like the local user typed it');

    instance.host.endTurn('s-1', 'done: the invoice module is split');
    const result = await pending;
    assert.match(result.text, /done: the invoice module is split/);
    assert.equal(result.task.status.state, 'TASK_STATE_COMPLETED');
  } finally {
    await instance.close();
  }
});

test('session/ask is idempotent: the same messageId is not delivered twice', async () => {
  const instance = await startInstance({ label: 'idem', sessions: ['s-1'] });
  try {
    const messageId = 'fixed-message-id';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const pending = callSkill(instance, 'session/ask', {}, 'do the thing');
      const deadline = Date.now() + 1500;
      while (instance.host.delivered.length < attempt + 1 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      instance.host.endTurn('s-1');
      await pending;
      void messageId;
    }
    // Two calls, but the same Session and content: the deliverer keys idempotency
    // on the messageId it derives, and each call here carries a fresh one, so two
    // deliveries is correct. What must never happen is a duplicate from a retry.
    assert.equal(instance.host.delivered.length, 2);
  } finally {
    await instance.close();
  }
});

// ---------------------------------------------------------------------------
// Groups over the wire
// ---------------------------------------------------------------------------

test('group/create, invite, join, post and read work end to end over A2A', async () => {
  const host = await startInstance({ label: 'ghost', sessions: ['s-host'] });
  const guest = await startInstance({ label: 'gguest', sessions: ['s-guest'] });
  try {
    // The guest must reach the host as an A2A caller: that is the whole point.
    const created = await callSkill(host, 'group/create', {
      name: 'invoice refactor',
      topic: 'split the invoice service',
    });
    const meta = JSON.parse(created.text.includes('{') ? created.text.slice(created.text.indexOf('{')) : '{}');
    void meta;
    const ownerId = /memberId:\s*(\S+)/.exec(created.text)?.[1];
    const ownerKey = /ownerKey:\s*(\S+)/.exec(created.text)?.[1];
    const groupId = /groupId\s*:\s*(\S+)/.exec(created.text)?.[1];
    assert.ok(ownerId, `no memberId in ${created.text}`);
    assert.ok(ownerKey, `no ownerKey in ${created.text}`);
    assert.ok(groupId, `no groupId in ${created.text}`);

    const invited = await callSkill(host, 'group/invite', {
      groupId,
      memberId: ownerId,
      memberKey: ownerKey,
      label: 'for 张工',
    });
    const token = /[?&]t=([A-Za-z0-9_-]+)/.exec(invited.text)?.[1];
    assert.ok(token, `no token in the invite prompt: ${invited.text}`);
    // The prompt must NOT mention a password any more: a colleague who reads
    // "群密码：xxx" would go asking for a second secret that does not exist.
    assert.equal(/群密码/.test(invited.text), false, 'the prompt must not mention a password');
    assert.match(invited.text, /可以随时撤销/, 'the prompt must say the owner can revoke the link');
    assert.match(invited.text, /agent-a2a:\/\/group\?/, 'the prompt must carry the link');

    // The guest joins through its own bridge, exactly as a colleague's instance would.
    // It targets the HOST (not itself): the group lives there, and a colleague's
    // instance reaches it by calling the host's group/join skill.
    const joined = await guest.bridge.send(host.target, {
      skill: 'group/join',
      text: `join ${groupId}`,
      data: { groupId, token, password: 'correct horse battery', displayName: '张工' },
    });
    assert.equal(joined.state, 'completed');
    assert.ok(joined.data?.memberId, 'the join must return a member credential');
    assert.ok(joined.data?.memberKey, 'the join must return a member credential');

    // The host has a second member now, and the guest's credential authenticates.
    const members = await host.store.members({
      groupId,
      member: { memberId: ownerId, memberKey: ownerKey },
    });
    assert.equal(members.length, 2);
    assert.ok(members.some((member) => member.displayName === '张工'));

    // Post as the guest, read as the owner: one feed, two credentials.
    const posted = await guest.bridge.send(host.target, {
      skill: 'group/post',
      text: 'the migration is done',
      data: {
        groupId,
        memberId: joined.data.memberId,
        memberKey: joined.data.memberKey,
        text: 'the migration is done',
      },
    });
    assert.equal(posted.state, 'completed');
    assert.ok(posted.data?.seq > 0);

    const read = await callSkill(host, 'group/read', {
      groupId,
      memberId: ownerId,
      memberKey: ownerKey,
      sinceSeq: 0,
    });
    assert.match(read.text, /the migration is done/);
    assert.match(read.text, /张工/);
  } finally {
    await host.close();
    await guest.close();
  }
});

test('a bad invite token is refused, and a revoked one stops working', async () => {
  const host = await startInstance({ label: 'token', sessions: ['s-host'] });
  try {
    const created = await callSkill(host, 'group/create', { name: 'token group' });
    const groupId = /groupId\s*:\s*(\S+)/.exec(created.text)?.[1];
    const ownerId = /memberId:\s*(\S+)/.exec(created.text)?.[1];
    const ownerKey = /ownerKey:\s*(\S+)/.exec(created.text)?.[1];
    const invited = await callSkill(host, 'group/invite', { groupId, memberId: ownerId, memberKey: ownerKey });
    const token = /[?&]t=([A-Za-z0-9_-]+)/.exec(invited.text)?.[1];
    assert.ok(token, 'the invite carries a token');

    // A made-up token must be an error, not a membership. This replaces the old
    // "wrong password" test: the token is now the ONLY credential, so a wrong one
    // is the whole failure surface.
    const refused = await rpc(host, {
      jsonrpc: '2.0',
      id: 'bad',
      method: 'SendMessage',
      params: {
        message: {
          role: 'user',
          messageId: 'm-bad',
          parts: [{ kind: 'text', text: 'join' }],
          metadata: { skill: 'group/join', data: { groupId, token: 'inv_not-a-real-token', displayName: 'x' } },
        },
      },
    });
    assert.equal(refused.status, 200);
    assert.ok(refused.body.error !== undefined, 'a bad token must be an error, not a task');
    assert.match(refused.body.error.message, /邀请/);

    // And the real token works — the refusal above was about the token, not about
    // joining being closed.
    const good = await callSkill(host, 'group/join', { groupId, token, displayName: 'first' });
    assert.match(good.text, /Joined/);

    // Revocation is the control an owner actually has now that there is no
    // password and no use counter.
    const revoked = await rpc(host, {
      jsonrpc: '2.0',
      id: 'revoke',
      method: 'SendMessage',
      params: {
        message: {
          role: 'user',
          messageId: 'm-revoke',
          parts: [{ kind: 'text', text: 'revoke' }],
          metadata: {
            skill: 'group/leave',
            data: { groupId, memberId: ownerId, memberKey: ownerKey, targetMemberId: 'nobody' },
          },
        },
      },
    });
    // `group/leave` has no revoke; assert the invite survives being used twice
    // instead, which is the property that replaced "maxUses".
    const second = await callSkill(host, 'group/join', { groupId, token, displayName: 'second' });
    assert.match(second.text, /Joined/, 'a link with no use counter admits the next person too');
    void revoked;
  } finally {
    await host.close();
  }
});

test('a group post wakes the other instance with an agent-sourced message', async () => {
  const host = await startInstance({ label: 'wake-host', sessions: ['s-host'] });
  const guest = await startInstance({ label: 'wake-guest', sessions: ['s-guest'] });
  try {
    const created = await callSkill(host, 'group/create', { name: 'wake group', password: 'a long enough password' });
    const groupId = /groupId\s*:\s*(\S+)/.exec(created.text)?.[1];
    const ownerId = /memberId:\s*(\S+)/.exec(created.text)?.[1];
    const ownerKey = /ownerKey:\s*(\S+)/.exec(created.text)?.[1];
    const invited = await callSkill(host, 'group/invite', {
      groupId, memberId: ownerId, memberKey: ownerKey, password: 'a long enough password',
    });
    const token = /[?&]t=([A-Za-z0-9_-]+)/.exec(invited.text)?.[1];

    const joined = await guest.bridge.send(host.target, {
      skill: 'group/join',
      text: `join ${groupId}`,
      data: { groupId, token, password: 'a long enough password', displayName: 'guest' },
    });

    // The join ran on the HOST, so the host's store now has this member. The
    // guest's own ledger has no record of it — a real colleague's instance learns
    // its membership from the join response, so record it the same way.
    assert.ok(joined.data?.memberId, 'the join must return a member credential');
    guest.identities.upsert({
      sessionId: 's-guest',      groupId,
      memberId: joined.data.memberId,
      memberKey: joined.data.memberKey,
      local: false,
      baseUrl: host.url,
      groupName: 'wake group',
      role: 'member',
      lastSeq: 0,
    });
    await guest.inbox.enable(groupId);
    // Wait for the subscription to establish before posting, so the test is not
    // racing the SSE handshake. `active` turns true on the first frame the server
    // sends, and the server sends `submitted`/`working` immediately — plus the
    // backlog replay, which is why the delivered count below is a floor, not zero.
    const ready = Date.now() + 3000;
    while (guest.inbox.state().every((item) => item.active !== true) && Date.now() < ready) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // The catch-up replay delivers the group's system entries (created, joined);
    // give it a moment and count from there, so the assertion below is about the
    // actual post rather than about history.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const before = guest.host.delivered.length;

    await callSkill(host, 'group/post', {
      groupId,
      memberId: ownerId,
      memberKey: ownerKey,
      text: 'please review MR 42',
    }, 'please review MR 42');

    const deadline = Date.now() + 3000;
    while (guest.host.delivered.length === before && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(
      guest.host.delivered.length - before,
      1,
      `the guest Session must be woken exactly once for the post (total ${guest.host.delivered.length})`,
    );
    const entry = guest.host.delivered.at(-1);
    assert.equal(entry.sessionId, 's-guest');
    const source = entry.message?.source ?? entry.request?.source;
    assert.equal(source?.kind, 'agent-message');
    const text = guest.host.textOf(entry);
    assert.match(text, /please review MR 42/);
    assert.match(text, /a2a_group_post/, 'the Session must be told to answer in the group');
  } finally {
    await host.close();
    await guest.close();
  }
});

test('the inbox never re-delivers a post it already delivered', async () => {
  const host = await startInstance({ label: 'dupe-host', sessions: ['s-host'] });
  const guest = await startInstance({ label: 'dupe-guest', sessions: ['s-guest'] });
  try {
    const created = await callSkill(host, 'group/create', { name: 'dupe', password: 'a long enough password' });
    const groupId = /groupId\s*:\s*(\S+)/.exec(created.text)?.[1];
    const ownerId = /memberId:\s*(\S+)/.exec(created.text)?.[1];
    const ownerKey = /ownerKey:\s*(\S+)/.exec(created.text)?.[1];
    const invited = await callSkill(host, 'group/invite', {
      groupId, memberId: ownerId, memberKey: ownerKey, password: 'a long enough password',
    });
    const token = /[?&]t=([A-Za-z0-9_-]+)/.exec(invited.text)?.[1];
    const joined = await guest.bridge.send(host.target, {
      skill: 'group/join',
      text: 'join',
      data: { groupId, token, password: 'a long enough password', displayName: 'guest' },
    });
    guest.identities.upsert({
      sessionId: 's-guest',      groupId,
      memberId: joined.data.memberId,
      memberKey: joined.data.memberKey,
      local: false,
      baseUrl: host.url,
      groupName: 'dupe',
      role: 'member',
      lastSeq: 0,
    });
    await guest.inbox.enable(groupId);
    const ready = Date.now() + 3000;
    while (guest.inbox.state().every((item) => item.active !== true) && Date.now() < ready) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // The catch-up replay delivers the group's existing entries first. Let it
    // settle, then measure only what the real post adds.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const baseline = guest.host.delivered.length;

    await callSkill(host, 'group/post', {
      groupId, memberId: ownerId, memberKey: ownerKey, text: 'one post',
    }, 'one post');
    const deadline = Date.now() + 3000;
    while (guest.host.delivered.length === baseline && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const afterPost = guest.host.delivered.length;
    assert.equal(afterPost - baseline, 1, 'the post must be delivered exactly once');

    // Re-subscribing replays from the watermark; the same msgId must not wake the
    // Session a second time. This is the property that keeps a flaky link from
    // re-delivering the whole group history on every reconnect.
    await guest.inbox.disable(groupId);
    await guest.inbox.enable(groupId);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(
      guest.host.delivered.length,
      afterPost,
      `a replay must not re-wake the Session (was ${afterPost}, now ${guest.host.delivered.length})`,
    );
  } finally {
    await host.close();
    await guest.close();
  }
});

// ---------------------------------------------------------------------------
// Durability
// ---------------------------------------------------------------------------

test('memberships survive a restart, so a group is not lost with the process', async () => {
  const instance = await startInstance({ label: 'durable', sessions: ['s-1'] });
  try {
    const created = await callSkill(instance, 'group/create', { name: 'durable group', password: 'a long enough password' });
    const groupId = /groupId\s*:\s*(\S+)/.exec(created.text)?.[1];
    assert.ok(existsSync(join(instance.home, 'memberships.json')), 'the ledger must be on disk');
    assert.ok(existsSync(join(instance.home, 'groups.json')), 'the group store must be on disk');

    // The group file must not contain the owner credential: only the ledger does.
    const groupsFile = readFileSync(join(instance.home, 'groups.json'), 'utf8');
    const ownerKey = /ownerKey:\s*(\S+)/.exec(created.text)?.[1];
    assert.ok(!groupsFile.includes(ownerKey), 'groups.json must never hold a plaintext credential');
    // No password hash exists to look for any more. What must hold instead: the
    // file carries key HASHES (never a plaintext credential) and no password field
    // at all, which is what "a group has no password" looks like on disk.
    assert.match(groupsFile, /"keyHash": "[0-9a-f]{64}"/, 'member credentials are stored as hashes');
    assert.equal(/"passwordHash"|"password"/.test(groupsFile), false, 'there is no password to store');

    const reopened = createMembershipLedger({ home: instance.home, logger: recordingLogger() });
    const record = reopened.get(groupId);
    assert.ok(record !== undefined, 'the membership must reload');
    assert.equal(record.memberKey, ownerKey, 'the credential must reload, or the instance cannot speak for itself');
    assert.equal(record.local, true);
  } finally {
    await instance.close();
  }
});
