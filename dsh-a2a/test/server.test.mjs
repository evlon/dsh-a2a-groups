/**
 * Behavioral tests for the A2A HTTP endpoint.
 *
 * Every test here drives a real `node:http` listener on `listen(0)`, and a
 * minimal fake webserver that mirrors the Host's `register({kind, path,
 * handler})` contract. That combination matters: the assertions then cover the
 * actual bytes a peer receives (status codes, JSON-RPC error codes, SSE frames)
 * instead of the arguments we happened to pass to a mocked handler.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';

import { createServer } from '../lib/core/server.js';
import { TaskStore } from '../lib/core/wire.js';
import { CARD_ALIAS_PATH, CARD_PATH } from '../lib/core/card.js';
import { createDeliverer } from '../lib/dsh/deliver.js';

/**
 * A fake webserver implementing the Host's route table.
 *
 * The matching rule is the Host's: exact over the whole table, then longest
 * prefix, then 404. Reproducing it (rather than a single handler) is what lets a
 * test prove the `/.well-known/` prefix route actually shadows the SPA fallback.
 *
 * @returns {object} `{register, handle, routes, origin}`.
 */
function fakeWebServer({ origin = 'http://127.0.0.1:9999' } = {}) {
  const exact = new Map();
  const prefixes = new Map();
  return {
    origin,
    routes: { exact, prefixes },
    register(route) {
      const table = route.kind === 'exact' ? exact : prefixes;
      if (table.has(route.path)) throw new Error(`duplicate ${route.kind} route "${route.path}"`);
      table.set(route.path, route);
      return () => table.delete(route.path);
    },
    getOrigin() {
      return origin;
    },
    /** Match one request the way the Host does. */
    async handle(req, res) {
      const path = (req.url ?? '/').split('?')[0];
      const exactRoute = exact.get(path);
      if (exactRoute !== undefined) {
        await exactRoute.handler(req, res);
        return true;
      }
      let best;
      for (const [prefix, route] of prefixes) {
        if (!path.startsWith(prefix)) continue;
        if (best === undefined || prefix.length > best.prefix.length) best = { prefix, route };
      }
      if (best !== undefined) {
        await best.route.handler(req, res);
        return true;
      }
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/html');
      res.end('<html>spa fallback</html>');
      return false;
    },
  };
}

/** A logger double that records every line so tests can assert on silence. */
function fakeLogger() {
  const lines = { debug: [], info: [], warn: [] };
  return {
    lines,
    debug: (message) => lines.debug.push(String(message)),
    info: (message) => lines.info.push(String(message)),
    warn: (message) => lines.warn.push(String(message)),
  };
}

/** A minimal skill registry with two skills: an echo and a thrower. */
function fakeSkills({ run, extra = [] } = {}) {
  const entries = new Map();
  const echo = {
    id: 'ping',
    name: 'Ping',
    description: 'Connectivity self-check',
    examples: ['ping'],
    async run() {
      return { text: 'pong', name: 'pong' };
    },
  };
  const ask = {
    id: 'session/ask',
    name: 'Ask the Session',
    description: 'Deliver text into the bound Session',
    examples: ['hello'],
    async run(input) {
      return { text: `echo:${input.text}`, name: 'reply' };
    },
  };
  const failing = {
    id: 'boom',
    name: 'Boom',
    description: 'Always fails',
    async run() {
      throw new Error('skill exploded');
    },
  };
  for (const entry of [echo, ask, failing, ...extra]) entries.set(entry.id, entry);
  if (run !== undefined) entries.set('session/ask', { ...ask, run });
  return {
    get: (id) => entries.get(id),
    list: () => [...entries.values()].map(({ run: _run, ...meta }) => meta),
  };
}

/**
 * Start an A2A server on a real port.
 *
 * @param {object} [options] - overrides.
 * @returns {Promise<object>} handles plus a `close()`.
 */
