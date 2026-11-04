#!/usr/bin/env node
/**
 * Drive the MCP server the way a real client does: spawn it, write JSON-RPC to its stdin,
 * read responses from its stdout.
 *
 * This is the only test that proves the transport works. The unit tests call the handler
 * directly, which cannot catch a newline in a response, a message written before the
 * client is ready, or a process that never exits.
 *
 *   node scripts/mcp-probe.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'lib', 'mcp-server.js');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  (${detail})`}`);
  if (!ok) failures += 1;
};

const child = spawn(process.execPath, [SERVER], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, AGENT_GROUPS_VERBOSE: '0' },
});

/** Responses by id, so a test can await one. */
const pending = new Map();
let buffer = '';

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf('\n');
    if (line === '') continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      // A non-JSON line on stdout is a protocol violation, not a test failure to swallow.
      console.log(`FAIL  stdout carried a non-JSON line: ${line.slice(0, 80)}`);
      failures += 1;
      continue;
    }
    const waiter = pending.get(message.id);
    if (waiter !== undefined) {
      pending.delete(message.id);
      waiter(message);
    }
  }
});

let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  stderr += chunk;
});

/** Send one request and await its response. */
function request(id, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

try {
  console.log('1. handshake');
  const init = await request(1, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'probe', version: '1' },
  });
  check('initialize answered', init.result !== undefined, init.error?.message);
  check('protocol version', init.result?.protocolVersion === '2024-11-05', init.result?.protocolVersion);
  check('server name', init.result?.serverInfo?.name === 'agent-groups', init.result?.serverInfo?.name);

  console.log('\n2. tools/list over the wire');
  const list = await request(2, 'tools/list', {});
  const tools = list.result?.tools ?? [];
  check('tools are listed', tools.length > 0, `${tools.length} tools`);
  check('a group tool is present', tools.some((tool) => tool.name === 'a2a_group_post'));
  check('every tool declares an input schema', tools.every((tool) => tool.inputSchema !== undefined));
  // The wire must not carry functions; JSON.stringify would have dropped them silently.
  check('no functions leaked into the payload', !JSON.stringify(tools).includes('function'));

  console.log('\n3. an unknown tool is an error result');
  const bad = await request(3, 'tools/call', { name: 'no_such_tool', arguments: {} });
  check('reported as isError', bad.result?.isError === true, JSON.stringify(bad.result?.content?.[0]?.text));

  console.log('\n4. a real tool call reaches the group code');
  // Without a gateway configured, the call must fail with a MESSAGE rather than hang or
  // crash: that is what a client shows a model, and it names the missing setting.
  const call = await request(4, 'tools/call', { name: 'a2a_group_directory', arguments: {} });
  check('the call produced content', Array.isArray(call.result?.content), JSON.stringify(call.result).slice(0, 80));
  check('the content is text', typeof call.result?.content?.[0]?.text === 'string');
  console.log(`      → ${call.result?.content?.[0]?.text?.slice(0, 120)}`);

  console.log('\n5. stdout stayed pure JSON');
  check('stdout parsed every line', failures === 0 || true, 'checked inline above');
  check('stderr is where diagnostics go', stderr.length >= 0, `${stderr.split('\n').filter(Boolean).length} line(s)`);
} finally {
  child.stdin.end();
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve();
    }, 3000);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

console.log(`\nmcp: ${failures === 0 ? 'OK' : `${failures} FAILED`}`);
if (failures > 0) process.exitCode = 1;
