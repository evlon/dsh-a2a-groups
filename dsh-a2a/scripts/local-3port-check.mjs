#!/usr/bin/env node
/**
 * Three-instance local check: one group host + two members, over REAL A2A HTTP.
 *
 * WHY THIS EXISTS
 *
 * Everything up to now was verified at the store layer and the tool layer — the local path. The
 * REMOTE path (member tool → bridge → host skill → store) was only ever code-aligned: the skill
 * payloads were written to match `group/rename`'s shape and never once exercised over the wire.
 * A payload-shape mistake there is invisible to every unit test and fails only in production.
 *
 * So this drives the actual skills over the actual protocol, with the actual version header and
 * bearer token, against a real listener.
 *
 * TOPOLOGY (one process, three roles — the ports are the contract, not the process boundary)
 *
 *   3091  group host      bin/agent-groups.js, its own data directory
 *   3093  member A        the instance that creates the group and owns it
 *   3096  member B        the instance that joins, and must be refused anything owner-only
 *
 * Run: node scripts/local-3port-check.mjs
 * Exit code 0 = every assertion held.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createProbeServer } from 'node:net';

const HERE = fileURLToPath(new URL('..', import.meta.url));
// 3091 is the documented port, but a developer machine usually has a dev instance bound to it.
// `--port` exists so this check can run without stopping that instance; the flow is the contract,
// not the number.
// `--port 0` (the default) asks the OS for a free port and learns it from the host's own startup
// line. A fixed port made this check fail on any machine that already had a dev instance bound
// to it — which is most developer machines, including the one this was written on.
const portFlag = process.argv.indexOf('--port');
const REQUESTED_PORT = portFlag > -1 ? Number(process.argv[portFlag + 1]) : 0;
if (!Number.isInteger(REQUESTED_PORT) || REQUESTED_PORT < 0 || REQUESTED_PORT > 65535) {
  console.error('invalid --port');
  process.exit(2);
}
let PORT = REQUESTED_PORT;
let BASE = '';
const TOKEN = 'local-3port-check';
const HOST_AGENT = 'local-host';

let requestId = 0;
let failures = 0;
const results = [];

/** One assertion with a readable name, so a failure names the behaviour, not a line number. */
function check(name, condition, detail) {
  if (condition) {
    results.push(`  ✓ ${name}`);
  } else {
    failures += 1;
    results.push(`  ✗ ${name}${detail === undefined ? '' : `\n      got: ${JSON.stringify(detail)}`}`);
  }
}

/** Call one skill over A2A 1.0. Returns the skill's `result` object, or throws with the RPC error. */
async function call(skill, data) {
  const id = `r${++requestId}`;
  const response = await fetch(`${BASE}/a2a`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
      // Without this the host refuses the call as 0.3 — which is the correct behaviour and also
      // the reason this script cannot be written with a plain curl.
      'A2A-Version': '1.0',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'SendMessage',
      params: {
        message: {
          role: 'user',
          messageId: `m${requestId}`,
          parts: [{ kind: 'text', text: skill }],
          metadata: { skill, data },
        },
      },
    }),
  });
  const envelope = await response.json();
  if (envelope.error !== undefined) {
    const error = new Error(envelope.error.message);
    error.code = envelope.error.data?.code ?? envelope.error.code;
    throw error;
  }
  return envelope.result?.task?.metadata?.result ?? {};
}

/** Call a skill that is expected to be REFUSED, and return the refusal code. */
async function refusalOf(skill, data) {
  try {
    await call(skill, data);
    return 'NO_REFUSAL';
  } catch (error) {
    return error.code ?? error.message;
  }
}