async function startServer(options = {}) {
  const webServer = options.webServer ?? fakeWebServer();
  const logger = options.logger ?? fakeLogger();
  const tasks = options.tasks ?? new TaskStore();
  const skills = options.skills ?? fakeSkills();
  const ctx = { webServer, logger, ...options.ctx };
  const server = createServer({
    ctx,
    logger,
    config: { server: { token: '', ...options.server }, delivery: {} },
    deliverer: options.deliverer ?? createDeliverer({ ctx, logger, config: {} }),
    tasks,
    skills,
  });
  server.attach();
  const http = createHttpServer((req, res) => {
    webServer.handle(req, res).catch(() => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('{}');
      }
    });
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address();
  return {
    server,
    webServer,
    logger,
    tasks,
    skills,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      server.detach();
      await new Promise((resolve) => http.close(resolve));
    },
  };
}

/**
 * Perform one HTTP request and collect the full body.
 *
 * @param {string} baseUrl - origin.
 * @param {string} path - path to request.
 * @param {object} [options] - `{method, headers, body}`.
 * @returns {Promise<{status: number, headers: object, body: string, json: any}>} the response.
 */
function call(baseUrl, path, { method = 'POST', headers = {}, body } = {}) {
  const url = new URL(path, baseUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers: {
          ...body === undefined ? {} : { 'content-length': Buffer.byteLength(body) },
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode, headers: res.headers, body: text, json });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Build a 1.0 SendMessage envelope. */
function sendMessageEnvelope({ id = 'smoke-1', text = 'hello', skill = 'ping', contextId, messageId = 'msg-1' } = {}) {
  const params = {
    message: {
      role: 'user',
      messageId,
      parts: [{ kind: 'text', text }],
      ...skill === undefined ? {} : { metadata: { skill } },
      ...contextId === undefined ? {} : { contextId },
    },
  };
  return JSON.stringify({ jsonrpc: '2.0', id, method: 'SendMessage', params });
}

/** The standard headers a 1.0 caller sends. */
const V1 = { 'content-type': 'application/json', 'a2a-version': '1.0' };

/**
 * Send one JSON-RPC call and assert the HTTP layer was healthy.
 * @param {string} baseUrl - origin.
 * @param {object} [options] - envelope options plus header overrides.
 * @returns {Promise<object>} the parsed response.
 */
async function rpc(baseUrl, options = {}) {
  const { headers = {}, ...envelope } = options;
  const response = await call(baseUrl, '/a2a', {
    method: 'POST',
    headers: { ...V1, ...headers },
    body: sendMessageEnvelope(envelope),
  });
  assert.equal(response.status, 200, `expected a JSON-RPC 200, got ${response.status}: ${response.body}`);
  return response.json;
}

/**
 * Read an SSE stream to completion, returning the parsed frames in order.
 * @param {string} baseUrl - origin.
 * @param {object} [options] - envelope options plus header overrides.
 * @returns {Promise<{frames: object[], comments: string[], status: number}>} parsed stream.
 */
function readSse(baseUrl, { headers = {}, ...envelope } = {}) {
  const url = new URL('/a2a', baseUrl);
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: envelope.id ?? 'stream-1',
      method: 'SendStreamingMessage',
      params: {
        message: {
          role: 'user',
          messageId: envelope.messageId ?? 'msg-s',
          parts: [{ kind: 'text', text: envelope.text ?? 'hello' }],
          metadata: { skill: envelope.skill ?? 'ping' },
        },
      },
    });
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: '/a2a',
        method: 'POST',
        headers: { ...V1, 'content-length': Buffer.byteLength(body), ...headers },
      },
      (res) => {
        const frames = [];
        const comments = [];
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buffer += chunk;
          let boundary = buffer.indexOf('\n\n');
          while (boundary >= 0) {
            const raw = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            if (raw.startsWith('data:')) {
              const payload = raw.slice(5).trim();
              try {
                frames.push(JSON.parse(payload));
              } catch {
                reject(new Error(`unparseable SSE frame: ${payload}`));
                return;
              }
            } else if (raw.startsWith(':')) {
              comments.push(raw.slice(1).trim());
            }
            boundary = buffer.indexOf('\n\n');
          }
        });
        res.on('end', () => resolve({ frames, comments, status: res.statusCode }));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

