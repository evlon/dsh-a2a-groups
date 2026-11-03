/**
 * A mock upstream A2A agent — A2A **1.0** wire format, JSON-RPC 2.0 over HTTP.
 *
 * Purpose: prove the AISIX `/a2a/<agent>` gateway path end to end before any
 * DSH plugin exists. It is deliberately dependency-free (`node:http` only) so
 * it can run anywhere node runs, including on the Windows side of a WSL
 * boundary.
 *
 * Wire contract this file implements (that is what AISIX pins with
 * `protocol_version: "1.0"` and announces in the `A2A-Version` header):
 *
 *   - methods are PascalCase: `SendMessage`, `SendStreamingMessage`,
 *     `GetTask`, `CancelTask`
 *   - a unary result is wrapped in the protobuf-JSON `oneof payload`:
 *     `{"result": {"task": {...}}}` or `{"result": {"message": {...}}}`
 *   - a streamed result is the same wrapper with `statusUpdate` /
 *     `artifactUpdate`
 *   - task states are the protobuf enum names: `TASK_STATE_WORKING`,
 *     `TASK_STATE_COMPLETED`, …
 *   - the message that carries the request lives at `params.message`, and its
 *     `parts` are `{kind: "text", text}` objects
 *   - an agent card is served at the RFC 8615 well-known path, and its
 *     `protocolVersion` is `"1.0"`; AISIX rewrites `url` and
 *     `supportedInterfaces[].url` to point back at the gateway
 *
 * Skills (the `message.metadata.skill` the caller names):
 *   - `echo`   — default. Returns the caller's text plus the headers AISIX
 *                injected, so a test can assert the credential and the
 *                `A2A-Version` header actually arrived.
 *   - `slow`   — streams three progress events over ~1.2s then completes, so
 *                SSE relay and time-to-first-event are observable.
 *
 * Usage:
 *   node mock-agent.mjs --port 3092 [--token <secret>]
 *
 * With `--token`, every request must carry it as `x-api-key` or
 * `Authorization: Bearer`, mirroring what AISIX sends for `auth_type: api_key`.
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.port ?? 3092);
const HOST = args.host ?? '0.0.0.0';
const TOKEN = typeof args.token === 'string' && args.token !== '' ? args.token : undefined;
const PUBLIC_URL = args.url ?? `http://127.0.0.1:${PORT}/a2a`;

/** @type {Map<string, object>} */
const tasks = new Map();

const server = createServer((req, res) => {
  void handle(req, res).catch((error) => {
    sendJson(res, 500, { error: String(error?.message ?? error) });
  });
});

server.listen(PORT, HOST, () => {
  log(`mock A2A 1.0 agent listening on http://${HOST}:${PORT}`);
  log(`  card:  ${PUBLIC_URL.replace(/\/a2a$/, '')}/.well-known/agent-card.json`);
  log(`  rpc:   ${PUBLIC_URL}`);
  log(`  auth:  ${TOKEN === undefined ? 'none' : 'x-api-key or bearer'}`);
});

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);
  const path = url.pathname;

  if (req.method === 'GET' && isCardPath(path)) {
    log(`card GET ${path} from ${req.socket.remoteAddress} headers=${JSON.stringify(req.headers)}`);
    if (!authorized(req)) return sendJson(res, 401, { error: 'missing or invalid credential' });
    return sendJson(res, 200, agentCard());
  }
  if (req.method === 'GET' && (path === '/livez' || path === '/readyz')) {
    return sendJson(res, 200, { status: 'ok' });
  }
  if (req.method !== 'POST') return sendJson(res, 405, { error: `method not allowed: ${req.method}` });

  if (!authorized(req)) {
    return sendJson(res, 401, rpcError(null, -32001, 'missing or invalid credential'));
  }
  const body = await readJson(req);
  if (body === undefined) return sendJson(res, 400, rpcError(null, -32700, 'invalid JSON'));

  const { id, method, params } = body;
  log(`rpc ${method} (A2A-Version=${req.headers['a2a-version'] ?? '(absent)'})`);

  if (method === 'SendStreamingMessage') return streamTask(req, res, id, params);
  if (method === 'SendMessage') return sendTask(res, id, params, req);
  if (method === 'GetTask') {
    const task = tasks.get(params?.id);
    if (task === undefined) return sendJson(res, 200, rpcError(id, -32001, `unknown task: ${params?.id}`));
    return sendJson(res, 200, { jsonrpc: '2.0', id, result: { task } });
  }
  if (method === 'CancelTask') {
    const task = tasks.get(params?.id);
    if (task === undefined) return sendJson(res, 200, rpcError(id, -32001, `unknown task: ${params?.id}`));
    task.status = { state: 'TASK_STATE_CANCELED', timestamp: now() };
    return sendJson(res, 200, { jsonrpc: '2.0', id, result: { task } });
  }
  return sendJson(res, 200, rpcError(id, -32601, `unknown method: ${method}`));
}

