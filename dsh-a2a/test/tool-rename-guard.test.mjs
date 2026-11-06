/**
 * Guard against the failure modes that renaming five tools at once invites.
 *
 * WHY THIS FILE EXISTS
 *
 * The renames (`a2a_pending` → `a2a_inbox_check`, `a2a_group_role` → `a2a_group_set_card`, and three others) touched 26
 * files. Almost every one of those edits was mechanical, which is exactly the kind of change that looks complete and is
 * not: a reference in the panel's prompt text, a sentence in the MCP preamble, or a doc paragraph can keep pointing at
 * a name that no longer exists, and NOTHING fails — a model simply calls a tool that is not there.
 *
 * The reverse mistake is worse. A tool can be registered in the spec table and have no runtime body (or the other way
 * round), and the only symptom is a runtime `unknown tool` on first use.
 *
 * These tests are cheap and they fail loudly, which is what a rename needs.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';

import { allSpecs } from '../lib/shared/tool-specs.js';
import { createToolRuntime } from '../lib/shared/tool-runtime.js';

/** Every spec name, as a set. */
const specNames = new Set(allSpecs().map((spec) => spec.name));

/**
 * Names that must not come back.
 *
 * Kept as a list rather than deleted, because the reasoning is the point: each of these read as something other than
 * what it did, and the wrong reading is what caused a misuse.
 */
const RETIRED = [
  { old: 'a2a_pending', why: '读作「待办 / 待处理任务」，实际是「查群消息与私信」' },
  { old: 'a2a_group_role', why: '读作「查看我的角色」，实际是「写我自己的名片」' },
  { old: 'a2a_group_requests', why: '读作「所有申请」，实际是「等我审批的那些」' },
  { old: 'a2a_group_remove', why: '读作「退出群」，实际是「把别人移出群」' },
  { old: 'a2a_group_info', why: '名字带 info，却只返回人数，不返回是谁' },
];

/** Recursively collect source files under a directory. */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      walk(path, out);
    } else if (/\.(js|mjs|md)$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

test('no retired tool name appears anywhere in the shipped sources', () => {
  // A stale reference does not crash: it asks a model to call something that does not exist.
  const files = [...walk('lib'), ...walk('bin'), ...walk('docs'), 'client.js'];
  const offenders = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const { old } of RETIRED) {
      if (text.includes(old)) {
        const line = text.slice(0, text.indexOf(old)).split('\n').length;
        offenders.push(`${file}:${line}  ${old}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `retired names still referenced:\n${offenders.join('\n')}`);
});

test('the retired names are recorded here with a reason, not just deleted', () => {
  // Losing the reason means the next person re-introduces the clearer-sounding but ambiguous name.
  for (const entry of RETIRED) {
    assert.ok(typeof entry.why === 'string' && entry.why.length > 6, `${entry.old}: the reason must be written down`);
    assert.equal(specNames.has(entry.old), false, `${entry.old} must not be a live tool`);
  }
});

test('every spec has a runtime body, and every runtime body has a spec', () => {
  // The two tables are edited separately, so a rename that touches one and not the other leaves a tool that exists on
  // paper but throws `unknown tool` on the first real call.
  const runtime = createToolRuntime({
    config: { groups: {}, client: {}, server: {} },
    registry: { list: () => [], get: () => undefined, upsert: () => ({}), flush: async () => undefined },
    store: { has: () => false, list: () => [], snapshot: () => undefined },
    identities: { list: () => [], get: () => undefined, upsert: () => {}, flush: async () => undefined },
    logger: { info() {}, warn() {}, debug() {} },
    bridge: { send: async () => ({ data: {} }) },
    sessions: undefined,
    server: undefined,
    inbox: undefined,
  });
  const bodyNames = new Set(runtime.names());

  const missingBody = [...specNames].filter((name) => bodyNames.has(name) === false);
  const missingSpec = [...bodyNames].filter((name) => specNames.has(name) === false);

  // A runtime may expose helpers that are not tools; only the tool direction is a hard error.
  assert.deepEqual(missingBody, [], `specs with no runtime body:\n${missingBody.join('\n')}`);
  assert.deepEqual(missingSpec, [], `runtime bodies with no spec:\n${missingSpec.join('\n')}`);
});

test('the MCP preamble only names tools that exist', () => {
  // The preamble is prose the model is told to follow. A tool name in it that does not resolve reads as an instruction
  // to call something impossible, and the model has no way to tell that from a typo in its own plan.
  const source = readFileSync('lib/mcp-server.js', 'utf8');
  // Precise pattern on purpose: a loose /a2a_[a-z_]+/ would also match prose words and helper names.
  const mentioned = new Set(source.match(/\ba2a_(?:group_[a-z_]+|inbox_check|person_[a-z_]+|groups|agents|discover|send|stream|serve)\b/g) ?? []);
  const unknown = [...mentioned].filter((name) => specNames.has(name) === false);
  assert.deepEqual(unknown, [], `preamble names tools that do not exist:\n${unknown.join('\n')}`);
});

test('no top-level function is declared twice in the runtime module', () => {
  // Measured bug: a new helper named `displayNameOf(record, summary)` was added while an older `displayNameOf(exec)`
  // already existed. In the same module scope the SECOND definition wins, so every call received the wrong argument
  // shape and quietly returned undefined — a colleague's name simply disappeared from the output, with no error, no
  // warning, and every test still green.
  //
  // This is worth a structural test rather than care: the failure is silent by construction.
  const source = readFileSync('lib/shared/tool-runtime.js', 'utf8');
  const declared = [...source.matchAll(/^function\s+([A-Za-z0-9_$]+)\s*\(/gm)].map((match) => match[1]);
  const counts = new Map();
  for (const name of declared) counts.set(name, (counts.get(name) ?? 0) + 1);
  const duplicated = [...counts].filter(([, count]) => count > 1).map(([name, count]) => `${name} x${count}`);
  assert.deepEqual(duplicated, [], `declared more than once:\n${duplicated.join('\n')}`);
});
