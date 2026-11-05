/**
 * `replyTo`: answering somebody wakes them, without the replier having to remember who asked.
 *
 * THE LIVE FAILURE
 *
 *   张三 @李四    -> 李四 woken, did the work
 *   李四 replies  -> mentions: 无  -> 张三 NEVER woken
 *
 * The reply landed in the feed and stayed there. 张三 would see it whenever he next happened to read the group —
 * which, in the run this came from, was never. "Who am I answering?" is a fact about the message being replied to,
 * not a decision the replier should have to reconstruct after doing the work.
 *
 * WHAT THESE TESTS PIN
 *
 *   a reply wakes the author of the message it answers
 *   a reply does NOT wake the replier (that would start a loop with yourself)
 *   `@all` still means everybody, and is not narrowed by a reply target
 *   an unknown seq is tolerated: a reply with no thread is still a reply
 * @module dsh-a2a/test/reply-to
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGroupStore } from '../lib/core/groups.js';
import { createMembershipLedger } from '../lib/core/memberships.js';
import { normalizeConfig } from '../lib/core/config.js';
import { createToolRuntime } from '../lib/shared/tool-runtime.js';
import { TOOL_SPECS } from '../lib/shared/tool-specs.js';

const LOGGER = { info() {}, warn() {}, debug() {} };
const SESSION = 'session-test';

/** A group with an owner and one invited member, plus the pieces needed to post as either. */
function harness() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-a2a-reply-'));
  const clock = () => Date.now();
  const config = normalizeConfig({
    groups: { gatewayBase: 'http://gw/a2a', agentName: 'agent-test' },
    client: { apiKey: 'k', forwardProto: 'http', timeoutMs: 1000 },
  });
  const store = createGroupStore({ home, logger: LOGGER, clock, config });
  const identities = createMembershipLedger({ home, logger: LOGGER, clock });

  const created = store.create({ name: '发票重构', ownerDisplayName: '张三' });
  const groupId = created.group.groupId;
  const owner = { personId: created.group.owner.personId, personKey: created.ownerKey };

  const invite = store.invite({ groupId, ownerKey: created.ownerKey });
  const joined = store.join({ groupId, token: invite.token, displayName: '李四' });
  const other = { personId: joined.member.personId, personKey: joined.personKey };

  identities.upsert({
    sessionId: SESSION,
    groupId,
    personId: owner.personId,
    personKey: owner.personKey,
    local: true,
    groupName: '发票重构',
    role: 'owner',
    lastSeq: 0,
  });

  const runtime = createToolRuntime({ store, identities, config, logger: LOGGER, clock });
  return {
    store, identities, runtime, groupId, owner, other,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

/** Post as somebody and return the result. */
function post(env, member, text, extra = {}) {
  return env.store.post({ groupId: env.groupId, member, text, ...extra });
}

test('a reply wakes the author of the message it answers', () => {
  const env = harness();
  try {
    const asked = post(env, env.owner, '李四，这份文档能帮我回退吗？', { mentions: ['李四'] });
    assert.deepEqual(asked.mentions, [env.other.personId], 'the question addressed 李四');

    // The reply names the message, not the person — and that is the whole point.
    const answered = post(env, env.other, '好，已回退到 v1.9。', { replyTo: asked.seq });

    assert.deepEqual(answered.mentions, [env.owner.personId], 'the reply must wake whoever asked');
    assert.equal(answered.replyTo, asked.seq, 'and record the thread');
  } finally {
    env.cleanup();
  }
});

test('a reply does not wake the person writing it', () => {
  const env = harness();
  try {
    const mine = post(env, env.owner, '我补一下进度');
    const followUp = post(env, env.owner, '还有一点', { replyTo: mine.seq });

    // Waking yourself is a loop: the turn that just wrote this would immediately be asked to write again.
    assert.deepEqual(followUp.mentions, [], 'replying to your own message wakes nobody');
  } finally {
    env.cleanup();
  }
});

test('@all still means everybody and is not narrowed by a reply target', () => {
  const env = harness();
  try {
    const asked = post(env, env.owner, '谁能看一下？', { mentions: ['李四'] });
    const broadcast = post(env, env.other, '我看了，大家也注意下', { replyTo: asked.seq, mentions: ['@all'] });

    // "everyone" subsumes the author: keeping both would make the grading pick one arbitrarily.
    assert.deepEqual(broadcast.mentions, ['@all']);
  } finally {
    env.cleanup();
  }
});

test('a reply keeps an explicit mention the replier added', () => {
  const env = harness();
  try {
    const asked = post(env, env.owner, '需要两个人看', { mentions: ['李四'] });
    const answered = post(env, env.other, '张三、王五 都看下', { replyTo: asked.seq, mentions: [env.owner.personId] });

    // The dedupe matters: the same person must not appear twice, or a caller counting recipients gets two.
    assert.equal(answered.mentions.filter((id) => id === env.owner.personId).length, 1);
  } finally {
    env.cleanup();
  }
});

test('an unknown seq still posts, as a reply with no thread', () => {
  const env = harness();
  try {
    // The message may have been trimmed by retention. Refusing the write would lose the reply to save the link.
    const orphan = post(env, env.owner, '回一条已经不存在的消息', { replyTo: 9999 });
    assert.equal(typeof orphan.seq, 'number');
    assert.deepEqual(orphan.mentions, [], 'no author to wake');
    assert.equal(orphan.replyTo, undefined, 'and no thread to record');
  } finally {
    env.cleanup();
  }
});

test('the tool forwards replyTo on a hosted group', async () => {
  const env = harness();
  try {
    const asked = post(env, env.owner, '问一句');

    const result = await env.runtime.call(
      'a2a_group_post',
      { groupId: env.groupId, message: '答一句', replyTo: asked.seq },
      { sessionId: SESSION },
    );

    // The local branch used to drop `mentions` entirely, so this exact path was silently broken.
    assert.equal(result.seq > asked.seq, true);
  } finally {
    env.cleanup();
  }
});

test('the tool advertises replyTo with a reason to use it', () => {
  const spec = TOOL_SPECS.find((entry) => entry.name === 'a2a_group_post');
  assert.ok(spec !== undefined);
  const param = spec.parameters.properties.replyTo;
  assert.ok(param !== undefined, 'a model cannot use what it cannot see');
  assert.equal(param.type, 'integer');
  // The description has to say what goes wrong without it, or it reads as optional boilerplate.
  assert.match(param.description, /woken/u);
  assert.match(spec.description, /replyTo/u);
});

test('the reply chain is visible in the feed', () => {
  const env = harness();
  try {
    const a = post(env, env.owner, '第一问');
    const b = post(env, env.other, '第一答', { replyTo: a.seq });

    const page = env.store.read({ groupId: env.groupId, member: env.owner, sinceSeq: 0 });
    const reply = page.entries.find((entry) => entry.seq === b.seq);

    // Recorded, not merely implied by adjacency: retention trims the middle, and a reader joining later needs the
    // link to still be there.
    assert.equal(reply.replyTo, a.seq);
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Answering a broadcast
// ---------------------------------------------------------------------------

test('answering an @all notice goes to the announcer, not to everybody again', () => {
  const env = harness();
  try {
    const notice = post(env, env.owner, '各位，明天上线，注意窗口。', { mentions: ['@all'] });
    assert.deepEqual(notice.mentions, ['@all']);

    // The reply names the notice and says nothing about recipients. Without the broadcast rule this would either
    // wake nobody (no mention derived) or — if the replier reached for @all out of habit — wake everyone again.
    const answered = post(env, env.other, '收到，我这边没问题。', { replyTo: notice.seq });

    assert.deepEqual(answered.mentions, [env.owner.personId], 'only the announcer is woken');
    assert.equal(answered.replyTo, notice.seq);
  } finally {
    env.cleanup();
  }
});

test('three people answering one broadcast produce three wakes, not nine', () => {
  const env = harness();
  try {
    const notice = post(env, env.owner, '各位，看下这个。', { mentions: ['@all'] });

    // Two members answer. Each answer must wake exactly one person — the announcer — not the whole group.
    const a = post(env, env.other, '收到', { replyTo: notice.seq });
    const b = post(env, env.other, '补充一句', { replyTo: notice.seq });

    const totalWoken = [...a.mentions, ...b.mentions].filter((id) => id !== '@all').length;
    assert.equal(totalWoken <= 2, true, `expected at most two wakes, saw ${totalWoken}`);
    assert.equal(a.mentions.includes('@all'), false, 'an answer must never re-broadcast');
    assert.equal(b.mentions.includes('@all'), false);
  } finally {
    env.cleanup();
  }
});

test('an explicit @all in a reply still wins, because a real announcement may be needed', () => {
  const env = harness();
  try {
    const notice = post(env, env.owner, '各位，明天上线。', { mentions: ['@all'] });

    // "the outage affects all of you, here is the new plan" is a legitimate reply to everybody. Forbidding it
    // would remove a real capability to prevent a common mistake.
    const escalated = post(env, env.other, '情况变了，所有人重读这段。', { replyTo: notice.seq, mentions: ['@all'] });
    assert.deepEqual(escalated.mentions, ['@all']);
  } finally {
    env.cleanup();
  }
});

test('a reply to an ordinary message still wakes its author', () => {
  const env = harness();
  try {
    // The broadcast rule must not leak into ordinary replies.
    const asked = post(env, env.owner, '李四，帮我看下这个。', { mentions: ['李四'] });
    const answered = post(env, env.other, '看过了，没问题。', { replyTo: asked.seq });
    assert.deepEqual(answered.mentions, [env.owner.personId]);
  } finally {
    env.cleanup();
  }
});

test('the reason is discoverable from the tool description', () => {
  // A model that does not know the rule will reach for @all out of habit when answering a broadcast.
  const spec = TOOL_SPECS.find((entry) => entry.name === 'a2a_group_post');
  assert.match(spec.parameters.properties.replyTo.description, /broadcast|@all|everybody|everyone/iu);
});