test('server: the agent card is public, complete, and self-consistent', async () => {
  const server = await startServer();
  try {
    const response = await call(server.baseUrl, CARD_PATH, { method: 'GET' });
    assert.equal(response.status, 200);
    assert.match(response.headers['content-type'], /application\/json/);

    const card = response.json;
    for (const field of ['name', 'description', 'url', 'version', 'protocolVersion', 'preferredTransport', 'capabilities', 'supportedInterfaces', 'skills']) {
      assert.equal(Object.hasOwn(card, field), true, `the card must declare ${field}`);
    }
    assert.equal(card.protocolVersion, '1.0');
    assert.equal(card.preferredTransport, 'JSONRPC');
    assert.deepEqual(card.defaultInputModes, ['text/plain']);
    assert.deepEqual(card.defaultOutputModes, ['text/plain']);
    assert.equal(card.capabilities.streaming, true);
    assert.equal(card.capabilities.pushNotifications, false);
    assert.equal(card.supportedInterfaces.length, 1);
    assert.equal(card.supportedInterfaces[0].protocolBinding, 'JSONRPC');
    assert.equal(card.supportedInterfaces[0].protocolVersion, '1.0');
    assert.equal(card.supportedInterfaces[0].url, card.url);
    assert.match(card.url, /\/a2a$/);

    const ids = card.skills.map((skill) => skill.id).sort();
    assert.deepEqual(ids, ['boom', 'ping', 'session/ask']);
    const ping = card.skills.find((skill) => skill.id === 'ping');
    assert.equal(ping.name, 'Ping');
    assert.equal(typeof ping.examples[0], 'string');
    assert.equal(Object.hasOwn(ping, 'run'), false, 'a card must never serialize a function');
  } finally {
    await server.close();
  }
});

test('server: agent.json is an alias for the card', async () => {
  const server = await startServer();
  try {
    const canonical = await call(server.baseUrl, CARD_PATH, { method: 'GET' });
    const alias = await call(server.baseUrl, CARD_ALIAS_PATH, { method: 'GET' });
    assert.equal(alias.status, 200);
    assert.deepEqual(alias.json, canonical.json);
  } finally {
    await server.close();
  }
});

test('server: an unknown discovery path is a JSON 404, not the SPA shell', async () => {
  const server = await startServer();
  try {
    const response = await call(server.baseUrl, '/a2a/.well-known/nope.json', { method: 'GET' });
    assert.equal(response.status, 404);
    assert.match(response.headers['content-type'], /application\/json/);
    assert.equal(typeof response.json.error.code, 'number');
    assert.equal(response.body.includes('spa fallback'), false, 'the SPA fallback must not answer a discovery probe');
  } finally {
    await server.close();
  }
});

test('server: the card advertises the configured publicUrl', async () => {
  const server = await startServer({ server: { publicUrl: 'https://gw.example/a2a/me' } });
  try {
    const response = await call(server.baseUrl, CARD_PATH, { method: 'GET' });
    assert.equal(response.json.url, 'https://gw.example/a2a/me');
    assert.equal(response.json.supportedInterfaces[0].url, 'https://gw.example/a2a/me');
  } finally {
    await server.close();
  }
});

test('server: the card falls back to the webserver origin', async () => {
  const webServer = fakeWebServer({ origin: 'http://10.1.2.3:3091' });
  const server = await startServer({ webServer });
  try {
    const response = await call(server.baseUrl, CARD_PATH, { method: 'GET' });
    assert.equal(response.json.url, 'http://10.1.2.3:3091/a2a');
  } finally {
    await server.close();
  }
});

test('server: with no token configured, a loopback caller is admitted', async () => {
  const server = await startServer({ server: { token: '' } });
  try {
    const response = await rpc(server.baseUrl, { skill: 'ping' });
    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.id, 'smoke-1');
    assert.equal(response.result.task.status.state, 'TASK_STATE_COMPLETED');
    assert.deepEqual(response.result.task.artifacts[0].parts, [{ kind: 'text', text: 'pong' }]);
    assert.equal(server.logger.lines.warn.length >= 1, true, 'a tokenless bind must warn at least once');
    assert.match(server.logger.lines.warn.join('\n'), /accepts loopback callers only/i);
  } finally {
    await server.close();
  }
});

