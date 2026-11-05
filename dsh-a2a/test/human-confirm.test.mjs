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

test('the question names the sender, the group, and what saying yes does', () => {
  const built = confirmationQuestion({ groupName: '发票与对账平台', sender: '张三', text: '请帮我核对一下对账口径' });
  const text = built.questions[0].question;
  assert.match(text, /张三/);
  assert.match(text, /发票与对账平台/);
  assert.match(text, /核对一下对账口径/);
  // Both options must exist and say what they do, or the human cannot choose knowingly.
  const labels = built.questions[0].options.map((option) => option.label);
  assert.deepEqual(labels, ['允许', '拒绝']);
});

test('a very long message is shortened rather than dumped into the question', () => {
  const built = confirmationQuestion({ groupName: 'G', sender: 'S', text: 'x'.repeat(5000) });
  const text = built.questions[0].question;
  assert.ok(text.length < 900, `question should stay readable, got ${text.length} chars`);
  assert.match(text, /…/);
});

test('an empty message still produces a usable question', () => {
  const built = confirmationQuestion({ groupName: 'G', sender: 'S', text: '' });
  assert.match(built.questions[0].question, /没有正文/);
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

test('an answered question reports denial when the human chose 拒绝', async () => {
  const seam = { ask: async () => ({ answers: [{ id: 'a2a-human-confirm', selected: ['拒绝'] }] }) };
  const result = await askHuman({ seam, agent: {}, question: {}, onTimeout: 'never' });
  assert.deepEqual(decideFromAnswer(result), { proceed: false, reason: 'denied' });
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
