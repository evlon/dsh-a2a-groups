#!/usr/bin/env node
// Inspect what `group/read` actually returns, without shell quoting games.
//
//   node scripts/aisix-dev/inspect-read.mjs
//
// The collab probe asserted on rendered text and failed; this prints the raw
// shape so a test asserts on the truth instead of on a guess.

const GATEWAY = process.env.A2A_GATEWAY ?? 'http://127.0.0.1:3000/a2a';
const KEY = process.env.A2A_KEY ?? 'sk-dev-niukl-2026';
const AGENT = process.env.A2A_HOST_AGENT ?? 'dsh-groups';

const headers = {
  'x-api-key': KEY,
  'x-forwarded-proto': 'http',
  'content-type': 'application/json',
  'a2a-version': '1.0',
};

async function call(skill, data = {}, text = skill) {
  const response = await fetch(`${GATEWAY}/${AGENT}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `i-${Math.random().toString(36).slice(2)}`,
      method: 'SendMessage',
      params: {
        message: {
          role: 'user',
          messageId: `m-${Math.random().toString(36).slice(2)}`,
          parts: [{ kind: 'text', text }],
          metadata: { skill, data },
        },
      },
    }),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${skill}: ${body.error.message} [${body.error.data?.code}]`);
  const task = body.result.task;
  const reply = (task.artifacts ?? []).flatMap((a) => a.parts ?? []).map((p) => p.text ?? '').join('\n');
  return { reply, data: task.metadata?.result };
}

const created = await call('group/create', { name: 'inspect', password: 'pw12345678' });
const groupId = /groupId\s*:\s*(\S+)/.exec(created.reply)[1];
const memberId = /memberId:\s*(\S+)/.exec(created.reply)[1];
const memberKey = /ownerKey:\s*(\S+)/.exec(created.reply)[1];
console.log('group:', groupId, 'member:', memberId);

await call('group/post', { groupId, memberId, memberKey, text: '第一条测试消息' });

const read = await call('group/read', { groupId, memberId, memberKey, sinceSeq: 0 });
console.log('\n--- group/read rendered TEXT ---');
console.log(JSON.stringify(read.reply, null, 2));

console.log('\n--- group/read structured data.entries ---');
console.log(JSON.stringify(read.data?.entries, null, 2));

console.log('\n--- fields present on one entry ---');
console.log(Object.keys(read.data?.entries?.[0] ?? {}).join(', '));
