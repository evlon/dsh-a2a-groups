// Type into the DSH Web composer and send, then wait for the turn to finish.
//
// This is what a UI test needs most: drive the interface the way a person does — focus the box, type, press Enter — and
// then wait for the assistant to stop producing output, so the next assertion reads a settled page.
//
// `--port` is optional. When omitted the command uses whatever instance the page is already on, which is the normal
// case inside a test that already ran `dsh open`.

import { cli, Strategy } from '@jackwener/opencli/registry';
import {
  composerIsEmpty,
  ensureOnInstance,
  fail,
  isBusy,
  newSession,
  pressSend,
  readTranscript,
  selectSession,
  sessionInfo,
  tokenFromLog,
  waitFor,
  writeComposer,
} from './_ops.js';

cli({
  site: 'dsh',
  name: 'send',
  description: 'Type a message into the DSH Web composer and send it, then wait for the turn to finish.',
  access: 'write',
  domain: '127.0.0.1',
  strategy: Strategy.UI,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  args: [
    { name: 'text', type: 'string', help: 'Message to send', required: true },
    { name: 'port', type: 'int', help: 'Instance port; omit to use the page the previous command left open' },
    { name: 'home', type: 'string', help: 'DSH_HOME used to find the token when --port is given' },
    { name: 'token', type: 'string', help: 'Access token, when it is not in the log' },
    { name: 'timeout', type: 'int', default: 120, help: 'Seconds to wait for the turn to finish' },
    { name: 'no-wait', type: 'boolean', default: false, help: 'Return as soon as the message is sent' },
    { name: 'session', type: 'string', help: 'Conversation title to send into (omit to use the open one)' },
    { name: 'new-session', type: 'boolean', default: false, help: 'Start a fresh conversation and send into it' },
  ],
  columns: ['sent', 'via', 'typed', 'replied', 'settled', 'conversation'],
  func: async (page, kwargs) => {
    const text = String(kwargs.text ?? '');
    if (text.trim() === '') fail('Nothing to send: --text is empty.', 'Pass the message with --text "..."');

    // Optional navigation: a test may call `send` directly without a preceding `open`.
    if (kwargs.port !== undefined) {
      let token = typeof kwargs.token === 'string' ? kwargs.token : '';
      if (token === '' && typeof kwargs.home === 'string') token = tokenFromLog(kwargs.home) ?? '';
      await ensureOnInstance(page, { port: Number(kwargs.port), token, timeoutMs: 30000 });
    }

    // Send into a NAMED conversation, not "whatever is open".
    //
    // Measured failure: without this the message landed in an old conversation that a restart had left in a stopped
    // state; the reply never came, and the earlier `replied: false` read like a model refusal. Naming the conversation
    // makes the command's target observable instead of inherited.
    if (kwargs['new-session'] === true) {
      const created = await newSession(page);
      if (created.ok !== true) fail('Could not start a new conversation.', `Visible: ${(created.after?.titles ?? []).join(' | ') || '(none)'}`);
    } else if (typeof kwargs.session === 'string' && kwargs.session.trim() !== '') {
      const picked = await selectSession(page, kwargs.session);
      if (picked.ok !== true) fail(`No conversation titled "${kwargs.session}".`, `Visible: ${picked.titles.join(' | ') || '(none)'}`);
    }
    const conversation = (await sessionInfo(page)).active;

    const before = await readTranscript(page);

    const written = await writeComposer(page, text);
    if (written === null || written === undefined || written.ok !== true) {
      fail(
        'Could not find the message composer.',
        'Open a conversation in the DSH Web UI first, or pass --port so this command can navigate to one.',
      );
    }
    // The DOM decides what was typed. A framework that rejected the input leaves the box empty, and sending nothing
    // would look like a call that worked and produced no reply.
    if (String(written.actual ?? '').trim() === '') {
      fail('The composer stayed empty after typing.', 'The UI ignored the synthetic input; try a foregrounded window.');
    }

    const pressed = await pressSend(page);
    if (pressed === null || pressed === undefined || pressed.ok !== true) {
      fail('Could not send: neither Enter nor the send button submitted.', 'Check the composer has focus.');
    }

    if (kwargs['no-wait'] === true) {
      return [{ sent: true, via: pressed.via, typed: written.actual, replied: false, settled: false }];
    }

    // Wait for the assistant's reply to APPEAR, rather than for a "busy" flag to clear.
    //
    // The busy indicator is unreliable here: `settled` came back false on a message that had already been delivered and
    // answered, because the stop control appears only while tokens stream and a slow model start looks idle. Waiting on
    // the transcript is direct evidence — the reply is either on screen or it is not.
    const timeoutMs = Math.max(1, Number(kwargs.timeout ?? 120)) * 1000;
    const baseline = before.length;
    const replied = await waitFor(
      async () => (await readTranscript(page)).length > baseline,
      { timeoutMs, intervalMs: 500 },
    );

    // Then let it settle, so a test that reads next sees a finished answer rather than a half-streamed one. Bounded and
    // best-effort: a turn that keeps streaming past the budget still returns, with `settled: false`.
    let settled = false;
    if (replied) {
      settled = await waitFor(async () => !(await isBusy(page)), { timeoutMs: 30000, intervalMs: 500 });
    }

    const after = await readTranscript(page);

    return [{
      sent: true,
      via: pressed.via,
      typed: written.actual,
      replied: replied === true,
      settled: settled === true,
      conversation: conversation === '' ? '(unknown)' : conversation,
      grew: after.length - before.length,
      // Diagnostic: what the composer actually holds NOW.
      //
      // It should be empty — a send consumes the text. A non-empty value here means the key sequence never reached the
      // box (the page may be a different one than the caller expects), and that is the difference between "the model
      // did not answer" and "nothing was ever sent".
      composerAfter: await composerIsEmpty(page) ? '(empty)' : 'STILL-HAS-TEXT',
    }];
  },
});
