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

import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The channels a question can travel over. Only `question` is implemented. */
export const CHANNELS = Object.freeze(['question', 'im']);

/** When a question is worth asking. */
export const TRIGGERS = Object.freeze(['mention', 'always', 'never']);

/** What to do when the human does not answer in time. */
export const TIMEOUTS = Object.freeze(['never', 'deny', 'allow']);

/**
 * Record what a confirmation actually did, for diagnosis.
 *
 * A confirmation that answers itself is the one failure this feature cannot tolerate: if it silently approves when no
 * client is attached, 「ask me first」 becomes 「do whatever you like」 while the person believes they are protected.
 * Writing the outcome down is what lets that claim be checked instead of assumed.
 *
 * Best-effort: diagnostics must never be the reason a refusal fails to happen.
 *
 * @param {object} detail - what to record.
 * @returns {void}
 */
function writeAnswerTrace(detail) {
  // Synchronous on purpose: these traces are written moments apart (enter → before-call → after-call) and an async
  // write would race with the next one, leaving only the last. A diagnostic that loses the step before the hang is
  // worse than none, because it looks like the earlier step never ran.
  try {
    appendFileSync(
      join(tmpdir(), 'a2a-human-confirm-trace.log'),
      `${new Date().toISOString()} ${JSON.stringify(detail)}\n`,
      'utf8',
    );
  } catch {
    // Ignored on purpose.
  }
}

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
 * WHAT THE PERSON IS ACTUALLY APPROVING
 *
 * Not 「someone sent you a message」 — the reply this Session has already drafted and wants to send. That draft is the
 * thing that will become visible to colleagues, so it belongs in front of them, verbatim.
 *
 * THREE FIELDS, NOT ONE
 *
 * The seam renders `header` as a small eyebrow line, `question` as the 16px TITLE, and `detail` as Markdown under it.
 * An earlier version put everything into `question` alone, so a long draft became a 16px headline wrapped into a narrow
 * column. Reported as 「不如 user question 总结得好」.
 *
 *   header    which group     a place, not a sentence
 *   question  the decision    one line: send this reply or not
 *   detail    the draft       quoted verbatim, plus what each choice does
 *
 * Option descriptions state the CONSEQUENCE rather than restating the label: 「允许」 and 「拒绝」 mean nothing unless the
 * reader knows whether their colleagues will see something.
 *
 * @param {object} input - `{ groupName, draft, replyingTo, sender }`.
 * @returns {object} a user-questions request payload (without the agent).
 */
