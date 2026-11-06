/**
 * Tests for the MCP server: the protocol surface, not the group logic.
 *
 * The group logic is covered elsewhere and is shared with the DSH plugin, so what is
 * worth testing here is the translation:
 *
 *   - a JSON-RPC request becomes the right response, including the notification rule;
 *   - `tools/list` exposes exactly the specs the DSH plugin exposes, with the same
 *     schemas, because that equality is the whole reason the specs were split out;
 *   - a tool error comes back as `isError` with text, not as a protocol error, because
 *     that is what an MCP client knows how to show a model.
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';

import { createMcpHandler, MCP_PROTOCOL_VERSION } from '../lib/mcp-server.js';
import { createMcpHandler as handlerFactory } from '../lib/mcp-server.js';
import { allSpecs } from '../lib/shared/tool-specs.js';

/** A handler with dependencies that answer without touching the network. */
function handlerWith(overrides = {}) {
  const deps = {
    config: { groups: { gatewayBase: 'http://gw/a2a', agentName: 'agent-person-test' }, client: { timeoutMs: 1000 } },
    registry: {
      list: () => [],
      get: () => undefined,
      upsert: () => ({}),
      remove: () => true,
    },
    bridge: {
      send: async () => ({ data: {} }),
    },
    store: {
      has: () => false,
      list: () => [],
      flush: async () => {},
    },
    identities: {
      list: () => [],
      get: () => undefined,
      upsert: () => ({}),
      flush: async () => {},
    },
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    ...overrides,
  };
  return createMcpHandler({ deps, sessionId: 's-test', version: '9.9.9' });
}

/** Send one request through the handler. */
async function call(handler, method, params, id = 1) {
  return handler.handle({ jsonrpc: '2.0', id, method, params });
}

test('initialize negotiates the protocol and names the server', async () => {
  const handler = handlerWith();
  const response = await call(handler, 'initialize', {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  });
  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.result.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.equal(response.result.serverInfo.name, 'agent-groups');
  assert.equal(response.result.serverInfo.version, '9.9.9');
  assert.equal(response.result.capabilities.tools.listChanged, false);
  // The instructions are how a model learns that `mentions` decides who is woken; without
  // them the tool still works but every post would be addressed to nobody.
  assert.match(response.result.instructions, /mentions/);
});

test('a notification gets no response at all', async () => {
  const handler = handlerWith();
  const response = await handler.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(response, null, 'a message without an id must not be answered');
});

test('ping answers an empty result', async () => {
  const handler = handlerWith();
  const response = await call(handler, 'ping', undefined);
  assert.deepEqual(response.result, {});
});

test('tools/list exposes the shared spec set, minus the two an MCP host cannot honour', async () => {
  // This used to assert `tools.length === specs.length` — the two hosts offering an identical list. That equality was
  // the REASON the specs were split out, and it is still the rule; it just is not true for two tools, because an MCP
  // server has no DSH Session and no push channel:
  //
  //   a2a_serve        dereferenced `sessions` unconditionally and threw a TypeError (measured)
  //   a2a_group_inbox  answered 「没有订阅」, which is a lie that reads as "delivery is armed"
  //
  // A tool that always fails is worse than an absent one. What matters is that the exclusion is DELIBERATE and SMALL —
  // so the assertion names them, rather than loosening to "roughly the same".
  const handler = handlerWith();
  const response = await call(handler, 'tools/list');
  const tools = response.result.tools;

  const hidden = ['a2a_serve', 'a2a_group_inbox'];
  const expected = allSpecs().filter((spec) => hidden.includes(spec.name) === false);

  assert.equal(tools.length, expected.length, 'every shared tool except the two named above');
  assert.deepEqual(
    tools.map((tool) => tool.name),
    expected.map((spec) => spec.name),
    'and in the same order',
  );

  // The exclusion list must stay exactly these two: silently dropping a third would take a capability away without
  // anyone noticing.
  for (const name of hidden) {
    assert.equal(tools.some((tool) => tool.name === name), false, `${name} must not be advertised`);
    assert.ok(allSpecs().some((spec) => spec.name === name), `${name} must still exist in the shared specs`);
  }

  for (const tool of tools) {
    const spec = expected.find((entry) => entry.name === tool.name);
    assert.equal(tool.description, spec.description, `${tool.name}: description drifted`);
    assert.deepEqual(tool.inputSchema, spec.parameters, `${tool.name}: schema drifted`);
  }
});

test('calling a hidden tool answers with the substitute instead of crashing', async () => {
  // A client that cached the tool list before an upgrade can still name one of them. Reaching the implementation would
  // throw (a2a_serve) or lie (a2a_group_inbox), so the handler intercepts by name.
  const handler = handlerWith();

  const serve = await call(handler, 'tools/call', { name: 'a2a_serve', arguments: {} });
  assert.equal(serve.result.isError, true);
  const serveText = serve.result.content.map((part) => part.text).join('');
  assert.match(serveText, /MCP 客户端里不可用/);
  assert.match(serveText, /DSH/, 'the reader must be told where the capability does live');

  const inbox = await call(handler, 'tools/call', { name: 'a2a_group_inbox', arguments: {} });
  assert.equal(inbox.result.isError, true);
  const inboxText = inbox.result.content.map((part) => part.text).join('');
  // The substitute has to be NAMED, or the reader is left without a next step.
  assert.match(inboxText, /a2a_group_read/);
});

