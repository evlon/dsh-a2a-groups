/**
 * Human confirmation before a Session acts on somebody else's group message.
 *
 * WHAT PROBLEM THIS SOLVES
 *
 * A colleague sends a task into a group; that message wakes this Session and it starts working. In a real team the
 * person on the receiving end decides whether and when to take it on — the sender cannot compel it. Here the same must
 * hold, which means the Session has to stop and ask its own human first.
 *
 * WHY THE QUESTION IS ASKED FROM INSIDE A TOOL CALL
 *
 * The Host exposes `ctx.userQuestions`, whose contract is explicit: it pauses an agent tool call until the human
 * answers. Measured on a live instance, a group-woken turn receives the same live runtime root agent as a typed one
 * (`agentLooksOwned: false`, `agentParentType: undefined`), so `ask()` is valid there too. If it were an owned child the
 * call would refuse with `DELEGATED_CALLER` and, worse, block forever.
 *
 * WHY EVERYTHING IS A SETTING
 *
 * The right policy differs per person and per group: someone at a desk wants to be asked, an unattended bot wants
 * timeouts to deny, a chatty group wants no prompts. Nothing here is a fixed rule except one: an unimplemented channel
 * must fail loudly instead of silently skipping the check, because a skipped check looks exactly like an approved one.
 *
 * @module dsh-a2a/human-confirm
 */

/** The channels a question can travel over. Only `question` is implemented. */
export const CHANNELS = Object.freeze(['question', 'im']);

/** When a question is worth asking. */
export const TRIGGERS = Object.freeze(['mention', 'always', 'never']);

/** What to do when the human does not answer in time. */
export const TIMEOUTS = Object.freeze(['never', 'deny', 'allow']);

/**
 * Decide whether this post should stop and ask.
 *
 * Returns a VERDICT rather than a boolean so the caller can say why — "no question" and "asked but the channel is
 * unimplemented" are different outcomes and must not collapse into the same silent path.
 *
 * @param {object} input - `{ settings, post, grade }`.
 * @returns {{ ask: boolean, reason: string, channel?: string, onTimeout?: string, timeoutMs?: number }} verdict.
 */
export function confirmationPolicy({ settings, post, grade }) {
  const cfg = settings?.groups?.humanConfirm ?? {};
  if (cfg.enabled !== true) return { ask: false, reason: 'disabled' };
  const trigger = cfg.trigger ?? 'mention';
  if (trigger === 'never') return { ask: false, reason: 'trigger-never' };

  // Only these two grades represent something addressed to this member. `ambient` means the post named somebody else,
  // and asking about it would interrupt for a message that was not for us.
  const addressed = grade === 'mention' || grade === 'notice';
  if (!addressed) return { ask: false, reason: 'not-addressed' };
  if (trigger === 'mention' && grade !== 'mention') return { ask: false, reason: 'trigger-mention-only' };

  const channel = cfg.channel ?? 'question';
  if (channel !== 'question') {
    // Reserved for delivering the question over an instant messenger. It is not built, and pretending otherwise would
    // remove the protection while reporting success.
    return { ask: true, reason: 'channel-unimplemented', channel };
  }

  return {
    ask: true,
    reason: 'ask',
    channel,
    onTimeout: cfg.onTimeout ?? 'deny',
    timeoutMs: Number.isFinite(cfg.timeoutMs) ? cfg.timeoutMs : 300000,
  };
}

/**
 * The question text a human reads.
 *
 * It names the sender, quotes the message, and states what saying yes will do — a question that only says "confirm?"
 * leaves the human guessing what they are approving.
 *
 * @param {object} input - `{ groupName, sender, text }`.
 * @returns {object} a user-questions request payload (without the agent).
 */
export function confirmationQuestion({ groupName, sender, text }) {
  const who = typeof sender === 'string' && sender !== '' ? sender : '一位同事';
  const where = typeof groupName === 'string' && groupName !== '' ? `「${groupName}」` : '协作群';
  const body = typeof text === 'string' ? text.trim() : '';
  const quoted = body.length > 600 ? `${body.slice(0, 600)}…` : body;
  return {
    questions: [
      {
        question: `${who} 在${where}发来：\n\n${quoted === '' ? '(没有正文)' : quoted}\n\n是否让这个会话开始处理？`,
        options: [
          { label: '允许', description: '这个会话会立即开始处理这条任务' },
          { label: '拒绝', description: '不处理，发送方会看到被拒绝' },
        ],
      },
    ],
  };
}

