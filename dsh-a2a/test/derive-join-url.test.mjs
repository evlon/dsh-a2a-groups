/**
 * Tests for deriving a join URL from the browser's own address.
 *
 * WHY THIS LOGIC EXISTS
 *
 * The host sits behind a gateway that may mount it at a path prefix and strip the prefix before forwarding. The
 * process therefore sees only `/join` and cannot reconstruct `/agent-groups/join` — the information was removed
 * before the request arrived. The browser knows, because `location.pathname` is what the user actually opened.
 *
 * So the page computes the link and the backend stops guessing. These tests pin the arithmetic, including the
 * cases a naive implementation gets wrong: a trailing slash, a deeper prefix, and a path segment that merely
 * looks like the route.
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';

import { deriveJoinUrl } from '../lib/core/derive-join-url.js';

test('served at the root, the link stays at the root', () => {
  assert.equal(
    deriveJoinUrl({ origin: 'http://127.0.0.1:3095', pathname: '/join', token: 'tok' }),
    'http://127.0.0.1:3095/join?t=tok',
  );
});

test('a gateway prefix is preserved', () => {
  // The case this exists for: the host only ever sees /join, but the browser was at /agent-groups/join.
  assert.equal(
    deriveJoinUrl({ origin: 'https://gw.company.com', pathname: '/agent-groups/join', token: 'tok' }),
    'https://gw.company.com/agent-groups/join?t=tok',
  );
});

test('a deeper prefix works without special cases', () => {
  assert.equal(
    deriveJoinUrl({ origin: 'https://gw.company.com', pathname: '/a/b/c/join', token: 'tok' }),
    'https://gw.company.com/a/b/c/join?t=tok',
  );
});

test('a trailing slash does not produce a double slash', () => {
  // Browsers disagree about the trailing slash, and `//join` is a different path than `/join`.
  assert.equal(
    deriveJoinUrl({ origin: 'https://gw.company.com', pathname: '/agent-groups/join/', token: 'tok' }),
    'https://gw.company.com/agent-groups/join?t=tok',
  );
});

test('a path segment that only looks like the route is left alone', () => {
  // `/join/join` must lose exactly one trailing `/join`, not both.
  assert.equal(
    deriveJoinUrl({ origin: 'https://gw.company.com', pathname: '/join/join', token: 'tok' }),
    'https://gw.company.com/join/join?t=tok',
  );
});

test('an unrelated pathname is not mangled', () => {
  // If the page is ever served under a different route, the prefix computation must not eat a random suffix.
  assert.equal(
    deriveJoinUrl({ origin: 'https://gw.company.com', pathname: '/somewhere/else', token: 'tok' }),
    'https://gw.company.com/somewhere/else/join?t=tok',
  );
});

test('the token is encoded, not concatenated raw', () => {
  assert.equal(
    deriveJoinUrl({ origin: 'https://gw.company.com', pathname: '/join', token: 'a b&c' }),
    'https://gw.company.com/join?t=a%20b%26c',
  );
});

test('a custom route is honoured', () => {
  // The route is a parameter rather than a constant so a future rename does not silently break the derivation.
  assert.equal(
    deriveJoinUrl({ origin: 'https://gw.company.com', pathname: '/x/enter', token: 't', route: '/enter' }),
    'https://gw.company.com/x/enter?t=t',
  );
});

test('a missing token yields an empty query rather than the word undefined', () => {
  // `?t=undefined` would look like a token to a reader and fail confusingly at the host.
  assert.ok(!deriveJoinUrl({ origin: 'https://gw.company.com', pathname: '/join' }).includes('undefined'));
});
