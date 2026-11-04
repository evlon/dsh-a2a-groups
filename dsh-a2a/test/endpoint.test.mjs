/**
 * Tests for composing this instance's own A2A address.
 *
 * The property that matters is not "does it join two strings" but "when does it refuse". A wrong
 * endpoint is worse than none: a caller that dials it waits for a timeout and concludes the whole
 * feature is broken, while an absent one lets the caller say "no address, use the group".
 *
 * So most of these tests are about the cases where the answer must be `undefined`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { composeEndpoint, ownEndpointFromConfig } from '../lib/core/endpoint.js';

test('a gateway base and an agent name compose the documented shape', () => {
  // The same shape the invite link already carries as `gw` + `agent`, so this reuses a convention
  // rather than inventing one.
  assert.equal(
    composeEndpoint({ gatewayBase: 'http://gw:3000/a2a', agentName: 'zhangsan' }),
    'http://gw:3000/a2a/zhangsan',
  );
});

test('a trailing slash and a slash-free name do not produce a double slash', () => {
  // `//` is a different path to some gateways, and would fail as "colleague unreachable" long
  // after the join that caused it.
  assert.equal(
    composeEndpoint({ gatewayBase: 'http://gw:3000/a2a/', agentName: 'zhangsan' }),
    'http://gw:3000/a2a/zhangsan',
  );
  assert.equal(
    composeEndpoint({ gatewayBase: 'http://gw:3000/a2a///', agentName: 'zhangsan' }),
    'http://gw:3000/a2a/zhangsan',
  );
});

test('an unconfigured host gets undefined rather than half a URL', () => {
  assert.equal(composeEndpoint({ gatewayBase: '', agentName: 'zhangsan' }), undefined);
  assert.equal(composeEndpoint({ gatewayBase: 'http://gw/a2a', agentName: '' }), undefined);
  assert.equal(composeEndpoint({}), undefined);
  assert.equal(composeEndpoint(), undefined);
  assert.equal(composeEndpoint({ gatewayBase: '   ', agentName: '  ' }), undefined);
});

test('a name that cannot survive being a path segment is refused', () => {
  // Each of these would silently truncate, misroute, or change the request target. A refusal is
  // visible at join time; a mangled URL is not.
  for (const name of ['a/b', 'a?b', 'a b', 'a#b', '张三', '../x', '']) {
    assert.equal(
      composeEndpoint({ gatewayBase: 'http://gw/a2a', agentName: name }),
      undefined,
      `${JSON.stringify(name)} must be refused`,
    );
  }
});

test('dots and dashes are fine, because agent names really do contain them', () => {
  assert.equal(
    composeEndpoint({ gatewayBase: 'http://gw/a2a', agentName: 'zhang.san-01' }),
    'http://gw/a2a/zhang.san-01',
  );
  assert.equal(
    composeEndpoint({ gatewayBase: 'http://gw/a2a', agentName: 'a_b~c' }),
    'http://gw/a2a/a_b~c',
  );
});

test('surrounding whitespace in config does not leak into the address', () => {
  assert.equal(
    composeEndpoint({ gatewayBase: '  http://gw/a2a  ', agentName: '  zhangsan  ' }),
    'http://gw/a2a/zhangsan',
  );
});

test('ownEndpointFromConfig reads from config.groups', () => {
  assert.equal(
    ownEndpointFromConfig({ groups: { gatewayBase: 'http://gw/a2a', agentName: 'zhangsan' } }),
    'http://gw/a2a/zhangsan',
  );
});

test('a config without groups yields undefined instead of throwing', () => {
  // The plugin mounts with normalized config, but a direct `createGroupSkills` call in a test or a
  // standalone host may pass less. Crashing on a missing section would take the mount down.
  assert.equal(ownEndpointFromConfig({}), undefined);
  assert.equal(ownEndpointFromConfig(), undefined);
  assert.equal(ownEndpointFromConfig({ groups: {} }), undefined);
});