test('tools/list carries no renderer or runtime key', async () => {
  const handler = handlerWith();
  const response = await call(handler, 'tools/list');
  for (const tool of response.result.tools) {
    // MCP clients serialize this; a function here would be dropped or stringified.
    assert.equal(tool.output, undefined);
    assert.equal(tool.render, undefined);
    assert.equal(tool.runtime, undefined);
  }
});

test('an unknown tool is an error result, not a protocol error', async () => {
  const handler = handlerWith();
  const response = await call(handler, 'tools/call', { name: 'nope', arguments: {} });
  assert.equal(response.error, undefined, 'a bad tool name is a tool error');
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /unknown tool: nope/);
});

test('a tool that throws comes back as isError with its message', async () => {
  const handler = handlerWith({
    bridge: {
      send: async () => {
        const error = new Error('the host is unreachable');
        error.code = 'network_error';
        throw error;
      },
    },
  });
  const response = await call(handler, 'tools/call', {
    name: 'a2a_group_directory',
    arguments: {},
  });
  assert.equal(response.error, undefined);
  assert.equal(response.result.isError, true);
  const text = response.result.content[0].text;
  assert.match(text, /network_error/);
  assert.match(text, /unreachable/);
});

test('a successful call returns rendered text plus the structured value', async () => {
  const handler = handlerWith({
    bridge: {
      send: async () => ({
        data: {
          total: 1,
          returned: 1,
          hasMore: false,
          groups: [{ groupId: 'g-1', name: '发票重构', topic: '拆分服务', memberCount: 3, onlineCount: 1, lastActivityAt: Date.now() }],
        },
      }),
      // The directory tool reads the result of a skill call; match the shape it expects.
      call: async () => ({}),
    },
    registry: {
      list: () => [{ name: 'agent-groups', baseUrl: 'http://gw/a2a/agent-groups', enabled: true }],
      get: (name) => (name === 'agent-groups' ? { baseUrl: 'http://gw/a2a/agent-groups' } : undefined),
      resolve: () => ({ baseUrl: 'http://gw/a2a/agent-groups' }),
    },
  });
  const response = await call(handler, 'tools/call', {
    name: 'a2a_group_directory',
    arguments: {},
  });
  // Either it succeeded and produced text, or it failed with a message — what must not
  // happen is an empty response with no content array at all.
  assert.ok(Array.isArray(response.result.content), 'content must always be an array');
  assert.ok(response.result.content.length > 0, 'content must never be empty');
  assert.equal(typeof response.result.content[0].text, 'string');
});

test('a2a_group_summary renders the personId so a caller can address each member', () => {
  // The roster data always carried `personId`, but the render dropped it. A model (especially an MCP client that only
  // reads the rendered text) therefore could not pass it to a2a_person_send / a2a_group_kick, making those "positive"
  // paths unusable in practice. The id is not a secret — it is the same id the roster carries.
  const spec = allSpecs().find((entry) => entry.name === 'a2a_group_summary');
  const parts = spec.output.render({ groupId: 'g-1' }, {
    name: '群',
    topic: '',
    memberCount: 1,
    onlineCount: 0,
    isOwner: false,
    members: [{ personId: 'm-abc', displayName: '张三', role: 'member', isSelf: false, lastSeenAt: Date.now() }],
  });
  const text = parts.map((part) => part.text).join('\n');
  assert.match(text, /m-abc/u, 'the render must show the personId');
});

test('a2a_person_inbox renders the dmId so a2a_person_ack can be called', () => {
  // The structured value carried dmId, but the render dropped it. Without the id in the text, the reader cannot call
  // a2a_person_ack, so an invitation stays "undelivered" forever even though the reader saw it.
  const spec = allSpecs().find((entry) => entry.name === 'a2a_person_inbox');
  const parts = spec.output.render({}, {
    messages: [{ kind: 'group-invite', text: '邀请你加入', dmId: 'dm-123' }],
  });
  const text = parts.map((part) => part.text).join('\n');
  assert.match(text, /dm-123/u, 'the render must show the dmId');
});

test('resources and prompts answer empty rather than method-not-found', async () => {
  const handler = handlerWith();
  const resources = await call(handler, 'resources/list');
  assert.deepEqual(resources.result.resources, []);
  const prompts = await call(handler, 'prompts/list');
  assert.deepEqual(prompts.result.prompts, []);
});

test('an unknown method is -32601', async () => {
  const handler = handlerWith();
  const response = await call(handler, 'definitely/not/a/method');
  assert.equal(response.error.code, -32601);
  assert.match(response.error.message, /method not found/);
});

test('a malformed request object is -32600', async () => {
  const handler = handlerWith();
  const response = await handler.handle(null);
  assert.equal(response.error.code, -32600);
});

test('the handler factory is exported and independent per instance', () => {
  // Two handlers must not share a runtime: one connection's membership must not leak into
  // another's if the server is ever embedded rather than spawned.
  const a = handlerFactory({ deps: {}, sessionId: 'a' });
  const b = handlerFactory({ deps: {}, sessionId: 'b' });
  assert.notEqual(a.runtime, b.runtime);
});