test('server: with a token configured, missing and wrong credentials are 401', async () => {
  const server = await startServer({ server: { token: 'sekret-token' } });
  try {
    const anonymous = await call(server.baseUrl, '/a2a', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'a2a-version': '1.0' },
      body: sendMessageEnvelope({ skill: 'ping' }),
    });
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.json.error.code, -32001);

    const wrong = await call(server.baseUrl, '/a2a', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'a2a-version': '1.0', 'x-api-key': 'nope' },
      body: sendMessageEnvelope({ skill: 'ping' }),
    });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json.error.code, -32001);
    assert.equal(wrong.body.includes('sekret-token'), false, 'the configured token must never be echoed');
  } finally {
    await server.close();
  }
});

test('server: with a token configured, both header forms are accepted', async () => {
  const server = await startServer({ server: { token: 'sekret-token' } });
  try {
    const viaApiKey = await call(server.baseUrl, '/a2a', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'a2a-version': '1.0', 'x-api-key': 'sekret-token' },
      body: sendMessageEnvelope({ skill: 'ping' }),
    });
    assert.equal(viaApiKey.status, 200);
    assert.equal(viaApiKey.json.result.task.status.state, 'TASK_STATE_COMPLETED');

    const viaBearer = await call(server.baseUrl, '/a2a', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'a2a-version': '1.0', authorization: 'Bearer sekret-token' },
      body: sendMessageEnvelope({ id: 'smoke-2', skill: 'ping' }),
    });
    assert.equal(viaBearer.status, 200);
    assert.equal(viaBearer.json.result.task.status.state, 'TASK_STATE_COMPLETED');
  } finally {
    await server.close();
  }
});

test('server: the token is never written to a log line', async () => {
  const logger = fakeLogger();
  const server = await startServer({ server: { token: 'sekret-token' }, logger });
  try {
    await call(server.baseUrl, '/a2a', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'a2a-version': '1.0', 'x-api-key': 'wrong-token' },
      body: sendMessageEnvelope({ skill: 'ping' }),
    });
    const all = [...logger.lines.debug, ...logger.lines.info, ...logger.lines.warn].join('\n');
    assert.equal(all.includes('sekret-token'), false);
  } finally {
    await server.close();
  }
});

test('server: a missing A2A-Version header is rejected as implied 0.3', async () => {
  const server = await startServer();
  try {
    const response = await call(server.baseUrl, '/a2a', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: sendMessageEnvelope({ skill: 'ping' }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.json.error.code, -32003);
    assert.match(response.json.error.message, /1\.0 only/);
    assert.match(response.json.error.message, /A2A-Version/);
    assert.deepEqual(response.json.error.data.supported, ['1.0']);
  } finally {
    await server.close();
  }
});

test('server: an explicit 0.3 version is rejected with -32003', async () => {
  const server = await startServer();
  try {
    const response = await call(server.baseUrl, '/a2a', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'a2a-version': '0.3' },
      body: sendMessageEnvelope({ skill: 'ping' }),
    });
    assert.equal(response.json.error.code, -32003);
    assert.match(response.json.error.message, /0\.3/);
  } finally {
    await server.close();
  }
});

test('server: an unknown method is -32601 and names it', async () => {
  const server = await startServer();
  try {
    const response = await call(server.baseUrl, '/a2a', {
      method: 'POST',
      headers: V1,
      body: JSON.stringify({ jsonrpc: '2.0', id: 'x1', method: 'Teleport', params: {} }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.json.error.code, -32601);
    assert.equal(response.json.error.data.method, 'Teleport');
  } finally {
    await server.close();
  }
});

test('server: an oversize body is a 413 and never reaches a skill', async () => {
  const skills = fakeSkills();
  let ran = 0;
  skills.get('ping').run = async () => {
    ran += 1;
    return { text: 'pong' };
  };
  const server = await startServer({ skills, server: { maxBodyBytes: 256 } });
  try {
    const response = await call(server.baseUrl, '/a2a', {
      method: 'POST',
      headers: V1,
      body: sendMessageEnvelope({ skill: 'ping', text: 'x'.repeat(1024) }),
    });
    assert.equal(response.status, 413);
    assert.equal(server.tasks.list().length, 0, 'a refused body must not create a task');
    assert.equal(ran, 0);
  } finally {
    await server.close();
  }
});

test('server: an unsupported HTTP method on /a2a is a 405', async () => {
  const server = await startServer();
  try {
    const response = await call(server.baseUrl, '/a2a', { method: 'GET' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.allow, 'POST');
  } finally {
    await server.close();
  }
});

test('server: an invalid JSON body is -32700', async () => {
  const server = await startServer();
  try {
    const response = await call(server.baseUrl, '/a2a', {
      method: 'POST',
      headers: V1,
      body: '{not json',
    });
    assert.equal(response.status, 400);
    assert.equal(response.json.error.code, -32700);
  } finally {
    await server.close();
  }
});

test('server: a batch array is refused rather than guessed at', async () => {
  const server = await startServer();
  try {
    const response = await call(server.baseUrl, '/a2a', {
      method: 'POST',
      headers: V1,
      body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: {} }]),
    });
    assert.equal(response.status, 400);
    assert.equal(response.json.error.code, -32600);
  } finally {
    await server.close();
  }
});

