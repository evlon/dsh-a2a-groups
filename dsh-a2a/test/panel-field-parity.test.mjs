/**
 * Every field the Host publishes about a group must either survive the panel's whitelist or be
 * listed as deliberately dropped.
 *
 * WHY THIS EXISTS
 *
 * `normalizeGroup` in `client.js` rebuilds each group row field by field, and a new field is
 * invisible until somebody remembers to add it. That has now happened EIGHT times across this
 * project, and the eighth was the worst: the organisation layer shipped with its whole content —
 * the goal, the key results, the conventions — present in the data and absent from the UI. A
 * person could see WHO is in a group but not WHAT the group is for, which is the feature.
 *
 * Structural rather than behavioural, for the same reason `feed-field-parity` is: a behavioural
 * test has to know which field to check, and the whole problem is that nobody remembers.
 *
 * @module dsh-a2a/test/panel-field-parity
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { readFileSync } from 'node:fs';

const HOST = readFileSync('lib/index.js', 'utf8');
const CLIENT = readFileSync('client.js', 'utf8');

/**
 * Fields the Host publishes that the panel is allowed to DROP.
 *
 * Each entry is a decision, not an oversight — that is the point of the list. Adding a field to
 * the Host row without adding it here or to `normalizeGroup` fails the test.
 */
const DELIBERATELY_DROPPED = new Set([
  // Routing/plumbing the panel resolves differently.
  'knownSessionIds',
  'discovered',
  'joined',
  'selfVersion',
  'rosterStale',
  'unreachableAt',
  // The panel keys groups by `id`, which it derives from `groupId` — the same value under the
  // name the rest of the client uses. Not a loss, an alias.
  'groupId',
  // Derivable from the roster the panel already holds (`member.online`), so a second copy would
  // be a second answer to the same question.
  'onlineCount',
  // Whether the group happens to be hosted by this very instance. That is a question about
  // routing, answered by the Host; the panel shows the same pane either way.
  'local',
  // Consumed, under a different name: the panel reads `raw.roster` INTO `members` (see
  // normalizeGroup). Listed here because the parity check compares field NAMES, and this one
  // legitimately changes name on the way through.
  'roster',
  'rosterCachedAt',
  'rosterInSession',
]);

