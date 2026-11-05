// Open a DSH Web instance by port, resolving its access token from the instance's own log.
//
// `siteSession: 'persistent'` is what makes this useful: without it every adapter command is a fresh process starting
// on `about:blank`, so an `open` followed by a `send` would type into a blank page. With it, the page opened here is
// the page the next command sees.

import { cli, Strategy } from '@jackwener/opencli/registry';
import { ensureOnInstance, evaluate, fail, newSession, selectSession, sessionInfo, tokenFromLog } from './_ops.js';

cli({
  site: 'dsh',
  name: 'open',
  description: 'Open a DSH Web instance by port, optionally opening a specific or brand-new conversation.',
  access: 'read',
  domain: '127.0.0.1',
  strategy: Strategy.UI,
  browser: true,
  siteSession: 'persistent',
  navigateBefore: false,
  args: [
    { name: 'port', type: 'int', help: 'Instance port, e.g. 3096', required: true },
    { name: 'home', type: 'string', help: 'DSH_HOME of that instance (used to find the token)' },
    { name: 'token', type: 'string', help: 'Access token, when it is not in the log' },
    { name: 'ready', type: 'int', default: 30, help: 'Seconds to wait for the UI to render' },
    { name: 'path', type: 'string', help: 'Path to append, e.g. /join' },
    { name: 'session', type: 'string', help: 'Conversation title to open after loading' },
    { name: 'new-session', type: 'boolean', default: false, help: 'Start a brand-new conversation' },
  ],
  columns: ['url', 'ready', 'conversation', 'diag'],
  func: async (page, kwargs) => {
    const port = Number(kwargs.port);
    if (!Number.isFinite(port) || port <= 0) fail('--port must be a positive integer.');

    let token = typeof kwargs.token === 'string' ? kwargs.token : '';
    if (token === '' && typeof kwargs.home === 'string') token = tokenFromLog(kwargs.home) ?? '';
    if (token === '') {
      fail(
        'No access token.',
        'Pass --token, or --home pointing at the instance directory so the token can be read from its out.log.',
      );
    }

    const result = await ensureOnInstance(page, {
      port,
      token,
      path: typeof kwargs.path === 'string' ? kwargs.path : '',
      timeoutMs: Math.max(1, Number(kwargs.ready ?? 30)) * 1000,
    });

    // Choosing the conversation is part of opening it.
    //
    // Without this the command leaves whatever conversation the SPA last had open, which after a restart can be one that
    // is stuck in a stopped state. A message sent there goes nowhere and looks like a model that refused to answer.
    let conversation = '';
    if (kwargs['new-session'] === true) {
      const created = await newSession(page);
      if (created.ok !== true) {
        fail(
          'Could not start a new conversation.',
          `Visible: ${(created.after?.titles ?? []).join(' | ') || '(none)'}`
            + ` | control: ${JSON.stringify(created.clicked ?? created.seen ?? created.reason ?? null)}`,
        );
      }
      conversation = (await sessionInfo(page)).active;
    } else if (typeof kwargs.session === 'string' && kwargs.session.trim() !== '') {
      const picked = await selectSession(page, kwargs.session);
      if (picked.ok !== true) {
        fail(
          `No conversation titled "${kwargs.session}".`,
          `Visible conversations: ${picked.titles.join(' | ') || '(none)'}`,
        );
      }
      conversation = picked.active;
    } else {
      conversation = (await sessionInfo(page)).active;
    }

    const info = await sessionInfo(page);
    // Diagnostic: what the page actually shows. Without it a short `titles` list is indistinguishable from a collapsed
    // sidebar, a narrow viewport, or a selector that no longer matches.
    const probe = await evaluate(page, `(function () {
      var rows = document.querySelectorAll('div[class*="_sessionRow"]');
      var sidebar = document.querySelector('div[class*="_sidebarCol"]');
      // Which elements actually carry 「新会话」, and are they clickable? A label living in a <span> inside a
      // non-button wrapper explains "the text is on the page but no control matches".
      var carriers = [];
      var all = Array.from(document.querySelectorAll('*'));
      for (var i = 0; i < all.length && carriers.length < 5; i += 1) {
        var node = all[i];
        if ((node.textContent || '').trim().indexOf('新会话') !== 0) continue;
        if (node.children.length > 2) continue;
        carriers.push(node.tagName + '.' + String(node.className).slice(0, 22));
      }
      return {
        viewport: String(window.innerWidth) + 'x' + String(window.innerHeight),
        rowCount: rows.length,
        hasSidebar: sidebar !== null,
        sidebarVisible: sidebar !== null && sidebar.offsetParent !== null,
        bodyLen: ((document.body && document.body.innerText) || '').length,
        buttons: document.querySelectorAll('button').length,
        carriers: carriers.join(' ; '),
      };
    })()`);
    return [{
      url: result.url,
      ready: true,
      conversation: conversation === '' ? '(unknown)' : conversation,
      titles: info.titles.join(' | '),
      diag: JSON.stringify(probe ?? {}),
    }];
  },
});