test('server: jsonrpc must be exactly "2.0"', async () => {
  const server = await startServer();
  try {
    const response = await call(server.baseUrl, '/a2a', {
      method: 'POST',
      headers: V1,
      body: JSON.stringify({ jsonrpc: '1.0', id: 'x', method: 'SendMessage', params: {} }),
    });
    assert.equal(response.json.error.code, -32600);
  } finally {
    await server.close();
  }
});

test('server: an unknown skill is -32602 and lists what exists', async () => {
  const server = await startServer();
  try {
    const response = await rpc(server.baseUrl, { skill: 'nope/nope' });
    assert.equal(response.error.code, -32602);
    assert.equal(response.error.data.code, 'unknown_skill');
    assert.deepEqual(response.error.data.known.sort(), ['boom', 'ping', 'session/ask']);
  } finally {
    await server.close();
  }
});

test('server: a message with no parts is -32602', async () => {
  const server = await startServer();
  try {
    const response = await call(server.baseUrl, '/a2a', {
      method: 'POST',
      headers: V1,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'x',
        method: 'SendMessage',
        params: { message: { role: 'user', messageId: 'm', parts: [] } },
      }),
    });
    assert.equal(response.json.error.code, -32602);
  } finally {
    await server.close();
  }
});

test('server: unary SendMessage returns a completed task with the reply artifact', async () => {
  const server = await startServer();
  try {
    const response = await rpc(server.baseUrl, { skill: 'session/ask', text: 'hello' });
    const task = response.result.task;
    assert.equal(task.id.startsWith('task-'), true);
    assert.equal(typeof task.contextId, 'string');
    assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
    assert.match(task.status.timestamp, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(task.artifacts.length, 1);
    assert.equal(task.artifacts[0].name, 'reply');
    assert.deepEqual(task.artifacts[0].parts, [{ kind: 'text', text: 'echo:hello' }]);

    // The same task is readable afterwards: a unary call is not fire-and-forget.
    const fetched = await call(server.baseUrl, '/a2a', {
      method: 'POST',
      headers: V1,
      body: JSON.stringify({ jsonrpc: '2.0', id: 'get-1', method: 'GetTask', params: { id: task.id } }),
    });
    assert.equal(fetched.json.result.task.status.state, 'TASK_STATE_COMPLETED');
  } finally {
    await server.close();
  }
});

test('server: a caller-supplied contextId is echoed on the task', async () => {
  const server = await startServer();
  try {
    const response = await rpc(server.baseUrl, { skill: 'ping', contextId: 'ctx-abc' });
    assert.equal(response.result.task.contextId, 'ctx-abc');
  } finally {
    await server.close();
  }
});

test('server: a skill without metadata.skill defaults to session/ask', async () => {
  const server = await startServer();
  try {
    const response = await call(server.baseUrl, '/a2a', {
      method: 'POST',
      headers: V1,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'no-skill',
        method: 'SendMessage',
        params: { message: { role: 'user', messageId: 'm', parts: [{ kind: 'text', text: 'hi' }] } },
      }),
    });
    assert.deepEqual(response.json.result.task.artifacts[0].parts, [{ kind: 'text', text: 'echo:hi' }]);
  } finally {
    await server.close();
  }
});

test('server: a throwing skill returns -32603 and leaves the task failed', async () => {
  const server = await startServer();
  try {
    const response = await rpc(server.baseUrl, { skill: 'boom' });
    assert.equal(response.error.code, -32603);
    assert.equal(response.error.message, 'skill exploded');
    assert.equal(typeof response.error.data.taskId, 'string');
    const task = server.tasks.get(response.error.data.taskId);
    assert.equal(task.state, 'failed');
  } finally {
    await server.close();
  }
});

