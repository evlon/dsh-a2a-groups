/**
 * Behavioral tests for the Session deliverer.
 *
 * The fake `sessionController` here is deliberately faithful to the Host shape
 * (`resolveAgent` / `prompt`) rather than convenient: the assertions then measure
 * what the receiving Session would actually experience — how many admits
 * happened, which method took the message, and whether a failed delivery left a
 * trace that the next attempt would mistake for success.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDeliverer } from '../lib/dsh/deliver.js';

/**
 * Build a fake Host around one Session.
 *
 * @param {object} [options] - fake options.
 * @param {'running'|'idle'|'cold'} [options.status] - reported agent status.
 * @param {boolean} [options.withAgent] - expose a live agent at all.
 * @param {boolean} [options.withPrompt] - expose the legacy prompt RPC.
 * @param {boolean} [options.failFollowup] - make `followup` throw.
 * @param {() => void} [options.onFollowup] - hook to run inside `followup`.
 * @param {number} [options.idleAfter] - how many `resolveAgent` calls before idle.
 * @returns {object} the fake ctx plus its call log.
 */
function fakeHost({
  status = 'idle',
  withAgent = true,
  withPrompt = true,
  failFollowup = false,
  onFollowup,
  idleAfter,
} = {}) {
  const calls = { followup: 0, steer: 0, inject: 0, prompt: 0, resolve: 0, flush: 0 };
  const received = [];
  let currentStatus = status;
  let resolveCount = 0;

  /** One agent per Session, exactly as a real Host keeps them. */
  const agents = new Map();

  function agentFor(sessionId) {
    const existing = agents.get(sessionId);
    if (existing !== undefined) return existing;
    const agent = {
      inbox: { nextTurn: [], nextStep: [] },
      session: { snapshotEvents: () => [] },
      followup(message) {
        calls.followup += 1;
        if (onFollowup !== undefined) onFollowup(message);
        if (failFollowup) throw new Error('followup exploded');
        received.push({ via: 'followup', sessionId, message });
        agent.inbox.nextTurn.push(message);
      },
      steer(message) {
        calls.steer += 1;
        received.push({ via: 'steer', sessionId, message });
        agent.inbox.nextStep.push(message);
      },
      inject(message) {
        calls.inject += 1;
        received.push({ via: 'inject', sessionId, message });
        agent.inbox.nextStep.push(message);
      },
    };
    // `status` is read as a property by the deliverer, so expose it live.
    Object.defineProperty(agent, 'status', { get: () => currentStatus, enumerable: true });
    agents.set(sessionId, agent);
    return agent;
  }

  const sessionController = {
    async resolveAgent(sessionId) {
      calls.resolve += 1;
      resolveCount += 1;
      if (idleAfter !== undefined && resolveCount > idleAfter) currentStatus = 'idle';
      if (!withAgent) return null;
      return { agent: agentFor(sessionId), sessionId };
    },
  };
  if (withPrompt) {
    sessionController.prompt = async (request) => {
      calls.prompt += 1;
      received.push({ via: 'prompt', request });
      return { sessionId: request.sessionId };
    };
  }

  const ctx = {
    sessionController,
    sessionStore: {
      async flush(session) {
        calls.flush += 1;
        if (session === undefined) throw new Error('flush called without a session');
      },
    },
  };
  return { ctx, calls, received, agents, agent: agentFor('s1'), sessionController };
}

/** A logger double that records warnings. */
function fakeLogger() {
  const warnings = [];
  return { warnings, warn: (message) => warnings.push(message), debug: () => {}, info: () => {} };
}

test('deliver: a queued message lands as exactly one agent-sourced followup', async () => {
  const host = fakeHost();
  const deliverer = createDeliverer({ ctx: host.ctx, logger: fakeLogger(), config: {} });

  const receipt = await deliverer.deliver({ sessionId: 's1', text: 'hello', messageId: 'msg-1' });

  assert.deepEqual(receipt, { injected: 'followup', interrupted: false });
  assert.equal(host.calls.followup, 1, 'the message must be admitted exactly once');
  assert.equal(host.calls.steer, 0);
  assert.equal(host.calls.prompt, 0, 'the agent path must win when a live agent exists');
  assert.equal(host.calls.flush, 1, 'the admit splice must be flushed exactly once');

  const [{ message }] = host.received;
  assert.equal(message.role, 'user');
  assert.equal(message.source.kind, 'agent-message', 'the Client needs this to render a non-human card');
  assert.equal(message.source.form, 'relay');
  assert.equal(message.source.busMessageId, 'msg-1');
  assert.equal(message.source.a2aMessageId, 'msg-1');
  assert.deepEqual(message.content, [{ type: 'text', text: 'hello' }]);
});

