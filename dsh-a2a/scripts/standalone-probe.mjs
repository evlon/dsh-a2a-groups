#!/usr/bin/env node
/**
 * Exercise a STANDALONE group host over plain A2A.
 *
 * No DSH anywhere in this script: it talks to `bin/dsh-groups.js` the way a member
 * instance would, which is the claim this rewrite makes. If this passes, the host
 * really does not need a DSH to run.
 *
 *   node scripts/standalone-probe.mjs [--port 3096] [--token ...]
 */

const args = process.argv.slice(2);
const flagOf = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};

const PORT = Number(flagOf('port', 3096));
const TOKEN = flagOf('token', 'test-token-2026');
const BASE = `http://127.0.0.1:${PORT}/a2a`;

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  (${detail})`}`);
  if (!ok) failures += 1;
};

const headers = {
  'content-type': 'application/json',
  'a2a-version': '1.0',
  ...(TOKEN === undefined ? {} : { authorization: `Bearer ${TOKEN}` }),
};

let counter = 0;
async function call(skill, data = {}) {
  counter += 1;
  const response = await fetch(BASE, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `s-${counter}`,
      method: 'SendMessage',
      params: {
        message: {
          role: 'user',
          messageId: `m-${counter}`,
          parts: [{ kind: 'text', text: skill }],
          metadata: { skill, data },
        },
      },
    }),
  });
  const body = await response.json();
  if (body.error) {
    const error = new Error(`${skill}: ${body.error.message}`);
    error.code = body.error.data?.code;
    throw error;
  }
  const task = body.result.task;
  return {
    text: (task.artifacts ?? []).flatMap((a) => a.parts ?? []).map((p) => p.text ?? '').join('\n'),
    data: task.metadata?.result,
    state: task.status?.state,
  };
}

// ---------------------------------------------------------------------------
console.log(`standalone host at ${BASE}\n`);

console.log('1. the card is served without a credential, and names no group');
const cardResponse = await fetch(`${BASE}/.well-known/agent-card.json`);
check('card reachable', cardResponse.status === 200, String(cardResponse.status));
const card = await cardResponse.json();
check('card is A2A 1.0', card.protocolVersion === '1.0', card.protocolVersion);
check('card offers group skills', (card.skills ?? []).some((s) => s.id === 'group/create'));
check('card leaks no group', !JSON.stringify(card).includes('groupId'));

console.log('\n2. a group is created, with no password anywhere');
const name = `独立宿主群-${Date.now() % 100000}`;
const created = await call('group/create', { name, topic: '验证不需要 DSH', ownerDisplayName: '张工' });
const groupId = /groupId\s*:\s*(\S+)/.exec(created.text)?.[1];
const ownerId = /memberId:\s*(\S+)/.exec(created.text)?.[1];
const ownerKey = /ownerKey:\s*(\S+)/.exec(created.text)?.[1];
check('group created', groupId !== undefined, groupId);
check('the response carries no password', !/password/i.test(created.text));

console.log('\n3. an invite needs only the owner key, and states its own expiry');
const invited = await call('group/invite', { groupId, memberId: ownerId, memberKey: ownerKey });
const token = /[?&]t=([A-Za-z0-9_-]+)/.exec(invited.text)?.[1];
check('invite minted', token !== undefined, token === undefined ? '' : token.slice(0, 12));
check('the prompt mentions no password', !/群密码/.test(invited.text));
check('the prompt says the owner can revoke', /可以随时撤销/.test(invited.text));

console.log('\n4. joining takes the token and nothing else');
const joined = await call('group/join', { groupId, token, displayName: '李四' });
const guestKey = /memberKey:\s*(\S+)/.exec(joined.text)?.[1];
check('joined with only a token', guestKey !== undefined, 'ok');
check('the guest got a distinct member id', /memberId\s*:\s*(\S+)/.exec(joined.text)?.[1] !== ownerId);

console.log('\n5. the invite has no use counter: it admits a second person');
const second = await call('group/join', { groupId, token, displayName: '王五' });
check('a second person joined with the same link', /memberKey:\s*(\S+)/.test(second.text), 'ok');

console.log('\n6. the directory lists the group without any credential');
const guestId = /memberId\s*:\s*(\S+)/.exec(joined.text)?.[1];
const dir = await call('group/directory', {});
const row = (dir.data?.groups ?? []).find((group) => group.groupId === groupId);
check('the group is listed', row !== undefined, row?.name);
check('the count is right', row?.memberCount === 3, `${row?.memberCount}`);
check('no member identity in the directory', !JSON.stringify(dir.data).includes('李四'));
// The topic IS published on purpose — it is how a person decides whether to ask to
// join. What must not leak is the feed: no post body, no sender, no seq counter.
const serializedDir = JSON.stringify(dir.data);
check('the topic is published (it is how you decide)', serializedDir.includes('验证不需要 DSH'), 'topic present');
check('no feed body in the directory', !serializedDir.includes('我是李四'), 'no post text');
check('no feed entries in the directory', !/"feed"|"entries"|"text":/.test(serializedDir), 'no feed shape');

console.log('\n7. posting and reading need a member credential');
const posted = await call('group/post', { groupId, memberId: guestId, memberKey: guestKey, text: '我是李四，已加入' });
check('the guest can post', posted.data !== undefined || posted.text !== '', 'ok');
const read = await call('group/read', { groupId, memberId: ownerId, memberKey: ownerKey, sinceSeq: 0 });
check('the owner sees the post', /我是李四/.test(read.text), 'ok');
const refused = await call('group/read', { groupId, memberId: ownerId, memberKey: 'mk_wrong' })
  .catch((error) => error);
check('a wrong credential is refused', refused instanceof Error, refused.code ?? 'no error');

console.log('\n8. an unlisted group is absent from the directory');
const secret = await call('group/create', { name: `秘密群-${Date.now() % 10000}`, ownerDisplayName: '张工', visibility: 'unlisted' });
const secretId = /groupId\s*:\s*(\S+)/.exec(secret.text)?.[1];
const afterSecret = await call('group/directory', {});
check('unlisted group created', secretId !== undefined, secretId);
check('unlisted group is not listed',
  !(afterSecret.data?.groups ?? []).some((group) => group.groupId === secretId), 'absent');

console.log(`\nstandalone: ${failures === 0 ? 'OK' : `${failures} FAILED`}`);
if (failures > 0) process.exitCode = 1;