test('server: a skill timeout fails the task with a retryable sub-code', async () => {
  const skills = fakeSkills({
    run: () => new Promise(() => {}), // never resolves, and ignores its signal
  });
  const server = await startServer({ skills, server: { taskTimeoutMs: 60 } });
  try {
    const response = await rpc(server.baseUrl, { skill: 'session/ask' });
    assert.equal(response.error.code, -32603);
    assert.equal(response.error.data.code, 'task_timeout');
    assert.equal(server.tasks.get(response.error.data.taskId).state, 'failed');
  } finally {
    await server.close();
  }
});

test('server: a skill may declare its own final state', async () => {
  const skills = fakeSkills({ run: async () => ({ text: 'need more', finalState: 'input-required' }) });
  const server = await startServer({ skills });
  try {
    const response = await rpc(server.baseUrl, { skill: 'session/ask' });
    assert.equal(response.result.task.status.state, 'TASK_STATE_INPUT_REQUIRED');
  } finally {
    await server.close();
  }
});

test('server: GetTask on an unknown id is a stable task_not_found', async () => {
  const server = await startServer();
  try {
    const response = await call(server.baseUrl, '/a2a', {
      method: 'POST',
      headers: V1,
      body: JSON.stringify({ jsonrpc: '2.0', id: 'g1', method: 'GetTask', params: { id: 'task-nope' } }),
    });
    assert.equal(response.json.error.data.code, 'task_not_found');
  } finally {
    await server.close();
  }
});

test('server: CancelTask cancels once and then reports no further change', async () => {
  const server = await startServer();
  try {
    const created = await rpc(server.baseUrl, { skill: 'ping' });
    const taskId = created.result.task.id;
    // A completed task is already terminal, so cancelling it changes nothing.
    const first = await call(server.baseUrl, '/a2a', {
      method: 'POST',
      headers: V1,
      body: JSON.stringify({ jsonrpc: '2.0', id: 'c1', method: 'CancelTask', params: { id: taskId } }),
    });
    assert.equal(first.json.result.task.status.state, 'TASK_STATE_COMPLETED');

    const pending = server.tasks.create({ contextId: 'ctx-p' });
    const second = await call(server.baseUrl, '/a2a', {
      method: 'POST',
      headers: V1,
      body: JSON.stringify({ jsonrpc: '2.0', id: 'c2', method: 'CancelTask', params: { id: pending.id } }),
    });
    assert.equal(second.json.result.task.status.state, 'TASK_STATE_CANCELED');
  } finally {
    await server.close();
  }
});

test('server: streaming emits submitted, working, artifact, and a final completed frame', async () => {
  const server = await startServer();
  try {
    const { frames, status } = await readSse(server.baseUrl, { skill: 'ping' });
    assert.equal(status, 200);
    assert.equal(frames.length >= 4, true, `expected at least 4 frames, got ${frames.length}`);

    const states = frames
      .map((frame) => frame.result?.statusUpdate?.status?.state)
      .filter((state) => state !== undefined);
    assert.deepEqual(states, ['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING', 'TASK_STATE_COMPLETED']);

    const artifacts = frames.map((frame) => frame.result?.artifactUpdate).filter(Boolean);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].lastChunk, true);
    assert.equal(artifacts[0].append, false);
    assert.deepEqual(artifacts[0].artifact.parts, [{ kind: 'text', text: 'pong' }]);

    const last = frames[frames.length - 1];
    assert.equal(last.result.statusUpdate.final, true);
    assert.equal(last.result.statusUpdate.status.state, 'TASK_STATE_COMPLETED');
    assert.equal(
      frames.filter((frame) => frame.result?.statusUpdate?.final === true).length,
      1,
      'exactly one frame may end the stream',
    );

    const taskIds = new Set(frames.map((frame) => frame.result?.statusUpdate?.taskId ?? frame.result?.artifactUpdate?.taskId));
    assert.equal(taskIds.size, 1, 'every frame must belong to one task');
    assert.equal(server.tasks.get([...taskIds][0]).state, 'completed');
  } finally {
    await server.close();
  }
});

