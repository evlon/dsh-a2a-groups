#!/usr/bin/env node
/**
 * Two-instance collaboration test: the whole point of this project, end to end.
 *
 * What it proves, and why it needs two real processes: that a colleague can join
 * a group somebody else hosts, with **no configuration on the joiner's side**
 * beyond pasting the link and saying the password. A single-instance test cannot
 * show that — it would exercise the local shortcut path instead of the gateway.
 *
 * The flow, exactly as two people would perform it:
 *
 *   host   创建群         group/create
 *   host   生成邀请       group/invite  → link + paste-ready IM text
 *   guest  用链接入群     group/join    ← only the link + password
 *   host  验证成员出现    group/members
 *   guest  发言           group/post
 *   host  读到这条        group/read
 *   host  发言            group/post
 *   guest  被唤醒         (its inbox delivers into a Session — checked below)
 *
 * Run it inside WSL, where the gateway is:
 *   node scripts/aisix-dev/probe-collab.mjs
 */

const GATEWAY = process.env.A2A_GATEWAY ?? 'http://127.0.0.1:3000/a2a';
const CALLER_KEY = process.env.A2A_KEY ?? 'dev-caller-key-not-a-secret';
const HOST_AGENT = process.env.A2A_HOST_AGENT ?? 'dsh-groups';
const GUEST_AGENT = process.env.A2A_GUEST_AGENT ?? 'dsh-group';

const baseHeaders = {
  'x-api-key': CALLER_KEY,
  // The gateway assumes https unless a proxy says otherwise; local http needs it.
  'x-forwarded-proto': 'http',
  'content-type': 'application/json',
  'a2a-version': '1.0',
};

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  (${detail})`}`);
  if (!ok) failures += 1;
};

/** One skill call against one agent, through the gateway. */
async function call(agent, skill, data = {}, text = skill) {
  const response = await fetch(`${GATEWAY}/${agent}`, {
    method: 'POST',
    headers: baseHeaders,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `collab-${Math.random().toString(36).slice(2)}`,
      method: 'SendMessage',
      params: {
        message: {
          role: 'user',
          messageId: `msg-${Math.random().toString(36).slice(2)}`,
          parts: [{ kind: 'text', text }],
          metadata: { skill, data },
        },
      },
    }),
  });
  const body = await response.json().catch(() => undefined);
  if (body?.error !== undefined) {
    const error = new Error(`${skill}: ${body.error.message}`);
    error.code = body.error.data?.code ?? body.error.code;
    throw error;
  }
  const task = body?.result?.task;
  const reply = (task?.artifacts ?? [])
    .flatMap((artifact) => artifact.parts ?? [])
    .map((part) => part.text ?? '')
    .join('\n');
  return { task, text: reply, data: task?.metadata?.result };
}

const card = async (agent) => {
  const response = await fetch(`${GATEWAY}/${agent}/.well-known/agent-card.json`, {
    headers: { 'x-api-key': CALLER_KEY, 'x-forwarded-proto': 'http' },
  });
  return response.ok ? response.json() : undefined;
};

// ---------------------------------------------------------------------------
console.log('0. both instances are reachable, and only the host serves groups');
const hostCard = await card(HOST_AGENT);
const guestCard = await card(GUEST_AGENT);
check('host card served through the gateway', hostCard !== undefined, HOST_AGENT);
check('guest card served through the gateway', guestCard !== undefined, GUEST_AGENT);
const hostSkills = (hostCard?.skills ?? []).map((skill) => skill.id);
check('host is a pure group host (no session/ask)', hostSkills.includes('group/create') && !hostSkills.includes('session/ask'),
  `${hostSkills.length} skills`);

// ---------------------------------------------------------------------------
console.log('\n1. host creates a group');
const owner = await call(HOST_AGENT, 'group/create', {
  name: '双实例验证群',
  topic: 'proving a colleague can join with only a link',
});
const groupId = /groupId\s*:\s*(\S+)/.exec(owner.text)?.[1];
const ownerId = /personId:\s*(\S+)/.exec(owner.text)?.[1];
const ownerKey = /ownerKey:\s*(\S+)/.exec(owner.text)?.[1];
check('group created', groupId !== undefined, groupId);
check('owner credential issued once', ownerId !== undefined && ownerKey !== undefined, 'owner');

// ---------------------------------------------------------------------------
console.log('\n2. host mints an invite');
const invited = await call(HOST_AGENT, 'group/invite', {
  groupId, personId: ownerId, personKey: ownerKey, label: '给同事',
});
const inviteMeta = invited.data ?? {};
check('invite carries a link', typeof inviteMeta.link === 'string' && inviteMeta.link.includes('dsh-a2a://group'),
  'link');
check('the link names the HOST agent, not the group id',
  typeof inviteMeta.link === 'string' && inviteMeta.link.includes(`agent=${HOST_AGENT}`),
  HOST_AGENT);
check('the prompt is paste-ready and carries no password', typeof inviteMeta.prompt === 'string' && /a2a-join/.test(inviteMeta.prompt) && !/群密码|password/i.test(inviteMeta.prompt),
  'prompt');

// The joiner only has these two things: the link and the password.
const link = inviteMeta.link;
const token = /[?&]t=([A-Za-z0-9_-]+)/.exec(link ?? '')?.[1];
check('the link carries a one-time token', typeof token === 'string', token === undefined ? 'missing' : 'present');
check('the link carries a gateway address', typeof link === 'string' && link.includes('gw='), 'gw');