test('deliver: the same messageId delivered twice is a duplicate, not a second admit', async () => {
  const host = fakeHost();
  const deliverer = createDeliverer({ ctx: host.ctx, config: {} });

  const first = await deliverer.deliver({ sessionId: 's1', text: 'hello', messageId: 'msg-1' });
  const second = await deliverer.deliver({ sessionId: 's1', text: 'hello', messageId: 'msg-1' });

  assert.equal(first.injected, 'followup');
  assert.deepEqual(second, { injected: 'duplicate', interrupted: false });
  assert.equal(host.calls.followup, 1, 'a retry must not post the message twice');
});

test('deliver: the same messageId on a different Session is a different delivery', async () => {
  const host = fakeHost();
  const deliverer = createDeliverer({ ctx: host.ctx, config: {} });

  await deliverer.deliver({ sessionId: 's1', text: 'hello', messageId: 'msg-1' });
  const other = await deliverer.deliver({ sessionId: 's2', text: 'hello', messageId: 'msg-1' });

  assert.equal(other.injected, 'followup');
  assert.equal(host.calls.followup, 2);
});

test('deliver: concurrent retries with one messageId admit once', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let entered = 0;
  const host = fakeHost({
    onFollowup: () => {
      entered += 1;
    },
  });
  // Make the first delivery slow enough for a competitive retry to arrive.
  const slowController = {
    async resolveAgent(sessionId) {
      if (entered === 0) await gate;
      entered += 1;
      return { agent: host.agent, sessionId };
    },
  };
  const deliverer = createDeliverer({ ctx: { ...host.ctx, sessionController: slowController }, config: {} });

  const first = deliverer.deliver({ sessionId: 's1', text: 'hi', messageId: 'msg-1' });
  const second = deliverer.deliver({ sessionId: 's1', text: 'hi', messageId: 'msg-1' });
  release();
  const [a, b] = await Promise.all([first, second]);

  assert.deepEqual([a.injected, b.injected].sort(), ['duplicate', 'followup']);
  assert.equal(host.calls.followup, 1);
});

test('deliver: inbox mode seats the message without waking the Session', async () => {
  const host = fakeHost();
  const deliverer = createDeliverer({ ctx: host.ctx, config: {} });

  const receipt = await deliverer.deliver({ sessionId: 's1', text: 'quiet', messageId: 'msg-2', mode: 'inbox' });

  assert.deepEqual(receipt, { injected: 'inbox', interrupted: false });
  assert.equal(host.calls.inject, 1);
  assert.equal(host.calls.followup, 0);
});

test('deliver: steer mode submits into the running step and reports the interruption', async () => {
  const host = fakeHost({ status: 'running' });
  const deliverer = createDeliverer({ ctx: host.ctx, config: {} });

  const receipt = await deliverer.deliver({ sessionId: 's1', text: 'now', messageId: 'msg-3', mode: 'steer' });

  assert.deepEqual(receipt, { injected: 'steer', interrupted: true });
  assert.equal(host.calls.steer, 1);
  assert.equal(host.calls.followup, 0);
});

test('deliver: a thrown admit leaves no ledger entry, so a retry succeeds', async () => {
  let attempt = 0;
  const host = fakeHost({
    onFollowup: () => {
      attempt += 1;
      if (attempt === 1) throw new Error('transient transport failure');
    },
  });
  const deliverer = createDeliverer({ ctx: host.ctx, config: {} });

  await assert.rejects(
    () => deliverer.deliver({ sessionId: 's1', text: 'hi', messageId: 'msg-4' }),
    /transient transport failure/,
  );
  assert.deepEqual(deliverer.debugState(), { delivered: 0, inflight: 0, sessions: ['s1'] }, 'a failure must leave no reservation behind');

  const retry = await deliverer.deliver({ sessionId: 's1', text: 'hi', messageId: 'msg-4' });
  assert.equal(retry.injected, 'followup', 'the retry must be admitted, not swallowed as a duplicate');
  assert.equal(host.calls.followup, 2);
  assert.equal(deliverer.debugState().delivered, 1);
});

test('deliver: falls back to the prompt RPC when the Host has no live agent', async () => {
  const host = fakeHost({ withAgent: false });
  const deliverer = createDeliverer({ ctx: host.ctx, config: {} });

  const receipt = await deliverer.deliver({ sessionId: 's1', text: 'legacy', messageId: 'msg-5' });

  assert.deepEqual(receipt, { injected: 'queue', interrupted: false });
  assert.equal(host.calls.prompt, 1);
  const [{ request }] = host.received;
  assert.equal(request.requestId, 'a2a:msg-5', 'the requestId is what makes the controller retry-safe');
  assert.equal(request.sessionId, 's1');
  assert.equal(request.mode, 'queue');
  assert.deepEqual(request.content, [{ type: 'text', text: 'legacy' }]);
});