test('server: streaming a failing skill still ends with one final failed frame', async () => {
  const server = await startServer();
  try {
    const { frames } = await readSse(server.baseUrl, { skill: 'boom' });
    const last = frames[frames.length - 1];
    assert.equal(last.result.statusUpdate.final, true);
    assert.equal(last.result.statusUpdate.status.state, 'TASK_STATE_FAILED');
    assert.match(last.result.statusUpdate.status.message.parts[0].text, /skill exploded/);
  } finally {
    await server.close();
  }
});

test('server: streaming is refused with -32601 when disabled', async () => {
  const server = await startServer({ server: { streaming: false } });
  try {
    const response = await call(server.baseUrl, '/a2a', {
      method: 'POST',
      headers: V1,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 's',
        method: 'SendStreamingMessage',
        params: { message: { role: 'user', messageId: 'm', parts: [{ kind: 'text', text: 'x' }] } },
      }),
    });
    assert.equal(response.json.error.code, -32601);
    const card = await call(server.baseUrl, CARD_PATH, { method: 'GET' });
    assert.equal(card.json.capabilities.streaming, false, 'the card must stop advertising streaming');
  } finally {
    await server.close();
  }
});

test('server: streaming sets SSE headers that defeat proxy buffering', async () => {
  const server = await startServer();
  try {
    const headers = await new Promise((resolve, reject) => {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 'h',
        method: 'SendStreamingMessage',
        params: { message: { role: 'user', messageId: 'm', parts: [{ kind: 'text', text: 'x' }], metadata: { skill: 'ping' } } },
      });
      const req = httpRequest(
        { hostname: '127.0.0.1', port: server.port, path: '/a2a', method: 'POST', headers: { ...V1, 'content-length': Buffer.byteLength(body) } },
        (res) => {
          resolve(res.headers);
          res.resume();
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    assert.match(headers['content-type'], /text\/event-stream/);
    assert.match(headers['cache-control'], /no-cache/);
    assert.equal(headers['x-accel-buffering'], 'no');
  } finally {
    await server.close();
  }
});

test('server: attach is idempotent and detach removes every route it added', async () => {
  const webServer = fakeWebServer();
  const server = await startServer({ webServer });
  try {
    // card, alias, /a2a, and the operator's /__health
    assert.equal(webServer.routes.exact.size, 4, 'card, alias, /a2a and /__health');
    assert.equal(webServer.routes.prefixes.size, 1);
  } finally {
    await server.close();
  }
  assert.equal(webServer.routes.exact.size, 0, 'detach must leave no route behind');
  assert.equal(webServer.routes.prefixes.size, 0);
});

test('server: re-attaching after detach does not collide', async () => {
  const webServer = fakeWebServer();
  const server = await startServer({ webServer });
  await server.close();
  assert.doesNotThrow(() => server.server.attach());
  server.server.detach();
});

test('server: attach without a Host webserver fails loudly', () => {
  const server = createServer({
    ctx: {},
    config: { server: {} },
    tasks: new TaskStore(),
    skills: fakeSkills(),
  });
  assert.throws(() => server.attach(), /no route registrar was provided/);
});

test('server: info() never exposes the configured token', async () => {
  const server = await startServer({ server: { token: 'sekret-token' } });
  try {
    const summary = server.server.info();
    assert.equal(summary.tokenConfigured, true);
    assert.equal(summary.loopbackOnly, false);
    assert.equal(JSON.stringify(summary).includes('sekret-token'), false);
    assert.deepEqual(summary.methods.sort(), ['CancelTask', 'GetTask', 'SendMessage', 'SendStreamingMessage']);
  } finally {
    await server.close();
  }
});

test('server: a skill receives the task, message, and cancellation context it needs', async () => {
  let seen;
  const skills = fakeSkills({
    run: (_input, context) => {
      seen = context;
      return { text: 'ok' };
    },
  });
  const server = await startServer({ skills });
  try {
    await rpc(server.baseUrl, { skill: 'session/ask', text: 'hello', messageId: 'msg-ctx', contextId: 'ctx-1' });
    assert.equal(seen.taskId.startsWith('task-'), true);
    assert.equal(seen.contextId, 'ctx-1');
    assert.equal(seen.messageId, 'msg-ctx', 'session/ask keys its dedupe on this id');
    assert.equal(seen.skill, 'session/ask');
    assert.equal(seen.deliverer !== undefined, true);
    assert.equal(seen.tasks !== undefined, true);
    assert.equal(typeof seen.now(), 'number');
    assert.equal(seen.signal instanceof Object, true);
    assert.equal(seen.signal.aborted, false);
    assert.equal(typeof seen.server.card, 'function');
    assert.equal(typeof seen.untilCancelled, 'function');
  } finally {
    await server.close();
  }
});

test('server: a unary call offers no emit, so a streaming-only skill refuses honestly', async () => {
  let emitSeen = 'unset';
  const skills = fakeSkills({
    run: (_input, context) => {
      emitSeen = context.emit;
      if (typeof context.emit !== 'function') {
        const error = new Error('group/subscribe requires a streaming caller');
        error.code = 'not_streaming';
        throw error;
      }
      return { text: 'ok' };
    },
  });
  const server = await startServer({ skills });
  try {
    const response = await rpc(server.baseUrl, { skill: 'session/ask' });
    assert.equal(emitSeen, undefined, 'a unary response has nowhere to put an unsolicited frame');
    assert.equal(response.error.code, -32004);
    assert.equal(response.error.data.code, 'not_streaming');
  } finally {
    await server.close();
  }
});

test('server: on a stream, emit turns each skill event into an artifact frame', async () => {
  const skills = fakeSkills({
    run: async (_input, context) => {
      context.emit('post', { seq: 1, text: 'first' });
      context.emit('post', { seq: 2, text: 'second' });
      return { text: 'done' };
    },
  });
  const server = await startServer({ skills });
  try {
    const { frames } = await readSse(server.baseUrl, { skill: 'session/ask' });
    const emitted = frames.map((frame) => frame.result?.artifactUpdate).filter((frame) => frame?.artifact?.name === 'post');
    assert.equal(emitted.length, 2, 'each emit must reach the peer as its own frame');
    assert.deepEqual(JSON.parse(emitted[0].artifact.parts[0].text), { seq: 1, text: 'first' });
    assert.deepEqual(JSON.parse(emitted[1].artifact.parts[0].text), { seq: 2, text: 'second' });
    assert.equal(frames[frames.length - 1].result.statusUpdate.final, true, 'the run still ends with one final frame');
  } finally {
    await server.close();
  }
});

test('server: untilCancelled rejects when the caller disconnects', async () => {
  let settled = 'pending';
  const skills = fakeSkills({
    run: async (_input, context) => {
      try {
        await context.untilCancelled();
        settled = 'resolved';
      } catch {
        settled = 'rejected';
        throw new Error('subscription ended');
      }
      return { text: 'unreachable' };
    },
  });
  const server = await startServer({ skills });
  try {
    await new Promise((resolve, reject) => {
      const body = sendMessageEnvelope({ skill: 'session/ask' });
      const req = httpRequest(
        { hostname: '127.0.0.1', port: server.port, path: '/a2a', method: 'POST', headers: { ...V1, 'content-length': Buffer.byteLength(body) } },
        () => {},
      );
      req.on('error', () => resolve());
      req.write(body);
      req.end();
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 80);
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(settled, 'rejected', 'a cancelled subscription must not look like a completed one');
  } finally {
    await server.close();
  }
});

test('server: a disconnect mid-run aborts the skill signal', async () => {
  let observed;
  const skills = fakeSkills({
    run: (_input, context) =>
      new Promise((resolve) => {
        observed = context.signal;
        // Hold the skill open until the caller hangs up.
        context.signal.addEventListener('abort', () => resolve({ text: 'aborted late' }), { once: true });
      }),
  });
  const server = await startServer({ skills });
  try {
    await new Promise((resolve, reject) => {
      const body = sendMessageEnvelope({ skill: 'session/ask' });
      const req = httpRequest(
        { hostname: '127.0.0.1', port: server.port, path: '/a2a', method: 'POST', headers: { ...V1, 'content-length': Buffer.byteLength(body) } },
        () => {},
      );
      req.on('error', () => resolve());
      req.write(body);
      req.end();
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 80);
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(observed?.aborted, true, 'the skill signal must be aborted when the caller leaves');
  } finally {
    await server.close();
  }
});
