/**
 * The unbound (not-yet-joined) members pane must offer every way to get into a group,
 * and the rejoin affordance must not over-claim.
 *
 * THE TWO REGRESSIONS THIS LOCKS
 *
 *   1. A pane with "join via link" and "browse" but no "create" leaves a new user unable to
 *      START a collaboration — they can only join somebody else's. "新建一个群" is the entry
 *      point for that, and it must be a button that fills the composer, not a prose hint.
 *
 *   2. The rejoin button used to fill 「我本机已经有身份，不需要邀请链接」. That is true only when
 *      THIS instance already holds a credential for the group in another Session; a fresh
 *      instance with no such credential still needs a link. The over-claim sent the model down a
 *      path that ends in missing_endpoint. The instruction must say both branches.
 *
 * These are structural (read the source) rather than behavioural: the pane renders only inside a
 * mounted DSH shell, and a behavioural test would need that whole harness for one sentence.
 *
 * @module dsh-a2a/test/unbound-pane-actions
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { readFileSync } from 'node:fs';

const CLIENT = readFileSync('client.js', 'utf8');
const HOST = readFileSync('lib/index.js', 'utf8');

test('the unbound pane has a 「新建一个群」 button that fills the composer', () => {
  // The button text is the visible label; the onClick must call replaceDraft with a2a_group_create.
  assert.match(CLIENT, /"新建一个群"/u, 'the create-group button must exist');
  // The label is the LAST argument to h("button", …), so the onClick (which holds the instruction) is
  // BEFORE it in the source. Slice backwards from the label to catch the handler.
  const at = CLIENT.indexOf('"新建一个群"');
  assert.ok(at > -1, 'create button label not found');
  const body = CLIENT.slice(Math.max(0, at - 500), at);
  assert.match(body, /a2a_group_create/u, 'the button must fill a a2a_group_create instruction');
  assert.match(body, /replaceDraft|fillDraft/u, 'it must write into the composer');
});

test('the create instruction names a group name and a topic', () => {
  // The instruction the button fills must carry the two fields a2a_group_create takes, so a model
  // has somewhere to put them rather than inventing a schema.
  assert.match(CLIENT, /群名叫「」/u, 'the filled draft must have a place for the group name');
  assert.match(CLIENT, /主题是「」/u, 'and for the topic');
});

test('the rejoin instruction no longer over-claims "no invite needed"', () => {
  // The old instruction asserted the identity exists here unconditionally. The honest version says
  // "reuse if this machine already holds it, otherwise ask for a link".
  const at = CLIENT.indexOf('用 a2a_group_join 重新加入');
  assert.ok(at > -1, 'rejoin instruction not found');
  const body = CLIENT.slice(at, at + 300);
  assert.match(body, /本机若已有这个群的身份/u, 'it must state the reuse branch');
  assert.match(body, /如果本机没有身份，请告诉我，我需要一个邀请链接/u, 'it must state the link-needed branch');
  assert.ok(
    !/不需要邀请链接/.test(body),
    'it must not claim no link is needed, because a fresh instance does need one',
  );
});

test('the panel has a 设置 tab that opens a form, not a YAML wall', () => {
  // A colleague who has never seen cordis.patch.yml must not have to learn YAML indentation. The 设置 tab is a form
  // with three labelled inputs (gateway, agent name, key) and a save button.
  assert.match(CLIENT, /\{ id: "settings", label: "设置"/u, 'the 设置 tab must be defined');
  assert.match(CLIENT, /tab === "settings" \? settingsBody/u, 'selecting 设置 must render its body');
  assert.match(CLIENT, /function SettingsForm/u, 'the settings body must be a form component');
  assert.match(CLIENT, /网关地址 gatewayBase/u, 'the form must label the gateway field');
  assert.match(CLIENT, /你在网关里的名字 agentName/u, 'and the agent name');
  assert.match(CLIENT, /网关密钥 apiKey/u, 'and the api key');
});

test('the settings form saves through the Host configEditor', () => {
  // The save must go over the panel RPC to the Host's configEditor — the page holds no filesystem, and a direct
  // browser write would be both impossible and unsafe.
  assert.match(CLIENT, /saveConfig\(/u, 'the form must call saveConfig');
  assert.match(CLIENT, /"\/a2a-panel", "set-config"/u, 'saveConfig must target the set-config endpoint');
  assert.match(HOST, /setPanelConfig/u, 'the Host must implement setPanelConfig');
  assert.match(HOST, /configEditor/u, 'the Host must use the configEditor service');
  assert.match(HOST, /editor\.edit\(entry/u, 'and call its edit() for atomic, validated write + hot reload');
});