function sendTask(res, id, params, req) {
  const message = params?.message ?? {};
  const text = textOf(message);
  const skill = message?.metadata?.skill ?? 'echo';
  const taskId = randomUUID();
  const contextId = message?.contextId ?? randomUUID();
  const task = {
    id: taskId,
    contextId,
    status: { state: 'TASK_STATE_COMPLETED', timestamp: now() },
    artifacts: [
      {
        artifactId: 'artifact-1',
        name: 'reply',
        parts: [{ kind: 'text', text: replyFor(skill, text, req) }],
      },
    ],
    metadata: { skill },
  };
  tasks.set(taskId, task);
  return sendJson(res, 200, { jsonrpc: '2.0', id, result: { task } });
}

async function streamTask(req, res, id, params) {
  const message = params?.message ?? {};
  const text = textOf(message);
  const skill = message?.metadata?.skill ?? 'slow';
  const taskId = randomUUID();
  const contextId = message?.contextId ?? randomUUID();
  const task = { id: taskId, contextId, status: { state: 'TASK_STATE_WORKING', timestamp: now() }, artifacts: [] };
  tasks.set(taskId, task);

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  /**
   * Emit one status-update frame.
   *
   * `final` is a property of the STREAM, not of the state: it means "nothing
   * more is coming". Emitting it on a non-terminal state truncates the stream
   * for every correct client — a real bug this double originally had (`final:
   * state !== 'TASK_STATE_WORKING'`, which fires on `submitted`), caught by the
   * A2A client's own test suite. Terminal states only, except the explicit
   * final frame the caller writes itself.
   */
  const stage = (state, note) => {
    const event = {
      jsonrpc: '2.0',
      id,
      result: {
        statusUpdate: {
          taskId,
          contextId,
          status: { state, timestamp: now(), message: { role: 'agent', messageId: randomUUID(), parts: [{ kind: 'text', text: note }] } },
          final: false,
        },
      },
    };
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    return event;
  };

  stage('TASK_STATE_SUBMITTED', 'accepted');
  for (const note of ['reading the request', 'working on it', 'rounding up']) {
    await sleep(400);
    stage('TASK_STATE_WORKING', note);
  }
  await sleep(200);
  const answer = replyFor(skill, text, req);
  const artifactEvent = {
    jsonrpc: '2.0',
    id,
    result: {
      artifactUpdate: {
        taskId,
        contextId,
        artifact: { artifactId: 'artifact-1', name: 'reply', parts: [{ kind: 'text', text: answer }] },
        append: false,
        lastChunk: true,
      },
    },
  };
  res.write(`data: ${JSON.stringify(artifactEvent)}\n\n`);
  task.status = { state: 'TASK_STATE_COMPLETED', timestamp: now() };
  task.artifacts = [artifactEvent.result.artifactUpdate.artifact];
  const finalEvent = {
    jsonrpc: '2.0',
    id,
    result: { statusUpdate: { taskId, contextId, status: { state: 'TASK_STATE_COMPLETED', timestamp: now() }, final: true } },
  };
  res.write(`data: ${JSON.stringify(finalEvent)}\n\n`);
  res.end();
}

/** The card AISIX fetches and rewrites. */
function agentCard() {
  return {
    name: 'mock-a2a-agent',
    description: 'Dependency-free A2A 1.0 test double used to verify the AISIX /a2a gateway path.',
    url: PUBLIC_URL,
    version: '0.1.0',
    protocolVersion: '1.0',
    preferredTransport: 'JSONRPC',
    capabilities: { streaming: true, pushNotifications: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    supportedInterfaces: [{ url: PUBLIC_URL, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    skills: [
      { id: 'echo', name: 'Echo', description: 'Return the text it received, plus the headers the gateway injected.', tags: ['test'] },
      { id: 'slow', name: 'Slow progress', description: 'Stream progress events for about a second, then answer.', tags: ['test'] },
    ],
  };
}

function replyFor(skill, text, req) {
  // Plain `key=value` lines on purpose: a shell assertion can grep them without
  // fighting nested JSON quoting. What matters is that each fact came back
  // through the gateway, so a test can prove the credential and the A2A-Version
  // header actually reached the upstream.
  const lines = [
    `skill=${skill}`,
    `text=${text}`,
    `a2a-version=${req.headers['a2a-version'] ?? '(absent)'}`,
    `api-key-present=${typeof req.headers['x-api-key'] === 'string' && req.headers['x-api-key'] !== ''}`,
    `authorization-present=${typeof req.headers.authorization === 'string'}`,
    `content-type=${req.headers['content-type'] ?? '(absent)'}`,
  ];
  return lines.join('\n');
}

function textOf(message) {
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  return parts
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .filter((text) => text !== '')
    .join('\n');
}

function isCardPath(path) {
  return path === '/.well-known/agent-card.json'
    || path === '/.well-known/agent.json'
    || path === '/a2a/.well-known/agent-card.json'
    || path === '/a2a/.well-known/agent.json';
}

function authorized(req) {
  if (TOKEN === undefined) return true;
  if (req.headers['x-api-key'] === TOKEN) return true;
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function now() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message) {
  process.stdout.write(`[mock-a2a] ${message}\n`);
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      out[key] = 'true';
      continue;
    }
    out[key] = value;
    index += 1;
  }
  return out;
}
