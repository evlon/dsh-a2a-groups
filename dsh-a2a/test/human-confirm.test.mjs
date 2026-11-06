/**
 * Human confirmation: the policy decision, the question text, and what an answer means.
 *
 * WHY THESE ARE UNIT TESTS AND NOT A UI TEST
 *
 * The decision layer is pure: settings in, verdict out. Every branch here is a rule a person chose in settings, and the
 * dangerous ones are the failure paths — an unavailable seam, an error, an unanswered question. If any of those were
 * treated as approval the confirmation would be decorative exactly when it matters. A real click cannot cover these
 * cheaply; a unit test can cover all of them.
 *
 * The seam itself is verified separately, against a live Host (see test-report/PROBE-VERIFICATION.md).
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  askHuman,
  confirmationPolicy,
  confirmationQuestion,
  decideFromAnswer,
} from '../lib/dsh/human-confirm.js';

/** Settings with only the fields this module reads. */
function settings(humanConfirm) {
  return { groups: { humanConfirm: { enabled: true, trigger: 'mention', channel: 'question', onTimeout: 'deny', timeoutMs: 5000, ...humanConfirm } } };
}

// ---------------------------------------------------------------------------
// When to ask
// ---------------------------------------------------------------------------

test('a disabled setting never asks', () => {
  const verdict = confirmationPolicy({ settings: { groups: { humanConfirm: { enabled: false } } }, grade: 'mention' });
  assert.equal(verdict.ask, false);
  assert.equal(verdict.reason, 'disabled');
});

test('an absent setting block is treated as disabled, not as an error', () => {
  const verdict = confirmationPolicy({ settings: {}, grade: 'mention' });
  assert.equal(verdict.ask, false);
  assert.equal(verdict.reason, 'disabled');
});

test('trigger=mention asks only when the post names me', () => {
  const s = settings({ trigger: 'mention' });
  assert.equal(confirmationPolicy({ settings: s, grade: 'mention' }).ask, true);
  // A notice is a post that mentions nobody; it is delivered but asks nothing.
  assert.equal(confirmationPolicy({ settings: s, grade: 'notice' }).ask, false);
});

test('trigger=always asks for an unaddressed post too', () => {
  const s = settings({ trigger: 'always' });
  assert.equal(confirmationPolicy({ settings: s, grade: 'notice' }).ask, true);
});

test('trigger=never never asks', () => {
  const s = settings({ trigger: 'never' });
  assert.equal(confirmationPolicy({ settings: s, grade: 'mention' }).ask, false);
});

test('an ambient post is never worth interrupting for', () => {
  // Ambient means the post named somebody else. Asking about it would stop work for a message that was not ours.
  const s = settings({ trigger: 'always' });
  assert.equal(confirmationPolicy({ settings: s, grade: 'ambient' }).ask, false);
});

test('the unimplemented IM channel is reported, not silently skipped', () => {
  // The dangerous alternative: returning `ask: false` would remove the protection while the setting looks applied.
  const verdict = confirmationPolicy({ settings: settings({ channel: 'im' }), grade: 'mention' });
  assert.equal(verdict.ask, true);
  assert.equal(verdict.reason, 'channel-unimplemented');
  assert.equal(verdict.channel, 'im');
});

test('the timeout policy travels with the verdict', () => {
  const verdict = confirmationPolicy({ settings: settings({ onTimeout: 'allow', timeoutMs: 1234 }), grade: 'mention' });
  assert.equal(verdict.onTimeout, 'allow');
  assert.equal(verdict.timeoutMs, 1234);
});

// ---------------------------------------------------------------------------
// The question a person reads
// ---------------------------------------------------------------------------