/** Keys of the object literal passed to `rows.push({...})` in `publishGroups()`. */
function hostRowFields() {
  const start = HOST.indexOf('const publishGroups = () => {');
  assert.ok(start > -1, 'publishGroups must exist');
  const push = HOST.indexOf('rows.push({', start);
  assert.ok(push > -1, 'publishGroups must build rows');
  const open = HOST.indexOf('{', push);
  let depth = 0;
  for (let index = open; index < HOST.length; index += 1) {
    if (HOST[index] === '{') depth += 1;
    else if (HOST[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        const body = HOST.slice(open, index + 1);
        const fields = new Set();
        // Top-level `key:` entries only — nested objects indent deeper.
        for (const match of body.matchAll(/^\s{10}([A-Za-z][A-Za-z0-9]*)\s*:/gmu)) fields.add(match[1]);
        // Spread-of-conditional form: `...(cond ? {} : { key: value })`
        for (const match of body.matchAll(/\{\s*([A-Za-z][A-Za-z0-9]*)\s*:/gu)) fields.add(match[1]);
        return fields;
      }
    }
  }
  throw new Error('publishGroups row did not close');
}

/** Keys of the object returned by `normalizeGroup` in `client.js`. */
function clientRowFields() {
  const start = CLIENT.indexOf('function normalizeGroup(raw, index) {');
  assert.ok(start > -1, 'normalizeGroup must exist');
  // The LAST top-level `return {` in the function is the row; earlier returns are guard clauses.
  const tail = CLIENT.slice(start);
  const end = tail.indexOf('\n\t\t}');
  const body = tail.slice(0, end === -1 ? tail.length : end);
  const fields = new Set();
  for (const match of body.matchAll(/^\s{4}([A-Za-z][A-Za-z0-9]*)\s*:/gmu)) fields.add(match[1]);
  return fields;
}

test('面板白名单覆盖宿主发布的每一个字段（或显式声明丢弃）', () => {
  const published = hostRowFields();
  const kept = clientRowFields();

  assert.ok(published.size >= 8, `Host 至少发布 8 个字段，实际找到 ${published.size}：${[...published].join(',')}`);

  const missing = [];
  for (const field of published) {
    if (kept.has(field)) continue;
    if (DELIBERATELY_DROPPED.has(field)) continue;
    missing.push(field);
  }
  assert.deepEqual(
    missing,
    [],
    `这些字段宿主发了但面板丢了：${missing.join(', ')}。`
    + '要么加进 normalizeGroup，要么加进 DELIBERATELY_DROPPED 并说明理由。',
  );
});

test('组织层的字段确实穿过了面板（goal 与 conventions）', () => {
  const kept = clientRowFields();
  // Named explicitly: this is the pair whose absence shipped the feature invisible.
  assert.ok(kept.has('goal'), 'normalizeGroup 必须保留 goal，否则右侧栏永远显示「还没有主目标」');
  assert.ok(kept.has('conventions'), 'normalizeGroup 必须保留 conventions，否则群约定在面板里看不到');
});

test('goal 被归一化成面板需要的形状（title / status / krs）', () => {
  assert.ok(CLIENT.includes('function normalizeGoal(raw)'), '必须有 normalizeGoal');
  const start = CLIENT.indexOf('function normalizeGoal(raw)');
  const body = CLIENT.slice(start, start + 1600);
  for (const field of ['title', 'status', 'krs', 'description']) {
    assert.ok(body.includes(`${field}:`), `normalizeGoal 必须产出 ${field}`);
  }
});

test('群约定可以在面板里编辑（RPC 与按钮都得在）', () => {
  // Structural, because the failure mode here is silent: a control that renders but posts to an
  // endpoint nobody registered looks exactly like a save that did nothing.
  const HOST_CODE = readFileSync('lib/index.js', 'utf8');
  assert.ok(HOST_CODE.includes("name === 'set-conventions'"), '面板 RPC 必须注册 set-conventions');
  assert.ok(HOST_CODE.includes('const setPanelConventions = async (payload) => {'), '必须有 setPanelConventions 实现');
  // The credential lives in the ledger, not in the page — that is the whole reason this is an RPC.
  const rpcBody = HOST_CODE.slice(HOST_CODE.indexOf('const setPanelConventions'));
  assert.ok(rpcBody.slice(0, 3000).includes('identities.list({ groupId })'), 'RPC 必须从台账取凭证');
  for (const role of ['conventions-edit', 'conventions-save', 'conventions-reset']) {
    assert.ok(CLIENT.includes(`"data-role": "${role}"`), `面板缺少 ${role} 控件`);
  }
  assert.ok(CLIENT.includes('"set-conventions"'), '客户端必须调用 set-conventions');
});

test('群目标可切换查看，且面板刷新会自愈目标缓存', () => {
  // The failure these guard was seen in a live panel: a group WITH an active goal rendered "这个群
  // 还没有主目标", because the panel reads the ledger and the ledger only learned about a goal when
  // somebody happened to call a goal tool. Wrong, not missing — the worst kind.
  //
  // The three sections moved from stacked collapsibles to one horizontal tab bar: stacked headers
  // cost ~60px even collapsed, and the long one pushed the others out of reach. Side-by-side columns
  // were rejected — the pane is 580px, so a third of it cannot hold a 90-character Chinese rule.
  assert.ok(CLIENT.includes('function SectionTabs('), '三段必须走横向 tab 容器');
  assert.ok(CLIENT.includes('title: "群目标"'), '标签必须写明是群目标');
  assert.ok(CLIENT.includes('title: "群约定"'), '标签必须写明是群约定');
  assert.ok(CLIENT.includes('title: "人工确认"'), '标签必须写明是人工确认');
  const HOST_CODE = readFileSync('lib/index.js', 'utf8');
  assert.ok(HOST_CODE.includes('refreshGoalCache'), '面板刷新必须补拉目标');
  assert.ok(HOST_CODE.includes("skill: 'group/goal-status'"), '自愈必须真的去问宿主');
});

test('状态目录跟随宿主 home，而不是启动目录', () => {
  const CONFIG = readFileSync('lib/core/config.js', 'utf8');
  const HOST_CODE = readFileSync('lib/index.js', 'utf8');
  // The Harness rule is configured -> $DSH_HOME -> ~/.dsh. A plugin that invents its own fallback
  // splits state across two roots; on the machine where this was found the ledger sat in E:\a2a
  // while every other file was under ~/.dsh.
  assert.ok(CONFIG.includes('homedir()'), '默认应落在 ~/.dsh 而不是当前目录');
  assert.ok(CONFIG.includes('migrateLegacyHome'), '旧位置的状态必须被接收，不能让升级看起来像群消失了');
  assert.ok(HOST_CODE.includes('ctx.dshHomePath'), '应优先使用宿主自己的 home 解析器');
});

test('面板传输失败必须译成人能看懂的话，不得直出 405', () => {
  // The acceptance criterion recorded in BACKLOG §6.1 all along: a person must not be shown
  // 「transport failure for /a2a-panel/confirm-settings: HTTP 405」. That names an internal route,
  // and 405 here has one actionable cause — the plugin is mounted in a different profile.
  assert.ok(CLIENT.includes('function describePanelFailure('), '必须有面板错误翻译函数');
  assert.ok(CLIENT.includes('插件装进了另一个 profile'), '405 必须指向 profile 装错');
  // Every panel failure path that reaches a human must go through it.
  assert.ok(!/保存失败：" \+ String\(\(error/u.test(CLIENT), '不允许绕过翻译直接拼接原始错误');
});
