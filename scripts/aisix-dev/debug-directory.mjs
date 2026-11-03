#!/usr/bin/env node
// Why does a search for the "secret" group still return rows?
//
// Prints every directory row whose name or topic matches, with its visibility as
// the host sees it. If older groups from earlier runs share the same name, that is
// a test-data artefact rather than a leak — and this tells the two apart.
import { readFileSync } from 'node:fs';

const GATEWAY = process.env.A2A_GATEWAY ?? 'http://127.0.0.1:3000/a2a';
const KEY = process.env.A2A_KEY ?? 'sk-dev-niukl-2026';
const HOST = process.env.A2A_HOST_AGENT ?? 'dsh-groups';
const QUERY = process.argv[2] ?? '秘密群';

const headers = {
  'x-api-key': KEY,
  'x-forwarded-proto': 'http',
  'content-type': 'application/json',
  'a2a-version': '1.0',
};

const response = await fetch(`${GATEWAY}/${HOST}`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 'q1',
    method: 'SendMessage',
    params: {
      message: {
        role: 'user',
        messageId: 'm-q1',
        parts: [{ kind: 'text', text: 'search' }],
        metadata: { skill: 'group/directory', data: { query: QUERY } },
      },
    },
  }),
});
const body = await response.json();
if (body.error) {
  console.error(body.error);
  process.exit(1);
}
const task = body.result.task;
const meta = task.metadata?.result ?? {};
console.log(`query "${QUERY}" → ${meta.total} row(s)`);
for (const row of meta.groups ?? []) {
  console.log(`  ${row.groupId}  ${row.name}  members=${row.memberCount}`);
}

// And the raw file, to show whether the hidden ones are marked hidden.
const file = process.env.GROUPS_FILE;
if (file !== undefined) {
  const state = JSON.parse(readFileSync(file, 'utf8'));
  console.log('\n--- groups.json ---');
  for (const group of state.groups ?? []) {
    console.log(`  ${group.groupId}  ${group.name}  visibility=${group.settings?.visibility ?? '(absent→public)'}`);
  }
}
