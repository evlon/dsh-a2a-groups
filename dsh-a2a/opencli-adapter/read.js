// Read the visible conversation, so a test can assert on what a person would actually see.
//
// WHY TEXT RATHER THAN STATE
//
// The point of a UI test is to confirm the user's view, not the model's. Reading the rendered transcript catches the
// whole class of bugs where the data is right and the screen is not: the panel that received fresh data and never
// re-rendered, the field dropped by a mapper on its way to the DOM, the message delivered but shown nowhere.
//
// `--contains` exists so a test can ask the question it actually has — "did this text become visible?" — in one round
// trip. Asking in the command also makes the failure better: it can report what WAS visible.

import { cli, Strategy } from '@jackwener/opencli/registry';
import { ensureOnInstance, readTranscript, tokenFromLog, waitFor } from './_ops.js';

cli({
  site: 'dsh',
  name: 'read',
  description: 'Read the visible conversation text. With --contains, wait for that text and report whether it appeared.',
  access: 'read',
  domain: '127.0.0.1',
  strategy: Strategy.UI,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  args: [
    { name: 'contains', type: 'string', help: 'Wait for and report whether this text becomes visible' },
    { name: 'last', type: 'int', default: 0, help: 'Only show the last N entries (0 = all)' },
    { name: 'timeout', type: 'int', default: 30, help: 'Seconds to wait when --contains is given' },
    { name: 'port', type: 'int', help: 'Instance port; omit to use the page already open' },
    { name: 'home', type: 'string', help: 'DSH_HOME used to find the token when --port is given' },
    { name: 'token', type: 'string', help: 'Access token, when it is not in the log' },
  ],
  columns: ['index', 'text'],
  func: async (page, kwargs) => {
    if (kwargs.port !== undefined) {
      let token = typeof kwargs.token === 'string' ? kwargs.token : '';
      if (token === '' && typeof kwargs.home === 'string') token = tokenFromLog(kwargs.home) ?? '';
      await ensureOnInstance(page, { port: Number(kwargs.port), token, timeoutMs: 30000 });
    }

    const needle = typeof kwargs.contains === 'string' ? kwargs.contains.trim() : '';

    if (needle !== '') {
      const timeoutMs = Math.max(1, Number(kwargs.timeout ?? 30)) * 1000;
      const found = await waitFor(
        async () => (await readTranscript(page)).some((entry) => entry.includes(needle)),
        { timeoutMs, intervalMs: 300 },
      );
      const entries = await readTranscript(page);
      const matched = entries.filter((entry) => entry.includes(needle));
      if (matched.length === 0) {
        // Report absence honestly instead of returning an empty table, which reads like "no messages" rather than
        // "the text never appeared".
        return [{ index: -1, text: found ? needle : `(not visible within ${kwargs.timeout}s) ${needle}` }];
      }
      return matched.map((text, index) => ({ index: index + 1, text: text.slice(0, 400) }));
    }

    const entries = await readTranscript(page);
    const last = Number(kwargs.last ?? 0);
    const selected = last > 0 ? entries.slice(-last) : entries;
    if (selected.length === 0) {
      return [{ index: 0, text: '(no visible message text — is a conversation open?)' }];
    }
    return selected.map((text, index) => ({ index: index + 1, text: text.slice(0, 400) }));
  },
});