/**
 * Ask the human, honouring the configured timeout policy.
 *
 * Four outcomes, and the caller must distinguish all of them:
 *
 *   approved | denied            the human answered
 *   timed-out-deny               nobody answered, policy says refuse
 *   timed-out-allow              nobody answered, policy says proceed
 *   unanswered                   `onTimeout: 'never'` — still waiting, which is NOT success
 *
 * @param {object} input - `{ seam, agent, question, onTimeout, timeoutMs }`.
 * @returns {Promise<{ outcome: string, answer?: object, error?: string }>} what happened.
 */
export async function askHuman({ seam, agent, question, onTimeout = 'deny', timeoutMs = 300000 }) {
  // Either method is enough to ask. `askTimed` alone is a complete seam — it is the one that returns a `pending` result
  // when the window closes — so requiring `ask` specifically would reject a Host that only implements the better one.
  // Measured by test: an earlier version returned `unavailable` for a seam that had askTimed only.
  const hasAsk = typeof seam?.ask === 'function';
  const hasAskTimed = typeof seam?.askTimed === 'function';
  if (hasAsk !== true && hasAskTimed !== true) {
    return { outcome: 'unavailable', error: 'userQuestions seam is not available on this Host' };
  }
  if (agent === undefined || agent === null) {
    return { outcome: 'unavailable', error: 'no agent on the tool call, so the question has no owner' };
  }

  try {
    // `onTimeout: 'never'` waits indefinitely. That is what the setting says, and the caller was warned about it.
    if (onTimeout === 'never') {
      if (typeof seam.ask !== 'function') {
        return {
          outcome: 'unavailable',
          error: 'this Host offers only askTimed, which requires a bound, so onTimeout "never" cannot be honoured',
        };
      }
      const answer = await seam.ask({ ...question, agent });
      return { outcome: 'answered', answer };
    }
    // A bounded wait uses askTimed, whose contract already maps a client-side countdown to a `pending` result — which is
    // the same shape the Host uses when no client claims the request. Reusing it keeps one definition of "timed out".
    if (typeof seam.askTimed === 'function') {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const result = await seam.askTimed(
          { ...question, agent, signal: controller.signal },
          `${Date.now()}`,
          timeoutMs,
        );
        if (result !== null && typeof result === 'object' && result.pending === true) {
          return { outcome: onTimeout === 'allow' ? 'timed-out-allow' : 'timed-out-deny' };
        }
        return { outcome: 'answered', answer: result };
      } finally {
        clearTimeout(timer);
      }
    }
    // No askTimed, or an unbounded wait was requested on a seam that only offers askTimed.
    if (typeof seam.ask !== 'function') {
      // `never` means an unbounded wait, and askTimed always needs a bound. Rather than invent one — which would
      // silently turn "wait forever" into "wait an hour" — this is reported as a configuration the Host cannot honour.
      return {
        outcome: 'unavailable',
        error: 'this Host offers only askTimed, which needs a bound, so onTimeout "never" cannot be honoured',
      };
    }
    // Bound it ourselves, and treat the abort as the timeout rather than as an error.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const answer = await seam.ask({ ...question, agent, signal: controller.signal });
      return { outcome: 'answered', answer };
    } catch (error) {
      const message = String(error?.message ?? error);
      if (controller.signal.aborted) {
        return { outcome: onTimeout === 'allow' ? 'timed-out-allow' : 'timed-out-deny' };
      }
      return { outcome: 'error', error: message };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return { outcome: 'error', error: String(error?.message ?? error) };
  }
}

/**
 * Turn an ask outcome into the decision the caller acts on.
 *
 * @param {object} result - what `askHuman` returned.
 * @returns {{ proceed: boolean, reason: string }} decision.
 */
export function decideFromAnswer(result) {
  const outcome = result?.outcome;
  if (outcome === 'timed-out-allow') return { proceed: true, reason: 'timeout-allow' };
  if (outcome === 'timed-out-deny') return { proceed: false, reason: 'timeout-deny' };
  if (outcome !== 'answered') {
    // `unavailable`, `error`, and an unanswered `never` all mean the human did not say yes. Treating any of them as
    // approval would make the check meaningless exactly when it matters.
    return { proceed: false, reason: outcome ?? 'unknown' };
  }
  const answers = result?.answer?.answers ?? result?.answer ?? [];
  const list = Array.isArray(answers) ? answers : [answers];
  for (const item of list) {
    const label = typeof item === 'string' ? item : (item?.label ?? item?.value ?? '');
    if (String(label).indexOf('允许') > -1 || String(label).toLowerCase() === 'allow') {
      return { proceed: true, reason: 'approved' };
    }
  }
  return { proceed: false, reason: 'denied' };
}