test('the card is split into header, one-line question, and quoted draft', () => {
  // The seam renders header as a small eyebrow, question as the 16px TITLE, detail as Markdown below. Putting everything
  // into `question` made a long item a headline wrapped into a narrow column — reported as 「不如 user question 总结得好」.
  const built = confirmationQuestion({ groupName: '发票与对账平台', draft: '好的，我马上核对对账口径', replyingTo: 282 });

  // The group goes in the eyebrow: a place, not a sentence.
  assert.equal(built.questions[0].header, '发票与对账平台');

  // The title is ONE line and asks the decision. No newlines: a title with line breaks is a wall again.
  const title = built.questions[0].question;
  assert.ok(title.includes('\n') === false, 'the title must stay one line');
  assert.ok(title.length <= 40, `title should be short, got ${title.length} chars`);
  assert.ok(title.length <= 14, `title must survive a narrow card, got ${title.length}`);

  // What the person approves is the DRAFT that would go out, quoted.
  const detail = built.questions[0].detail;
  assert.match(detail, /马上核对对账口径/);
  assert.match(detail, /^> /m, 'the draft must be a Markdown quote');
});

test('the card offers three distinct choices, each stating what the colleague sees', () => {
  // Silence is the outcome a sender cannot interpret. Every option therefore says what the COLLEAGUE will
  // experience, and the two non-approvals promise a notice rather than nothing.
  const built = confirmationQuestion({ groupName: '发票与对账平台', draft: 'x', replyingTo: 3, sender: '张三' });
  const labels = built.questions[0].options.map((o) => o.label);
  assert.deepEqual(labels, ['允许', '稍后处理', '拒绝'], 'approve first, then the two ways of not replying');

  const detail = built.questions[0].detail;
  assert.match(detail, /\*\*允许\*\*/);
  assert.match(detail, /\*\*稍后处理\*\*/);
  assert.match(detail, /\*\*拒绝\*\*/);
  // Both non-approvals tell the sender something.
  assert.equal((detail.match(/告诉/g) ?? []).length, 2, 'defer and refuse each notify the colleague');

  const [allow, defer, refuse] = built.questions[0].options;
  assert.match(allow.description, /发到/);
  assert.match(defer.description, /让对方知道/);
  assert.match(refuse.description, /让对方知道/);
});