export function confirmationQuestion({ groupName, draft, replyingTo, sender }) {
  const where = typeof groupName === 'string' && groupName.trim() !== '' ? groupName.trim() : '';
  const body = typeof draft === 'string' ? draft.trim() : '';
  const thread = typeof replyingTo === 'number' ? replyingTo : undefined;
  const who = typeof sender === 'string' ? sender.trim() : '';

  // Quote the draft so it reads as material rather than as the question itself. A long one is cut with a VISIBLE
  // marker: silently truncating would let the reader approve something they were never shown.
  const LIMIT = 900;
  const clipped = body.length > LIMIT
    ? `${body.slice(0, LIMIT)}\n\n…（还有 ${body.length - LIMIT} 字未显示）`
    : body;
  const quoted = clipped === ''
    ? '_（这条回复没有正文）_'
    : clipped.split('\n').map((line) => `> ${line}`).join('\n');

  const wherePhrase = where === '' ? '群里' : `「${where}」`;
  const threadPhrase = thread === undefined ? '' : `#${thread}`;

  return {
    questions: [
      {
        // `id` is REQUIRED by the seam and is echoed back in the answer. Omitting it made `ask()` reject the request
        // outright, which surfaced as 「没有许可（error）」 and no dialog at all — measured on a live run.
        id: 'a2a-human-confirm',
        header: where === '' ? '协作群' : where,
        // VERY SHORT — measured against the real layout, not guessed.
        //
        // The card is 340px wide but the title block gets only 43px, because the header's right-hand controls
        // (「172秒后继续工作」 「慢慢回答」 「×」) claim the rest. 43px is about THREE Chinese characters per line.
        //
        // Measured title widths, in order:
        //   「要往「发票与对账平台」回复 #287，允许吗？」  → 8 lines
        //   「回复 张三 · #287？」                        → 3 lines
        //   「回复 张三？」                              → 3 lines (still!)
        //
        // So the title cannot carry any name at all. It carries only the ACTION — the one word that decides what the
        // buttons mean — and every piece of identifying context moves to `detail`, where the full 340px is available.
        question: '发出这条回复？',
        detail: [
          // Who and which message, first, because that is what the reader looks for.
          who === '' && thread === undefined ? '' : [who === '' ? '' : `**${who}**`, thread === undefined ? '' : `#${thread}`].filter(Boolean).join(' · '),
          quoted,
          '---',
          // Every option says what the COLLEAGUE will experience, not just what this Session will do. Silence is the one
          // outcome a sender cannot interpret: 「没回」 reads as ignored, slow, or broken, and none of those is what the
          // person actually chose.
          `**允许** → 发到${wherePhrase}`,
          `**稍后处理** → 先不发，告诉${who === '' ? '对方' : who}「我晚点回复」`,
          `**拒绝** → 不发，告诉${who === '' ? '对方' : who}「这次不回」`,
        ].filter((part) => part !== '').join('\n\n'),
        options: [
          { label: '允许', description: `现在回复，发到${wherePhrase}` },
          // Separate from 拒绝 on purpose. 「我看到了，但晚点再说」 and 「这条我不打算回」 are different answers, and in a
          // group they lead to different follow-ups. Collapsing them forces the person to pick the wrong one.
          { label: '稍后处理', description: '先不回，但让对方知道你看过了' },
          { label: '拒绝', description: '不回，也让对方知道' },
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
  // Record entry before anything can go wrong.
  //
  // Measured twice: a request configured for 180 seconds was still pending five minutes later, and NO trace file was
  // written — which left two possibilities indistinguishable (never entered here, or entered and hung). This line
  // separates them.
  writeAnswerTrace({ step: 'enter', onTimeout, timeoutMs, hasSeam: seam !== undefined && seam !== null });
  const hasAsk = typeof seam?.ask === 'function';
  const hasAskTimed = typeof seam?.askTimed === 'function';
  if (hasAsk !== true && hasAskTimed !== true) {
    return { outcome: 'unavailable', error: 'userQuestions seam is not available on this Host' };
  }
  if (agent === undefined || agent === null) {
    return { outcome: 'unavailable', error: 'no agent on the tool call, so the question has no owner' };
  }

  // THE DEADLINE LIVES IN THE HOST.
  //
  // The seam's own countdown is a CLIENT-side thing (「the Client rejects with ASK_TIMED_OUT when its countdown ends」).
  // When no client is attached — the normal case for a turn a group message woke while nobody is watching — nothing
  // ever rejects. Measured: a request configured for 300 seconds was still pending after 5 minutes, so the setting was
  // decorative and the turn could hang indefinitely. Enforcing it here means a missing UI cannot skip it.
  const bounded = onTimeout !== 'never';

  // ask() WITH OUR OWN SIGNAL, NOT askTimed.
  //
  // askTimed sets `wait.timed`, which makes the client render a countdown (「172秒后继续工作」) and a 「慢慢回答」 button
  // in the card header. Those controls claim 241px of a 340px card, leaving the TITLE 43px — about three characters.
  // Measured: the title wrapped into four lines (88px tall) no matter how short the text was.
  //
  // With ask() the header keeps only its close button (52px), the title gets 112px, and it renders on ONE line (22px).
  // The trade is that the reader is no longer shown how long they have; a card nobody can read is worse than a card
  // without a countdown.
  //
  // A caller-supplied signal IS valid here. The ASK_ABORTED failure recorded earlier came from passing one to askTimed,
  // which reads an external signal as "the caller already gave up".
  if (hasAsk === true) {
    writeAnswerTrace({ step: 'before-ask', timeoutMs, onTimeout, bounded });
    const controller = bounded === true ? new AbortController() : undefined;
    const timer = bounded === true ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    try {
      const request = controller === undefined
        ? { ...question, agent }
        : { ...question, agent, signal: controller.signal };
      const answer = await seam.ask(request);
      writeAnswerTrace({ step: 'ask-answered', timeoutMs });
      return { outcome: 'answered', answer };
    } catch (error) {
      if (controller !== undefined && controller.signal.aborted === true) {
        writeAnswerTrace({ pending: 'deadline', onTimeout, timeoutMs });
        return { outcome: onTimeout === 'allow' ? 'timed-out-allow' : 'timed-out-deny' };
      }
      // NOT a timeout: the seam refused the request. Losing the code here is what once made a failure read as
      // 「没有许可（error）」 with nothing to act on.
      writeAnswerTrace({
        step: 'ask-failed',
        message: String(error?.message ?? error),
        code: error?.code ?? null,
        name: error?.name ?? null,
        stack: typeof error?.stack === 'string' ? error.stack.split('\n').slice(0, 4).join(' | ') : null,
        onTimeout,
        timeoutMs,
      });
      return { outcome: 'error', error: String(error?.message ?? error), code: error?.code ?? null };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  // askTimed is the FALLBACK, for a Host that offers only it. It renders the narrower card, which is still better than
  // no confirmation at all.
  if (onTimeout === 'never') {
    return {
      outcome: 'unavailable',
      error: 'this Host offers only askTimed, which requires a bound, so onTimeout "never" cannot be honoured',
    };
  }
  writeAnswerTrace({ step: 'before-askTimed', timeoutMs });
  const pending = seam.askTimed(
    { ...question, agent },
    `a2a-confirm-${Date.now()}`,
    timeoutMs,
  );
  let timer;
  const expiry = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __deadline: true }), timeoutMs);
  });
  let result;
  try {
    result = await Promise.race([pending, expiry]);
  } finally {
    clearTimeout(timer);
  }
  if (result !== null && typeof result === 'object' && result.__deadline === true) {
    writeAnswerTrace({ pending: 'deadline', seam: 'askTimed', onTimeout, timeoutMs });
    return { outcome: onTimeout === 'allow' ? 'timed-out-allow' : 'timed-out-deny' };
  }
  writeAnswerTrace({ pending: 'returned', seam: 'askTimed', result: JSON.stringify(result ?? null).slice(0, 400) });
  if (result !== null && typeof result === 'object' && result.pending === true) {
    return { outcome: onTimeout === 'allow' ? 'timed-out-allow' : 'timed-out-deny' };
  }
  return { outcome: 'answered', answer: result };
}

/**
 * What to post to the group when the person declines or defers.
 *
 * WHY THE SESSION TELLS THE SENDER AT ALL
 *
 * Silence is the one outcome a colleague cannot interpret. 「没回」 reads as ignored, as slow, or as broken, and none of
 * those is what the person chose. A one-line notice turns an ambiguous absence into a stated position — the difference
 * between a colleague who waits and one who escalates or gives up.
 *
 * The wording is about the PERSON, not the agent: 「王五」, never 「系统拒绝」. The post appears under the Session's own
 * name in the group, and a colleague reading it should understand a human decision rather than a policy.
 *
 * Both messages are also careful NOT to close the door: 「稍后处理」 says explicitly that it is not a refusal, because
 * the two are different promises and a sender who reads defer as reject stops waiting.
 *
 * @param {object} input - `{ kind, draft, sender }`.
 * @returns {string|null} the text to post, or null when nothing should be sent.
 */
export function noticeFor({ kind, draft, sender }) {
  const who = typeof sender === 'string' && sender.trim() !== '' ? `@${sender.trim()} ` : '';
  const trimmed = typeof draft === 'string' ? draft.trim() : '';
  const about = trimmed === ''
    ? '关于你刚才那条消息'
    : `关于你那条消息（我原本准备这样回：「${trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed}」）`;
  if (kind === 'defer') {
    return `${who}${about}，我这会儿不方便处理，晚点再看。这不是拒绝，只是会慢一些。`;
  }
  if (kind === 'refuse') {
    return `${who}${about}，这次我不打算回复。如果需要我处理，请直接说明要我做什么。`;
  }
  return null;
}

export function decideFromAnswer(result) {
  const outcome = result?.outcome;
  if (outcome === 'timed-out-allow') return { proceed: true, reason: 'timeout-allow' };
  if (outcome === 'timed-out-deny') return { proceed: false, reason: 'timeout-deny', notify: 'defer' };
  if (outcome !== 'answered') {
    // `unavailable`, `error`, and an unanswered `never` all mean the human did not say yes. Treating any of them as
    // approval would make the check meaningless exactly when it matters.
    return { proceed: false, reason: outcome ?? 'unknown', notify: 'none' };
  }
  const raw = result?.answer;
  // Accept the documented shape, plus the two shapes a caller may reasonably hand in (a bare array, or one item).
  const list = Array.isArray(raw?.answers)
    ? raw.answers
    : (Array.isArray(raw) ? raw : (raw === undefined || raw === null ? [] : [raw]));
  // Every label the human picked, so three options can be told apart.
  const chosen = [];
  for (const item of list) {
    const selected = Array.isArray(item?.selected)
      ? item.selected
      : (Array.isArray(item?.labels) ? item.labels : []);
    for (const label of selected) chosen.push(String(label ?? ''));
    // A free-text answer counts as itself, and is matched below by the same rules.
    const custom = String(item?.custom ?? '');
    if (custom !== '') chosen.push(custom);
  }
  const said = chosen.join(' ');
  // ORDER MATTERS. 「稍后处理」 contains neither 允许 nor 拒绝, but a custom answer like 「稍后再说」 must not be read as a
  // rejection just because it also fails to match 拒绝. Defer is checked before the deny fallback for that reason.
  if (said.indexOf('稍后') > -1 || said.indexOf('延迟') > -1 || said.indexOf('晚点') > -1) {
    return { proceed: false, reason: 'deferred', notify: 'defer' };
  }
  if (said.indexOf('允许') > -1 || said.toLowerCase().indexOf('allow') > -1) {
    return { proceed: true, reason: 'approved' };
  }
  if (said.indexOf('拒绝') > -1 || said.toLowerCase().indexOf('deny') > -1) {
    return { proceed: false, reason: 'denied', notify: 'refuse' };
  }
  // An answer that matched nothing is still a "no": the person closed the card without approving. Reported as its own
  // reason so the sender is not told a definite refusal that never happened.
  return { proceed: false, reason: 'denied', notify: 'refuse' };
}
