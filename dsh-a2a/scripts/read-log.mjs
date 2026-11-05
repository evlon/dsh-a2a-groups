// Read a DSH session log and print a readable timeline.
//
// WHY THIS EXISTS
//
// Diagnosing this project kept failing the same way: the answer was in a session log, and getting it out required a
// throwaway script each time — and those scripts read the wrong fields. `isError` lives on
// `data.message.isError`, NOT on `data.isError`, so a first attempt silently reported every failed tool call as a
// success and made a working join look broken (and a broken one look fine).
//
// Usage:
//   node scripts/read-log.mjs <session.v4.jsonl.zstd>
//   node scripts/read-log.mjs --home C:/Users/niukl/.dsh-a2a-dev3 [--session <substring>]
//   node scripts/read-log.mjs ... --errors-only
//   node scripts/read-log.mjs ... --full        (no truncation)
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);

/** Read one flag value, or undefined. */
function flag(name) {
  const at = args.indexOf(name);
  return at > -1 && args[at + 1] !== undefined ? args[at + 1] : undefined;
}

const HOME = flag('--home');
const SESSION_HINT = flag('--session');
const ERRORS_ONLY = args.includes('--errors-only');
const FULL = args.includes('--full');
const LIMIT = FULL ? 400 : 110;

/** Locate the newest session log under a DSH home, optionally filtered by id substring. */
function findSession(home) {
  const root = join(home, 'sessions');
  const found = [];
  for (const workspace of readdirSync(root, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue;
    const wsPath = join(root, workspace.name);
    for (const session of readdirSync(wsPath, { withFileTypes: true })) {
      if (!session.isDirectory() || !session.name.startsWith('session-')) continue;
      if (SESSION_HINT !== undefined && !session.name.includes(SESSION_HINT)) continue;
      const file = join(wsPath, session.name, 'session.v4.jsonl.zstd');
      try {
        found.push({ file, at: statSync(file).mtimeMs, workspace: workspace.name, id: session.name });
      } catch {
        // A session directory without a log is normal; skip it.
      }
    }
  }
  found.sort((left, right) => right.at - left.at);
  return found[0];
}

/** Decode the zstd-framed JSONL into objects. */
function decode(file) {
  // The project already ships a decoder that walks every frame; reuse it rather than reimplementing frame splitting.
  const out = execFileSync(process.execPath, ['scripts/aisix-dev/read-session-log.mjs', file, 'type":', '5000'], {
    cwd: 'E:/dsh-a2a-bus/dsh-a2a',
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const rows = [];
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // A truncated tail line is expected when the process was killed mid-write.
    }
  }
  return rows;
}

/** One line for a tool call, marking failure from the CORRECT field. */
function describeResult(row) {
  const message = row?.data?.message ?? {};
  // The marker lives here. Reading `data.isError` always yields undefined and turns every failure into a success.
  const failed = message.isError === true;
  const text = (message.content ?? []).map((part) => String(part.text ?? '')).join(' ');
  return { failed, text: text.replace(/\r?\n/gu, ' ').slice(0, LIMIT) };
}

const target = flag('--file') !== undefined
  ? { file: flag('--file'), at: 0, workspace: '', id: flag('--file') }
  : (HOME === undefined ? undefined : findSession(HOME));

if (target === undefined) {
  console.error('usage: node scripts/read-log.mjs --home <dshHome> [--session <id>] [--errors-only] [--full]');
  console.error('       node scripts/read-log.mjs --file <session.v4.jsonl.zstd> ...');
  process.exit(2);
}

const rows = decode(target.file);
console.log(`file      ${target.file}`);
console.log(`workspace ${target.workspace}`);
console.log(`records   ${rows.length}`);
console.log('');

let callIndex = 0;
let failures = 0;
const pending = new Map();

for (const row of rows) {
  const type = row.type;

  if (type === 'user/message') {
    for (const part of row?.data?.content ?? []) {
      if (part.type !== 'text' || typeof part.text !== 'string' || part.text.trim() === '') continue;
      // Time-context and runtime-context blobs are noise for this purpose.
      if (part.text.startsWith('Time sampled') || part.text.startsWith('Current runtime context')) continue;
      console.log('USER> ' + part.text.replace(/\r?\n/gu, ' ').slice(0, LIMIT));
    }
    continue;
  }

  if (type === 'tool/call') {
    callIndex += 1;
    pending.set(row?.data?.callId, { name: row?.data?.name, args: row?.data?.arguments, index: callIndex });
    continue;
  }

  if (type === 'tool/result') {
    const { failed, text } = describeResult(row);
    if (ERRORS_ONLY && !failed) continue;
    // Pair with its call so a failure is not attributed to the wrong tool — the mistake that made a working join look
    // broken earlier. The id is `message.toolCallId` on the result and `callId` on the call.
    const call = pending.get(row?.data?.message?.toolCallId);
    const label = call === undefined ? '(unmatched)' : call.name;
    const argText = call === undefined ? '' : String(call.args ?? '').slice(0, 80);
    if (failed) failures += 1;
    console.log((failed ? '❌ ' : '   ') + '[' + (call?.index ?? '?') + '] ' + label + '  ' + argText);
    console.log('      ' + text);
    continue;
  }

  if (type === 'assistant/message') {
    for (const part of row?.data?.message?.content ?? []) {
      if (part.type !== 'text' || typeof part.text !== 'string' || part.text.trim() === '') continue;
      console.log('  AI> ' + part.text.replace(/\r?\n/gu, ' ').slice(0, LIMIT));
    }
  }
}

console.log('');
console.log(`tool calls: ${callIndex}   failures: ${failures}`);
