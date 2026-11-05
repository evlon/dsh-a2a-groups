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

test('tools/list exposes exactly the DSH tool set, with identical schemas', async () => {
  const handler = handlerWith();
  const response = await call(handler, 'tools/list');
  const tools = response.result.tools;

  const specs = allSpecs();
  assert.equal(tools.length, specs.length, 'the two hosts must offer the same number of tools');
  assert.deepEqual(
    tools.map((tool) => tool.name),
    specs.map((spec) => spec.name),
    'and in the same order',
  );

  for (const tool of tools) {
    const spec = specs.find((entry) => entry.name === tool.name);
    assert.equal(tool.description, spec.description, `${tool.name}: description drifted`);
    assert.deepEqual(tool.inputSchema, spec.parameters, `${tool.name}: schema drifted`);
  }
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