test('the thread number appears when the reply answers a specific message', () => {
  const withThread = confirmationQuestion({ groupName: 'G', draft: 'x', replyingTo: 282 });
  assert.match(withThread.questions[0].detail, /#282/);
  // And is simply absent when it is not a reply to anything in particular.
  const without = confirmationQuestion({ groupName: 'G', draft: 'x', replyingTo: undefined });
  assert.ok(without.questions[0].detail.includes('#') === false);
});

test('a very long draft is cut with a VISIBLE marker', () => {
  // Silently truncating would let the reader approve something they were never shown.
  const built = confirmationQuestion({ groupName: 'G', draft: 'x'.repeat(5000), replyingTo: 1 });
  const detail = built.questions[0].detail;
  assert.ok(detail.length < 1600, `detail should stay readable, got ${detail.length} chars`);
  assert.match(detail, /还有 \d+ 字未显示/, 'the cut must announce itself');
});

test('an empty draft still produces a usable card', () => {
  const built = confirmationQuestion({ groupName: 'G', draft: '', replyingTo: 1 });
  assert.match(built.questions[0].detail, /没有正文/);
  assert.ok(built.questions[0].question.length > 0);
});

test('a multi-line draft stays quoted line by line', () => {
  // Markdown needs the marker on every line, or the quote breaks after the first one.
  const built = confirmationQuestion({ groupName: 'G', draft: '第一行\n第二行', replyingTo: 1 });
  const detail = built.questions[0].detail;
  assert.match(detail, /^> 第一行$/m);
  assert.match(detail, /^> 第二行$/m);
});

test('an unknown group is described without inventing a name', () => {
  // Never fabricate 「协作群」 as if it were the real title: the reader would think they know where this lands.
  const built = confirmationQuestion({ groupName: '', draft: 'x', replyingTo: 1 });
  assert.equal(built.questions[0].header, '协作群');
  // The group is named in `detail` (where there is room), not in the title.
  assert.match(built.questions[0].detail, /群里/);
});

// ---------------------------------------------------------------------------
// Asking, and the failure paths
// ---------------------------------------------------------------------------

test('a missing seam is unavailable, never approval', () => {
  const result = askHuman({ seam: undefined, agent: {}, question: {}, onTimeout: 'deny', timeoutMs: 10 });
  return result.then((value) => {
    assert.equal(value.outcome, 'unavailable');
    assert.equal(decideFromAnswer(value).proceed, false);
  });
});

test('a missing agent is unavailable, never approval', async () => {
  const value = await askHuman({ seam: { ask: async () => ({}) }, agent: undefined, question: {}, onTimeout: 'deny', timeoutMs: 10 });
  assert.equal(value.outcome, 'unavailable');
});

test('an answered question reports approval when the human chose 允许', async () => {
  const seam = { ask: async () => ({ answers: [{ id: 'a2a-human-confirm', selected: ['允许'] }] }) };
  const result = await askHuman({ seam, agent: {}, question: {}, onTimeout: 'never' });
  assert.equal(result.outcome, 'answered');
  assert.deepEqual(decideFromAnswer(result), { proceed: true, reason: 'approved' });
});

test('拒绝 and 稍后处理 are DIFFERENT answers', async () => {
  // 「我看到了，但晚点再说」 and 「这条我不打算回」 are different promises. Collapsing them forces the person to pick
  // the wrong one, and tells the colleague the wrong thing.
  const refuse = { ask: async () => ({ answers: [{ id: 'a2a-human-confirm', selected: ['拒绝'] }] }) };
  const defer = { ask: async () => ({ answers: [{ id: 'a2a-human-confirm', selected: ['稍后处理'] }] }) };
  const refused = decideFromAnswer(await askHuman({ seam: refuse, agent: {}, question: {}, onTimeout: 'never' }));
  const deferred = decideFromAnswer(await askHuman({ seam: defer, agent: {}, question: {}, onTimeout: 'never' }));
  // Neither proceeds, but they are distinguishable and both notify.
  assert.equal(refused.proceed, false);
  assert.equal(deferred.proceed, false);
  assert.equal(refused.reason, 'denied');
  assert.equal(deferred.reason, 'deferred');
  assert.equal(refused.notify, 'refuse');
  assert.equal(deferred.notify, 'defer');
});

test('a timed-out question honours the deny policy', async () => {
  const seam = { askTimed: async () => ({ pending: true, callId: 'x' }) };
  const result = await askHuman({ seam, agent: {}, question: {}, onTimeout: 'deny', timeoutMs: 10 });
  assert.equal(result.outcome, 'timed-out-deny');
  assert.equal(decideFromAnswer(result).proceed, false);
});

test('a timed-out question honours the allow policy', async () => {
  const seam = { askTimed: async () => ({ pending: true, callId: 'x' }) };
  const result = await askHuman({ seam, agent: {}, question: {}, onTimeout: 'allow', timeoutMs: 10 });
  assert.equal(result.outcome, 'timed-out-allow');
  assert.equal(decideFromAnswer(result).proceed, true);
});

test('an error from the seam does not become approval', async () => {
  const seam = { ask: async () => { throw new Error('boom'); } };
  const result = await askHuman({ seam, agent: {}, question: {}, onTimeout: 'never' });
  assert.equal(result.outcome, 'error');
  assert.equal(decideFromAnswer(result).proceed, false, 'an error must never let the action proceed');
});

test('without askTimed the wait is still bounded by the setting', async () => {
  // A Host that only offers `ask` must not ignore the timeout: the abort is what bounds it.
  let sawSignal = false;
  const seam = {
    ask: async (request) => {
      sawSignal = request.signal !== undefined;
      return await new Promise((resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    },
  };
  const result = await askHuman({ seam, agent: {}, question: {}, onTimeout: 'deny', timeoutMs: 30 });
  assert.equal(sawSignal, true, 'the bound must be passed to ask()');
  assert.equal(result.outcome, 'timed-out-deny');
});

test('onTimeout never waits indefinitely and does not report success', async () => {
  // The setting says wait forever. It must actually wait — and it must never be mistaken for approval.
  const seam = {
    ask: async () => await new Promise((resolve) => setTimeout(() => resolve({ answers: [{ id: 'a2a-human-confirm', selected: ['允许'] }] }), 30)),
  };
  const result = await askHuman({ seam, agent: {}, question: {}, onTimeout: 'never' });
  assert.equal(result.outcome, 'answered');
});

test('the question carries an id, which the seam requires', () => {
  // Measured: `ask()` rejects a question without `id`, and the rejection surfaced as 「没有许可（error）」 with no
  // dialog ever appearing — the gate looked like it worked while the human was never actually asked.
  const built = confirmationQuestion({ groupName: 'G', sender: 'S', text: 't' });
  assert.equal(typeof built.questions[0].id, 'string');
  assert.ok(built.questions[0].id.length > 0);
});

test('an approval is read from `selected`, which is the shape the seam returns', () => {
  // The seam answers `{ answers: [{ id, selected: [...] }] }`. Reading `item.label` (an earlier version) found
  // nothing and turned every approval into a denial.
  const approved = decideFromAnswer({ outcome: 'answered', answer: { answers: [{ id: 'q', selected: ['允许'] }] } });
  assert.equal(approved.proceed, true);
  const denied = decideFromAnswer({ outcome: 'answered', answer: { answers: [{ id: 'q', selected: ['拒绝'] }] } });
  assert.equal(denied.proceed, false);
});

test('a Host-side deadline fires even when askTimed never settles', async () => {
  // Measured: the seam's countdown lives in the CLIENT. A turn woken by a group message has no client attached, so
  // nothing ever rejects and a request configured for 300 seconds was still pending after more than 5 minutes.
  // That made `onTimeout` decorative and the turn would hang forever. The Host must own the deadline.
  const seam = {
    askTimed: () => new Promise(() => {}),  // never settles, like a request nobody will answer
  };
  const started = Date.now();
  const result = await askHuman({ seam, agent: {}, question: { questions: [] }, onTimeout: 'deny', timeoutMs: 60 });
  const elapsed = Date.now() - started;
  assert.equal(result.outcome, 'timed-out-deny');
  assert.ok(elapsed < 2000, `the Host deadline must fire, took ${elapsed}ms`);
  assert.equal(decideFromAnswer(result).proceed, false);
});

test('the Host deadline honours the allow policy too', async () => {
  const seam = { askTimed: () => new Promise(() => {}) };
  const result = await askHuman({ seam, agent: {}, question: { questions: [] }, onTimeout: 'allow', timeoutMs: 60 });
  assert.equal(result.outcome, 'timed-out-allow');
  assert.equal(decideFromAnswer(result).proceed, true);
});

test('the title names the sender when it is known, because that is the 「谁」', () => {
  const built = confirmationQuestion({ groupName: 'G', draft: 'x', replyingTo: 287, sender: '张三' });
  // 「谁」 belongs in the title: replying to 张三 is a different decision from a reply nobody asked for. This only became
  // possible after the card switched from askTimed to ask() — the countdown controls used to squeeze the title to 43px.
  assert.equal(built.questions[0].question, '回复 张三？');
  // Short enough to stay on one line even in the narrow card.
  assert.ok(built.questions[0].question.length <= 10, `got ${built.questions[0].question}`);
  // The name is repeated in detail, where the reader looks when deciding about the notice wording.
  assert.match(built.questions[0].detail, /张三/);
  // The seq still has to be somewhere: it stays in detail, where there is room.
  assert.match(built.questions[0].detail, /#287/);
});

test('an unknown sender falls back to neutral wording instead of inventing a name', () => {
  const built = confirmationQuestion({ groupName: 'G', draft: 'x', replyingTo: 287, sender: '' });
  assert.ok(built.questions[0].detail.indexOf('张三') === -1);
  assert.match(built.questions[0].detail, /#287/);
  // And it must NOT invent 「一位同事」 or similar: naming nobody is better than naming a fiction.
  assert.ok(built.questions[0].detail.indexOf('一位同事') === -1);
});