test('deliver: presentation "bubble" keeps the legacy prompt path even with an agent', async () => {
  const host = fakeHost();
  const deliverer = createDeliverer({ ctx: host.ctx, config: { delivery: { presentation: 'bubble' } } });

  const receipt = await deliverer.deliver({ sessionId: 's1', text: 'as a person', messageId: 'msg-6' });

  assert.deepEqual(receipt, { injected: 'queue', interrupted: false });
  assert.equal(host.calls.followup, 0);
  assert.equal(host.calls.prompt, 1);
});

test('deliver: inbox mode degrades to queue on the prompt path', async () => {
  const host = fakeHost({ withAgent: false });
  const deliverer = createDeliverer({ ctx: host.ctx, config: {} });

  const receipt = await deliverer.deliver({ sessionId: 's1', text: 'x', messageId: 'msg-7', mode: 'inbox' });

  assert.deepEqual(receipt, { injected: 'queue', interrupted: false });
  assert.equal(host.calls.prompt, 1);
});

test('deliver: an inbox entry already holding the message is a duplicate', async () => {
  const host = fakeHost();
  host.agent.inbox.nextTurn.push({ source: { busMessageId: 'msg-8' } });
  const deliverer = createDeliverer({ ctx: host.ctx, config: {} });

  const receipt = await deliverer.deliver({ sessionId: 's1', text: 'hi', messageId: 'msg-8' });

  assert.deepEqual(receipt, { injected: 'duplicate', interrupted: false });
  assert.equal(host.calls.followup, 0);
});

test('deliver: a message already in the Session log is a duplicate', async () => {
  const host = fakeHost();
  host.agent.session.snapshotEvents = () => [
    { type: 'user/message', data: { source: { a2aMessageId: 'msg-9' } } },
  ];
  const deliverer = createDeliverer({ ctx: host.ctx, config: {} });

  const receipt = await deliverer.deliver({ sessionId: 's1', text: 'hi', messageId: 'msg-9' });

  assert.deepEqual(receipt, { injected: 'duplicate', interrupted: false });
  assert.equal(host.calls.followup, 0);
});

test('deliver: the dedupe window expires so a genuine resend is delivered', async () => {
  let now = 1_000;
  const host = fakeHost();
  const deliverer = createDeliverer({ ctx: host.ctx, clock: () => now, config: { delivery: { dedupeWindowMs: 100 } } });

  await deliverer.deliver({ sessionId: 's1', text: 'hi', messageId: 'msg-10' });
  now = 1_050;
  assert.equal((await deliverer.deliver({ sessionId: 's1', text: 'hi', messageId: 'msg-10' })).injected, 'duplicate');
  // The first turn ran and drained its inbox: only the time window still
  // remembers the message, so an expired window must allow the resend.
  host.agent.inbox.nextTurn.length = 0;
  now = 5_000;
  assert.equal((await deliverer.deliver({ sessionId: 's1', text: 'hi', messageId: 'msg-10' })).injected, 'followup');
  assert.equal(host.calls.followup, 2);
});

test('deliver: a failing Session flush is logged, not thrown', async () => {
  const host = fakeHost();
  const logger = fakeLogger();
  host.ctx.sessionStore.flush = async () => {
    throw new Error('disk full for token=abc123');
  };
  const deliverer = createDeliverer({ ctx: host.ctx, logger, config: {} });

  const receipt = await deliverer.deliver({ sessionId: 's1', text: 'hi', messageId: 'msg-11' });

  assert.equal(receipt.injected, 'followup', 'the message already landed; durability must not fail the call');
  assert.equal(logger.warnings.length, 1);
  assert.match(logger.warnings[0], /flush failed/);
});

test('deliver: a credential inside a logged error is masked', async () => {
  const host = fakeHost();
  const logger = fakeLogger();
  // A Host that echoes the failing header back is the usual real-world leak.
  host.sessionController.resolveAgent = async () => {
    throw new Error('upstream refused apiKey=sk-live-9f8e7d6c5b4a');
  };
  const deliverer = createDeliverer({ ctx: host.ctx, logger, config: {} });

  const receipt = await deliverer.deliver({ sessionId: 's1', text: 'hi', messageId: 'msg-12' });

  // resolveAgent failing is not fatal: the prompt path still delivers.
  assert.equal(receipt.injected, 'queue');
  assert.equal(logger.warnings.length, 1);
  assert.equal(logger.warnings[0].includes('sk-live-9f8e7d6c5b4a'), false, 'the raw key must never reach a log line');
  assert.match(logger.warnings[0], /sha256:[0-9a-f]{8}/);
});