async function waitForHost(timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (BASE === '') {
      // Still waiting for the startup line that names the port.
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    try {
      const response = await fetch(`${BASE}/a2a/.well-known/agent-card.json`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`host did not answer on ${BASE || '(no port announced)'} within ${timeoutMs}ms`);
}

// The gateway URL has to be known BEFORE the host starts (it is baked into invite links), so a
// port announced later by the host is too late. Ask the OS for a free port up front instead.
if (PORT === 0) {
  PORT = await new Promise((resolve, reject) => {
    const probe = createProbeServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}
BASE = `http://127.0.0.1:${PORT}`;

const dataDirectory = mkdtempSync(join(tmpdir(), 'a2a-3port-'));
const host = spawn(
  process.execPath,
  [
    join(HERE, 'bin/agent-groups.js'),
    '--port', String(PORT),
    '--data', dataDirectory,
    '--token', TOKEN,
    '--gateway', BASE,
    '--agent', HOST_AGENT,
  ],
  { cwd: HERE, stdio: ['ignore', 'pipe', 'pipe'] },
);
host.stdout.on('data', (chunk) => {
  // "agent-groups X listening on 127.0.0.1:3091 (data: …)"
  const match = /listening on [^:]+:(\d+)/u.exec(String(chunk));
  if (match !== null && BASE === '') {
    PORT = Number(match[1]);
    BASE = `http://127.0.0.1:${PORT}`;
  }
});
host.stderr.on('data', (chunk) => process.stderr.write(`[host] ${chunk}`));

try {
  await waitForHost();
  console.log(`\nhost up on ${BASE}, data ${dataDirectory}\n`);

  // --- 3093: the owner -----------------------------------------------------
  const created = await call('group/create', {
    name: '本地三实例验证群',
    topic: '验证 0.1.26/0.1.27 的远端路径',
    ownerDisplayName: '实例3093',
  });
  const groupId = created.groupId;
  const owner = { personId: created.personId, personKey: created.ownerKey };
  check('group/create 返回值可解包（groupId/personId/ownerKey 齐全）', groupId && owner.personId && owner.personKey, created);

  const invited = await call('group/invite', { groupId, ...owner, label: '给实例3096' });
  check('group/invite 返回令牌与链接', typeof invited.token === 'string' && invited.token.startsWith('inv_'), invited);

  // --- 3096: the second member ---------------------------------------------
  const joined = await call('group/join', { groupId, token: invited.token, displayName: '实例3096' });
  const member = { personId: joined.personId, personKey: joined.personKey };
  check('group/join 返回成员凭证', typeof member.personKey === 'string' && member.personKey.startsWith('mk_'), joined);

  // --- organisation layer, over the wire -----------------------------------
  const refusedPublish = await refusalOf('group/goal-publish', {
    groupId, ...member, title: '不该成功', krs: ['k'],
  });
  check('非群主发布目标被拒（not_owner）', refusedPublish === 'not_owner', refusedPublish);

  const published = await call('group/goal-publish', {
    groupId,
    ...owner,
    title: '本地三实例端到端验证通过',
    description: '覆盖 goal / conventions / control / priority 四条远端路径',
    krs: ['远端 skill 载荷形状正确', '权限与状态机在真实 HTTP 上成立'],
  });
  check('群主发布目标成功，返回 active', published.goal?.status === 'active', published.goal);
  check('关键路径 id 由宿主生成（kr1）', published.goal?.krs?.[0]?.id === 'kr1', published.goal?.krs);

  const secondPublish = await refusalOf('group/goal-publish', { groupId, ...owner, title: '第二个', krs: ['k'] });
  check('已有进行中目标时再发布被拒（goal_exists）', secondPublish === 'goal_exists', secondPublish);

  const status = await call('group/goal-status', { groupId, ...member });
  check('成员能读到目标', status.goal?.title === '本地三实例端到端验证通过', status.goal?.title);
  check('目标里带默认群规则（未做任何约定配置也是开箱可用）',
    typeof status.conventions === 'string' && status.conventions.includes('【本群默认约定】'), status.conventions?.slice(0, 40));

  const extra = await call('group/conventions', {
    groupId, ...owner, extra: '九、本群额外一条：跨机验证必须在真实端口上跑。',
  });
  check('增补条款后默认规则仍在', extra.conventions?.includes('【本群默认约定】'), extra.conventions?.slice(0, 40));
  check('增补条款出现在生效文本里', extra.conventions?.includes('跨机验证必须在真实端口上跑'), extra.conventions?.slice(-60));

  const memberSetConventions = await refusalOf('group/conventions', { groupId, ...member, extra: 'x' });
  check('非群主改约定被拒（not_owner）', memberSetConventions === 'not_owner', memberSetConventions);

  const challenged = await call('group/goal-challenge', {
    groupId, ...member, reason: '远端路径还没验证就宣布完成', alternative: '先跑三实例再宣布',
  });
  check('成员质疑被记录且带替代方案', challenged.goal?.challenges?.[0]?.alternative === '先跑三实例再宣布', challenged.goal?.challenges);

  // --- control: the pause must travel in the feed --------------------------
  const stopped = await call('group/control', { groupId, ...owner, action: 'stop', reason: '验证暂停投递' });
  check('暂停是状态且可读回', stopped.control?.stopped === true, stopped.control);

  const markerPost = await call('group/post', { groupId, ...member, text: '暂停期间这条仍应进 feed' });
  check('暂停期间普通消息仍进 feed（不丢内容）', typeof markerPost.seq === 'number', markerPost);

  const page = await call('group/read', { groupId, ...member, limit: 20 });
  const controlEntries = (page.entries ?? page.messages ?? []).filter((entry) => entry.priority === 'control');
  check('控制指令以 control 优先级出现在 feed 里（跨机可见）', controlEntries.length >= 1, controlEntries.length);
  check('控制消息携带机器可读状态（一等字段，不依赖 payload）',
    controlEntries.at(-1)?.control?.stopped === true, controlEntries.at(-1));

  const memberControl = await refusalOf('group/control', { groupId, ...member, action: 'stop', reason: 'x' });
  check('非群主不能发控制指令（not_owner）', memberControl === 'not_owner', memberControl);

  const resumed = await call('group/control', { groupId, ...owner, action: 'resume', reason: '验证完成' });
  check('恢复后状态为未暂停', resumed.control?.stopped === false, resumed.control);

  // --- priority ------------------------------------------------------------
  const urgent = await call('group/post', { groupId, ...owner, text: '加急：立即处理', priority: 'urgent' });
  check('urgent 消息被接受', typeof urgent.seq === 'number', urgent);
  const afterUrgent = await call('group/read', { groupId, ...member, limit: 20 });
  const urgentEntries = (afterUrgent.entries ?? []).filter((entry) => entry.priority === 'urgent');
  check('urgent 优先级经 read 返回（白名单未吞掉）', urgentEntries.length === 1, urgentEntries.length);

  // --- close the goal ------------------------------------------------------
  const closed = await call('group/goal-close', { groupId, ...owner, reason: '三条远端路径全部验证通过' });
  check('结束目标成功且进入 closed', closed.goal?.status === 'closed', closed.goal?.status);

  const rePublish = await call('group/goal-publish', { groupId, ...owner, title: '第二个目标', krs: ['k'] });
  check('结束后可以发布新目标', rePublish.goal?.status === 'active', rePublish.goal?.status);
} catch (error) {
  failures += 1;
  results.push(`  ✗ 未捕获的失败: ${error.message}`);
} finally {
  host.kill();
  rmSync(dataDirectory, { recursive: true, force: true });
}

console.log(results.join('\n'));
console.log(
  failures === 0
    ? `\n全部通过（${results.length} 项）\n`
    : `\n${failures} 项失败 / 共 ${results.length} 项\n`,
);
process.exit(failures === 0 ? 0 : 1);
