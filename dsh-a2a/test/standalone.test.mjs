/**
 * Tests for the standalone host's HTTP adapter.
 *
 * The point of `createHttpRegistrar` is that a group host runs with no DSH at all.
 * What is worth testing is therefore not "does it proxy" but the three promises the
 * A2A surface depends on:
 *
 *   - exact matches win over prefix matches, and the longest prefix wins (the same
 *     rule the DSH webserver applies, so the host behaves identically either way);
 *   - an unknown path gets a JSON 404, not an HTML shell (a peer probing for a card
 *     must not mistake a page for one);
 *   - `detach()` really unregisters, so a restart inside one process is possible.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer as createHttpServer } from 'node:http';

import { createHttpRegistrar, parseFlags } from '../bin/dsh-groups.js';

/** Start a real server over a registrar, and return its base URL plus a stop fn. */
async function startHost(logger = { debug() {}, info() {}, warn() {} }) {
  const { registrar, handle } = createHttpRegistrar(logger);
  const server = createHttpServer(handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    registrar,
    base: `http://127.0.0.1:${port}`,
    // `closeAllConnections` matters on Windows, where an idle keep-alive socket keeps
    // `close()` pending and the test suite hangs instead of failing.
    stop: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}

test('registrar: an exact route wins over a prefix route', async () => {
  const host = await startHost();
  try {
    host.registrar.register({ kind: 'prefix', path: '/a2a', handler: () => 'prefix' });
    host.registrar.register({ kind: 'exact', path: '/a2a', handler: (request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('exact');
    } });
    const body = await (await fetch(`${host.base}/a2a`)).text();
    assert.equal(body, 'exact');
  } finally {
    await host.stop();
  }
});

test('registrar: among prefixes the longest wins', async () => {
  const host = await startHost();
  try {
    host.registrar.register({ kind: 'prefix', path: '/a2a', handler: (request, response) => {
      response.writeHead(200);
      response.end('short');
    } });
    host.registrar.register({ kind: 'prefix', path: '/a2a/.well-known/', handler: (request, response) => {
      response.writeHead(200);
      response.end('long');
    } });
    const body = await (await fetch(`${host.base}/a2a/.well-known/agent-card.json`)).text();
    assert.equal(body, 'long');
  } finally {
    await host.stop();
  }
});

test('registrar: an unknown path is a JSON 404, never an HTML shell', async () => {
  const host = await startHost();
  try {
    const response = await fetch(`${host.base}/nope`);
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    const body = await response.json();
    assert.equal(body.error, 'not_found');
    assert.equal(body.path, '/nope');
  } finally {
    await host.stop();
  }
});

test('registrar: detach removes the route, so a second attach can reuse the path', async () => {
  const host = await startHost();
  try {
    const dispose = host.registrar.register({ kind: 'exact', path: '/a2a', handler: (request, response) => {
      response.writeHead(200);
      response.end('first');
    } });
    assert.equal(await (await fetch(`${host.base}/a2a`)).text(), 'first');
    dispose();
    const gone = await fetch(`${host.base}/a2a`);
    assert.equal(gone.status, 404, 'a disposed route must not still answer');
    // Re-registering the same path must not throw: a plugin reload does exactly this.
    host.registrar.register({ kind: 'exact', path: '/a2a', handler: (request, response) => {
      response.writeHead(200);
      response.end('second');
    } });
    assert.equal(await (await fetch(`${host.base}/a2a`)).text(), 'second');
  } finally {
    await host.stop();
  }
});

test('registrar: a route path must be absolute', () => {
  const { registrar } = createHttpRegistrar({ debug() {}, info() {}, warn() {} });
  assert.throws(() => registrar.register({ kind: 'exact', path: 'a2a', handler: () => {} }), /must start with/);
});

test('registrar: a handler that throws yields 500 instead of killing the process', async () => {
  const host = await startHost();
  try {
    host.registrar.register({ kind: 'exact', path: '/boom', handler: () => {
      throw new Error('deliberate');
    } });
    const response = await fetch(`${host.base}/boom`);
    assert.equal(response.status, 500);
    assert.equal((await response.json()).error, 'internal_error');
  } finally {
    await host.stop();
  }
});

test('registrar: an async handler that rejects also yields 500', async () => {
  const host = await startHost();
  try {
    host.registrar.register({ kind: 'exact', path: '/reject', handler: async () => {
      throw new Error('deliberate async');
    } });
    const response = await fetch(`${host.base}/reject`);
    assert.equal(response.status, 500);
  } finally {
    await host.stop();
  }
});

// ---------------------------------------------------------------------------
// Flag parsing

test('parseFlags: reads separated values, equals values and bare booleans', () => {
  const flags = parseFlags(['--port', '3095', '--data=/var/lib/groups', '--help', '--host', '0.0.0.0']);
  assert.equal(flags.port, '3095');
  assert.equal(flags.data, '/var/lib/groups');
  assert.equal(flags.help, true);
  assert.equal(flags.host, '0.0.0.0');
});

test('parseFlags: rejects a positional argument instead of ignoring it', () => {
  // Silently ignoring `dsh-groups 3095` would start on the default port and look fine,
  // which is a far worse failure than a usage error.
  assert.throws(() => parseFlags(['3095']), /unexpected argument/);
});