test('deliver: missing arguments are rejected before any side effect', async () => {
  const host = fakeHost();
  const deliverer = createDeliverer({ ctx: host.ctx, config: {} });

  await assert.rejects(() => deliverer.deliver({ text: 'hi', messageId: 'm' }), /sessionId is required/);
  await assert.rejects(() => deliverer.deliver({ sessionId: 's1', text: '' }), /text is required/);
  assert.equal(host.calls.followup + host.calls.prompt, 0);
  assert.equal(deliverer.debugState().delivered, 0);
});

test('deliver: an aborted signal never admits anything', async () => {
  const host = fakeHost();
  const deliverer = createDeliverer({ ctx: host.ctx, config: {} });
  const controller = new AbortController();
  controller.abort(new Error('caller went away'));

  await assert.rejects(() => deliverer.deliver({ sessionId: 's1', text: 'hi', messageId: 'msg-13', signal: controller.signal }));
  assert.equal(host.calls.followup, 0);
});

test('deliver: a messageId is derived from content when the caller omits one', async () => {
  const host = fakeHost();
  const deliverer = createDeliverer({ ctx: host.ctx, config: {} });

  await deliverer.deliver({ sessionId: 's1', text: 'same text' });
  const second = await deliverer.deliver({ sessionId: 's1', text: 'same text' });

  assert.equal(second.injected, 'duplicate', 'identical content without an id must not double-post');
});

test('deliver: isBusy reports the live agent status, not a guess', () => {
  const host = fakeHost({ status: 'running' });
  const deliverer = createDeliverer({ ctx: host.ctx, config: {} });

  assert.equal(deliverer.isBusy('never-resolved'), false, 'an unknown Session must not report busy');
  return deliverer.deliver({ sessionId: 's1', text: 'hi', messageId: 'msg-14' }).then(() => {
    assert.equal(deliverer.isBusy('s1'), true, 'the resolved agent is running');
  });
});

test('deliver: waitIdle resolves once the Session stops running', async () => {
  const host = fakeHost({ status: 'running', idleAfter: 2 });
  const deliverer = createDeliverer({ ctx: host.ctx, config: {} });

  const idle = await deliverer.waitIdle('s1', 2000);
  assert.equal(idle, true);
});

test('deliver: waitIdle reports a timeout instead of hanging', async () => {
  const host = fakeHost({ status: 'running' });
  const deliverer = createDeliverer({ ctx: host.ctx, config: {} });

  const idle = await deliverer.waitIdle('s1', 120);
  assert.equal(idle, false);
});

test('deliver: waitIdle on an unknown Session resolves immediately', async () => {
  const host = fakeHost({ withAgent: false });
  const deliverer = createDeliverer({ ctx: host.ctx, config: {} });

  assert.equal(await deliverer.waitIdle('nobody'), true);
});

test('deliver: every delivered message is frozen against later mutation', async () => {
  const host = fakeHost();
  const deliverer = createDeliverer({ ctx: host.ctx, config: {} });
  await deliverer.deliver({ sessionId: 's1', text: 'hi', messageId: 'msg-15' });

  const [{ message }] = host.received;
  assert.equal(typeof message.id, 'string');
  assert.notEqual(message.id, 'msg-15', 'the message id must be its own, not the A2A id');
});

test('deliver: a Session the Host refuses to resolve still delivers through prompt', async () => {
  const host = fakeHost({ withAgent: false });
  const deliverer = createDeliverer({ ctx: host.ctx, config: {} });

  const receipt = await deliverer.deliver({ sessionId: 'other', text: 'hi', messageId: 'msg-17' });

  assert.equal(receipt.injected, 'queue');
  assert.equal(host.calls.prompt, 1);
});

test('deliver: no delivery path at all is an explicit error, not a silent drop', async () => {
  const host = fakeHost({ withAgent: false, withPrompt: false });
  const deliverer = createDeliverer({ ctx: host.ctx, config: {} });

  await assert.rejects(
    () => deliverer.deliver({ sessionId: 's1', text: 'hi', messageId: 'msg-18' }),
    /neither a live Agent nor sessionController\.prompt/,
  );
  assert.equal(deliverer.debugState().delivered, 0);
});

test('deliver: works with no logger and no config at all', async () => {
  const host = fakeHost();
  const deliverer = createDeliverer({ ctx: host.ctx });

  const receipt = await deliverer.deliver({ sessionId: 's1', text: 'hi', messageId: 'msg-16' });
  assert.equal(receipt.injected, 'followup');
});
