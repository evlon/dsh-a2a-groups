// Open a DSH Web instance by port, resolving its access token from the instance's own log.
//
// `siteSession: 'persistent'` is what makes this useful: without it every adapter command is a fresh process starting
// on `about:blank`, so an `open` followed by a `send` would type into a blank page. With it, the page opened here is
// the page the next command sees.

import { cli, Strategy } from '@jackwener/opencli/registry';
import { ensureOnInstance, fail, tokenFromLog } from './_ops.js';

cli({
  site: 'dsh',
  name: 'open',
  description: 'Open a DSH Web instance by port, resolving its access token from the instance home.',
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
  ],
  columns: ['url', 'ready'],
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

    return [{ url: result.url, ready: true }];
  },
});
