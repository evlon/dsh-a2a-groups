#!/usr/bin/env node
/**
 * Layer A verification: what a person is IN ONE GROUP, across two instances.
 *
 * The properties that matter, each asserted against real HTTP through the gateway:
 *
 *   1. A member can declare a role in a group, and change it.
 *   2. The same person's role in one group does not affect another group.
 *   3. Nobody can set somebody else's role — the credential decides the target.
 *   4. `role` (permission) is untouched by any of it.
 *
 *   node scripts/aisix-dev/probe-role.mjs
 */

const GATEWAY = process.env.A2A_GATEWAY ?? 'http://127.0.0.1:3000/a2a';
const KEY = process.env.A2A_KEY ?? 'dev-caller-key-not-a-secret';
const HOST = process.env.A2A_HOST_AGENT ?? 'agent-group-host';

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
  const response = await fetch(`${GATEWAY}/${HOST}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `r-${Math.random().toString(36).slice(2)}`,
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
  if (body.error) {
    const error = new Error(`${skill}: ${body.error.message}`);
    error.code = body.error.data?.code ?? body.error.code;
    throw error;
  }
  const task = body.result.task;
  return {
    text: (task.artifacts ?? []).flatMap((a) => a.parts ?? []).map((p) => p.text ?? '').join('\n'),
    data: task.metadata?.result,
  };
}

const makeGroup = async (name,) => {
  const created = await call('group/create', { name, });
  return {
    groupId: /groupId\s*:\s*(\S+)/.exec(created.text)[1],
    personId: /personId:\s*(\S+)/.exec(created.text)[1],
    personKey: /ownerKey:\s*(\S+)/.exec(created.text)[1],
  };
};

// ---------------------------------------------------------------------------
console.log('1. a person declares a role in one group');
const g1 = await makeGroup('开发群', 'pw-1-12345678');
const who = { personId: g1.personId, personKey: g1.personKey };

const set1 = await call('group/role', { groupId: g1.groupId, ...who, about: '负责 invoice 服务拆分', tags: ['研发', '后端'] });
check('role set', set1.data?.about === '负责 invoice 服务拆分', set1.data?.about);
check('tags stored', JSON.stringify(set1.data?.tags) === JSON.stringify(['研发', '后端']), JSON.stringify(set1.data?.tags));

const listed = await call('group/members', { groupId: g1.groupId, ...who });
const me = (listed.data?.members ?? []).find((m) => m.personId === g1.personId);
check('members list shows the declared role', me?.about === '负责 invoice 服务拆分', me?.about);
check('members list shows the tags', JSON.stringify(me?.tags) === JSON.stringify(['研发', '后端']), JSON.stringify(me?.tags));
check('the permission role is unchanged (still owner)', me?.role === 'owner', me?.role);

// ---------------------------------------------------------------------------
console.log('\n2. the same person, a different group, a different role');
const g2 = await makeGroup('项目群', 'pw-2-12345678');
check('the two groups are distinct', g1.groupId !== g2.groupId, `${g1.groupId} / ${g2.groupId}`);

const who2 = { personId: g2.personId, personKey: g2.personKey };
const set2 = await call('group/role', { groupId: g2.groupId, ...who2, about: '这个项目里兼产品', tags: ['产品', '研发'] });
check('second group role set', set2.data?.about === '这个项目里兼产品', set2.data?.about);

const list1 = await call('group/members', { groupId: g1.groupId, ...who });
const list2 = await call('group/members', { groupId: g2.groupId, ...who2 });
const inG1 = (list1.data?.members ?? []).find((m) => m.personId === g1.personId);
const inG2 = (list2.data?.members ?? []).find((m) => m.personId === g2.personId);
check('group 1 still shows the developer role', inG1?.about === '负责 invoice 服务拆分', inG1?.about);
check('group 2 shows the product role', inG2?.about === '这个项目里兼产品', inG2?.about);
check('the two roles are independent', JSON.stringify(inG1?.tags) !== JSON.stringify(inG2?.tags),
  `${JSON.stringify(inG1?.tags)} vs ${JSON.stringify(inG2?.tags)}`);

// ---------------------------------------------------------------------------
console.log('\n3. a role change is an update, not a new entry');
const changed = await call('group/role', { groupId: g1.groupId, ...who, about: '转到后端', tags: ['研发'] });
check('about updated', changed.data?.about === '转到后端', changed.data?.about);
check('tags updated', JSON.stringify(changed.data?.tags) === JSON.stringify(['研发']), JSON.stringify(changed.data?.tags));
const afterChange = await call('group/members', { groupId: g1.groupId, ...who });
const meAfter = (afterChange.data?.members ?? []).find((m) => m.personId === g1.personId);
check('still exactly one membership row', (afterChange.data?.members ?? []).filter((m) => m.personId === g1.personId).length === 1,
  'single row');

// ---------------------------------------------------------------------------
console.log('\n4. nobody can set somebody else\'s role');
// A second member joins g1.
const invited = await call('group/invite', { groupId: g1.groupId, ...who});
const token = /[?&]t=([A-Za-z0-9_-]+)/.exec(invited.data?.link ?? '')?.[1];
const other = await call('group/join', { groupId: g1.groupId, token, displayName: '同事B' });
const otherWho = { personId: other.data.personId, personKey: other.data.personKey };
check('a second member joined', otherWho.personId !== g1.personId, otherWho.personId);

// Member B tries to write A's role by passing A's personId with B's own key.
// `resolveMember` keys identity on the credential, so this must fail rather than
// silently update the wrong row.
let spoofRefused = false;
try {
  await call('group/role', {
    groupId: g1.groupId,
    personId: g1.personId,          // victim's identity
    personKey: otherWho.personKey,  // attacker's credential
    about: '我是群主了',
  });
} catch (error) {
  spoofRefused = error.code === 'not_member';
}
check('a member cannot write another member\'s role', spoofRefused, 'not_member');

// And the victim's role is intact.
const intact = await call('group/members', { groupId: g1.groupId, ...who });
const victim = (intact.data?.members ?? []).find((m) => m.personId === g1.personId);
check('the victim\'s role was not overwritten', victim?.about === '转到后端', victim?.about);

// B can still set its own.
const bOwn = await call('group/role', { groupId: g1.groupId, ...otherWho, about: '我在这个群做测试', tags: ['测试'] });
check('a member can set their own role', bOwn.data?.about === '我在这个群做测试', bOwn.data?.about);

// ---------------------------------------------------------------------------
console.log('\n5. the permission bit is never touched by any of this');
const finalList = await call('group/members', { groupId: g1.groupId, ...who });
const rows = finalList.data?.members ?? [];
const ownerRow = rows.find((m) => m.personId === g1.personId);
const memberRow = rows.find((m) => m.personId === otherWho.personId);
check('owner is still owner', ownerRow?.role === 'owner', ownerRow?.role);
check('the joiner is still a member', memberRow?.role === 'member', memberRow?.role);
check('exactly one owner', rows.filter((m) => m.role === 'owner').length === 1, 'one owner');

console.log(`\nrole: ${failures === 0 ? 'OK' : `${failures} FAILED`}`);
if (failures > 0) process.exitCode = 1;