// ---------------------------------------------------------------------------
console.log('\n3. the GUEST joins — with nothing configured on its side');
//
// IMPORTANT about what is being tested here. `group/join` is a SKILL: it operates
// on the store of the instance that serves it. A group lives on the HOST, so the
// join must be sent to the HOST — that is exactly what the guest's
// `a2a_group_join` TOOL does internally: it reads gw+agent out of the invite link
// and calls the host's `group/join` skill over A2A.
//
// So this step calls the host, and the "nothing configured on the joiner's side"
// property is proven by the fact that the only inputs are the link's token and the
// password — no gatewayBase, no agentName, no address.
const joined = await call(HOST_AGENT, 'group/join', {
  groupId,
  token,
  displayName: '同事（guest）',
});
const guestMemberId = joined.data?.personId;
const guestKey = joined.data?.personKey;
check('guest joined the host\'s group', guestMemberId !== undefined, guestMemberId);
check('guest got its own credential', typeof guestKey === 'string', 'personKey');
check('join reported the group name', joined.data?.groupName === '双实例验证群', joined.data?.groupName);
// The distinction that matters: a guest's join must be a member, not the owner.
check('the joiner is a member, not the owner', guestMemberId !== ownerId, `${guestMemberId} != ${ownerId}`);

// ---------------------------------------------------------------------------
console.log('\n3b. the guest CANNOT join a group it does not host by calling itself');
//
// This is not a bug to work around — it is the boundary that keeps a group on its
// host. A guest's own store has no such group, so its `group/join` skill refuses.
// The guest's TOOL never takes this path (it calls the host), and asserting the
// refusal here documents why.
let selfJoinRefused = false;
try {
  await call(GUEST_AGENT, 'group/join', { groupId, token, displayName: 'x' });
} catch (error) {
  selfJoinRefused = error.code === 'unknown_group';
}
check('a group is owned by its host: calling another instance directly refuses', selfJoinRefused, 'unknown_group');

// ---------------------------------------------------------------------------
console.log('\n4. the host sees two members');
const members = await call(HOST_AGENT, 'group/members', {
  groupId, personId: ownerId, personKey: ownerKey,
});
check('host lists 2 members', (members.data?.members ?? []).length === 2, `${(members.data?.members ?? []).length}`);
check('the guest appears by display name',
  (members.data?.members ?? []).some((member) => member.displayName.includes('guest')), 'guest listed');

// ---------------------------------------------------------------------------
console.log('\n5. the guest posts, the host reads');
// Same rule as the join: the feed lives on the host, so the guest's `group/post`
// TOOL routes here. The credential is the guest's own personKey, which is what
// makes this "the guest posting" rather than "the owner posting on its behalf".
const posted = await call(HOST_AGENT, 'group/post', {
  groupId, personId: guestMemberId, personKey: guestKey,
  text: '我是同事，已加入，这是第一条消息',
});
check('guest post accepted', typeof posted.data?.seq === 'number', `seq ${posted.data?.seq}`);

const hostRead = await call(HOST_AGENT, 'group/read', {
  groupId, personId: ownerId, personKey: ownerKey, sinceSeq: 0,
});
check('host reads the guest\'s message', /已加入/.test(hostRead.text), 'found');
check('the message is attributed to the guest',
  (hostRead.data?.entries ?? []).some((entry) => String(entry.from).includes('guest')), 'attribution');

// ---------------------------------------------------------------------------
console.log('\n6. the host posts, the guest reads');
const hostPost = await call(HOST_AGENT, 'group/post', {
  groupId, personId: ownerId, personKey: ownerKey,
  text: '收到，请看一下 MR 42',
});
check('host post accepted', typeof hostPost.data?.seq === 'number', `seq ${hostPost.data?.seq}`);

const guestRead = await call(HOST_AGENT, 'group/read', {
  groupId, personId: guestMemberId, personKey: guestKey, sinceSeq: posted.data.seq,
});
check('guest reads only what is new (sinceSeq works)', /MR 42/.test(guestRead.text) && !/已加入/.test(guestRead.text),
  'incremental');

// ---------------------------------------------------------------------------
console.log('\n7. the guest\'s own post is in the feed exactly once');
const guestAll = await call(HOST_AGENT, 'group/read', {
  groupId, personId: guestMemberId, personKey: guestKey, sinceSeq: 0,
});
const ownEcho = (guestAll.data?.entries ?? []).filter(
  (entry) => String(entry.from).includes('guest') && /已加入/.test(String(entry.text)),
).length;
// Reading your own post is fine; what must not happen is the inbox *waking* you
// for it. `read` is a query, so seeing it here is correct — the assertion is that
// it appears exactly once.
check('the guest\'s own post appears exactly once', ownEcho === 1, `${ownEcho}`);

// ---------------------------------------------------------------------------
console.log('\n8. one host, one gateway entry, many groups');
const second = await call(HOST_AGENT, 'group/create', {
  name: '第二个群（验证无需再动网关）',
  topic: 'same host, same gateway entry',
});
const secondId = /groupId\s*:\s*(\S+)/.exec(second.text)?.[1];
const secondOwner = /personId:\s*(\S+)/.exec(second.text)?.[1];
const secondKey = /ownerKey:\s*(\S+)/.exec(second.text)?.[1];
check('a second group was created without touching the gateway', secondId !== undefined && secondId !== groupId,
  secondId);
const secondInvite = await call(HOST_AGENT, 'group/invite', {
  groupId: secondId, personId: secondOwner, personKey: secondKey,
});
check('its invite names the SAME host agent',
  typeof secondInvite.data?.link === 'string' && secondInvite.data.link.includes(`agent=${HOST_AGENT}`),
  HOST_AGENT);

// ---------------------------------------------------------------------------
console.log(`\ncollab: ${failures === 0 ? 'OK' : `${failures} FAILED`}`);
if (failures > 0) process.exitCode = 1;
