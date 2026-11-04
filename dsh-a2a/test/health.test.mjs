/**
 * Tests for the operator endpoint `/__health`.
 *
 * This endpoint exists for two jobs a card cannot do — liveness without A2A, and an
 * authenticated flush before a backup copies the file. Both are tested here because
 * both are easy to get subtly wrong:
 *
 *   - a flush reachable by GET would let a crawler or a browser prefetch make the host
 *     write to disk on demand;
 *   - a flush endpoint without auth would let anyone on the network do the same;
 *   - a health check that reports ok when the flush failed would make a backup script
 *     copy a stale file and believe it succeeded.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HEALTH_PATH } from '../lib/core/server.js';
import { createServer } from '../lib/core/server.js';
import { TaskStore } from '../lib/core/wire.js';

/** A webserver stand-in that records routes so they can be invoked as HTTP does. */
function fakeWebServer() {
  const exact = new Map();
  const prefixes = new Map();
  return {
    routes: { exact, prefixes },
    register({ kind = 'exact', path, handler }) {
      const table = kind === 'prefix' ? prefixes : exact;
      table.set(path, handler);
      return () => table.delete(path);
    },
    getOrigin: () => 'http://127.0.0.1:0',
  };
}

function fakeSkills() {
  return {
    list: () => [{ id: 'ping', name: 'ping', description: 'p' }],
    get: (id) => (id === 'ping' ? { id, run: async () => ({ text: 'pong' }) } : undefined),
  };
}

/** One request/response pair, captured. */
function pair() {
  const response = {
    statusCode: 0,
    headers: {},
    body: '',
    headersSent: false,
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = { ...this.headers, ...(headers ?? {}) };
      this.headersSent = true;
      return this;
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(chunk) {
      if (chunk !== undefined) this.body += chunk;
      this.headersSent = true;
    },
  };
  return response;
}

/** Invoke the health handler the way the HTTP layer would. */
async function callHealth(webServer, { method = 'GET', token } = {}) {
  const handler = webServer.routes.exact.get(HEALTH_PATH);
  assert.ok(handler, 'the health route must be registered');
  const request = {
    method,
    url: HEALTH_PATH,
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    socket: { remoteAddress: '203.0.113.9' },
  };
  const response = pair();
  await handler(request, response);
  return { status: response.statusCode, body: response.body === '' ? undefined : JSON.parse(response.body) };
}

test('health: a GET without a token is 401', async () => {
  const webServer = fakeWebServer();
  const server = createServer({
    ctx: { webServer },
    logger: { info() {}, warn() {}, debug() {} },
    config: { server: { token: 'sekret' }, agent: { name: 'agent-groups' } },
    deliverer: { deliver: async () => {} },
    tasks: new TaskStore(),
    skills: fakeSkills(),
  });
  server.attach();
  try {
    const { status } = await callHealth(webServer, { method: 'GET' });
    assert.equal(status, 401);
  } finally {
    server.detach();
  }
});

test('health: a GET with the token reports liveness and does not flush', async () => {
  const webServer = fakeWebServer();
  let flushes = 0;
  const server = createServer({
    ctx: { webServer },
    logger: { info() {}, warn() {}, debug() {} },
    config: { server: { token: 'sekret' }, agent: { name: 'agent-groups' } },
    deliverer: { deliver: async () => {} },
    tasks: new TaskStore(),
    skills: fakeSkills(),
    onFlush: () => {
      flushes += 1;
    },
  });
  server.attach();
  try {
    const { status, body } = await callHealth(webServer, { method: 'GET', token: 'sekret' });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.agent, 'agent-groups');
    assert.equal(body.version, '1.0');
    assert.equal(typeof body.uptimeSeconds, 'number');
    assert.equal(body.skills, 1);
    assert.equal(body.flushed, undefined, 'a GET must not report a flush');
    assert.equal(flushes, 0, 'a GET must not flush');
  } finally {
    server.detach();
  }
});

test('health: a POST flushes, so a backup can copy a complete file', async () => {
  const webServer = fakeWebServer();
  let flushes = 0;
  const server = createServer({
    ctx: { webServer },
    logger: { info() {}, warn() {}, debug() {} },
    config: { server: { token: 'sekret' } },
    deliverer: { deliver: async () => {} },
    tasks: new TaskStore(),
    skills: fakeSkills(),
    onFlush: () => {
      flushes += 1;
    },
  });
  server.attach();
  try {
    const { status, body } = await callHealth(webServer, { method: 'POST', token: 'sekret' });
    assert.equal(status, 200);
    assert.equal(body.flushed, true);
    assert.equal(flushes, 1);
  } finally {
    server.detach();
  }
});

test('health: a failing flush is reported as not-ok, so a backup script can skip', async () => {
  const webServer = fakeWebServer();
  const server = createServer({
    ctx: { webServer },
    logger: { info() {}, warn() {}, debug() {} },
    config: { server: { token: 'sekret' } },
    deliverer: { deliver: async () => {} },
    tasks: new TaskStore(),
    skills: fakeSkills(),
    onFlush: () => {
      throw new Error('disk full');
    },
  });
  server.attach();
  try {
    const { status, body } = await callHealth(webServer, { method: 'POST', token: 'sekret' });
    assert.equal(status, 500, 'a failed flush must not look like success');
    assert.equal(body.ok, false);
    assert.equal(body.flushed, false);
    assert.match(body.flushError, /disk full/);
  } finally {
    server.detach();
  }
});
