#!/usr/bin/env node
/**
 * Layer B verification: the card's identity is derived from group memberships.
 *
 * The property that matters is not "a field exists" but "nobody maintains it":
 * join a group, declare a role there, and the card a peer reads changes — with no
 * profile form, no config edit, no restart.
 *
 *   node scripts/aisix-dev/probe-profile.mjs
 */

const GATEWAY = process.env.A2A_GATEWAY ?? 'http://127.0.0.1:3000/a2a';
const KEY = process.env.A2A_KEY ?? 'sk-dev-niukl-2026';
const AGENT = process.env.A2A_HOST_AGENT ?? 'dsh-groups';
const DIRECT = process.env.A2A_HOST_DIRECT ?? 'http://127.0.0.1:3095/a2a';

const headers = {
  'x-api-key': KEY,
  'x-forwarded-proto': 'http',
  'content-type': 'application/json',
  'a2a-version': '1.0',
};

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  (${detail})`}`);
  if (!ok) failures += 1;
};

async function call(skill, data = {}, text = skill) {
  const response = await fetch(`${GATEWAY}/${AGENT}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `p-${Math.random().toString(36).slice(2)}`,
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
  if (body.error) throw new Error(`${skill}: ${body.error.message}`);
  const task = body.result.task;
  return {
    text: (task.artifacts ?? []).flatMap((a) => a.parts ?? []).map((p) => p.text ?? '').join('\n'),
    data: task.metadata?.result,
  };
}

/** Read the card the way a peer would. */
async function cardViaGateway() {
  const response = await fetch(`${GATEWAY}/${AGENT}/.well-known/agent-card.json`, {
    headers: { 'x-api-key': KEY, 'x-forwarded-proto': 'http' },
  });
  return response.ok ? response.json() : undefined;
}

const card = await cardViaGateway();
check('card readable through the gateway', card !== undefined, AGENT);

// ---------------------------------------------------------------------------
console.log('\n1. the card carries the profile extension');
const ext = card?.['x-dsh-profiles'];
console.log(`   card name        : ${card?.name}`);
console.log(`   card description  : ${card?.description}`);
check('card name is not the generic default', card?.name !== undefined && card.name !== 'dsh-a2a', card?.name);
check('card description is a derived headline, not the boilerplate',
  typeof card?.description === 'string' && !card.description.startsWith('Exposes a DSH Session'), card?.description);
if (ext === undefined) {
  console.log('   (no x-dsh-profiles yet — this instance has no group memberships)');
} else {
  check('x-dsh-profiles carries groups', Array.isArray(ext.groups) && ext.groups.length > 0,
    `${ext.groups?.length} group(s)`);
  check('x-dsh-profiles carries the aggregated tags', Array.isArray(ext.tags) && ext.tags.length > 0,
    JSON.stringify(ext.tags));
}

// ---------------------------------------------------------------------------
console.log('\n2. joining a group and declaring a role changes the card');
const before = await cardViaGateway();
const beforeCount = before?.['x-dsh-profiles']?.groups?.length ?? 0;

const created = await call('group/create', { name: '名片验证群'});
const groupId = /groupId\s*:\s*(\S+)/.exec(created.text)[1];
const personId = /personId:\s*(\S+)/.exec(created.text)[1];
const personKey = /ownerKey:\s*(\S+)/.exec(created.text)[1];

await call('group/role', {
  groupId, personId, personKey,
  about: '在这个群负责名片验证',
  tags: ['验证', '名片'],
});

const after = await cardViaGateway();
const afterCount = after?.['x-dsh-profiles']?.groups?.length ?? 0;
check('the new group appeared in the card without any config edit', afterCount > beforeCount,
  `${beforeCount} → ${afterCount}`);

const mine = (after?.['x-dsh-profiles']?.groups ?? []).find((group) => group.groupId === groupId);
check('the declared role is in the card', mine?.roleAbout === '在这个群负责名片验证', mine?.roleAbout);
check('the declared tags are in the card', JSON.stringify(mine?.tags) === JSON.stringify(['验证', '名片']),
  JSON.stringify(mine?.tags));
check('the newly declared tag reached the card headline',
  (after?.['x-dsh-profiles']?.tags ?? []).includes('验证'), JSON.stringify(after?.['x-dsh-profiles']?.tags));

// ---------------------------------------------------------------------------
console.log('\n3. changing the role updates the card on the next read');
await call('group/role', { groupId, personId, personKey, about: '角色已经改了', tags: ['改名'] });
const reread = await cardViaGateway();
const updated = (reread?.['x-dsh-profiles']?.groups ?? []).find((group) => group.groupId === groupId);
check('the card shows the new role', updated?.roleAbout === '角色已经改了', updated?.roleAbout);
check('the old tag is gone from that group', !(updated?.tags ?? []).includes('验证'),
  JSON.stringify(updated?.tags));

// ---------------------------------------------------------------------------
console.log('\n4. a hidden check: the card never leaks a credential');
const serialized = JSON.stringify(reread ?? {});
check('no personKey in the card', !serialized.includes(personKey), 'no key');
check('no password in the card', !serialized.includes('pw22223333'), 'no password');

console.log(`\nprofile: ${failures === 0 ? 'OK' : `${failures} FAILED`}`);
if (failures > 0) process.exitCode = 1;
void DIRECT;
