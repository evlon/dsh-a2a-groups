/**
 * Tests for the public-origin resolution.
 *
 * THE PROBLEM THIS PREVENTS
 *
 * The host listens on `http://127.0.0.1:3095` and is reached at `https://gw.company.com`. A join link built from
 * the listen address is unusable for the person who receives it, and one built from an untouched `Host` header is
 * wrong whenever a proxy rewrote it.
 *
 * This failure is nastier than "the link 404s": the SENDER sees a normal-looking URL and the RECEIVER sees an
 * error, so neither can tell whose side is broken. Each source of truth therefore gets its own test, and the
 * precedence between them is pinned.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildJoinUrl, resolvePublicOrigin } from '../lib/core/public-origin.js';

/** A request whose only interesting part is its headers. */
const req = (headers) => ({ headers });

test('a configured origin wins over everything', () => {
  const origin = resolvePublicOrigin({
    configured: 'https://gw.company.com/a2a-host',
    req: req({ 'x-forwarded-proto': 'http', 'x-forwarded-host': 'other.example', host: '127.0.0.1:3095' }),
  });

  // Configuration is the only authoritative source: an operator typed it after finding out what the proxy does.
  // The path is dropped so a caller appending `/join` cannot produce `/a2a-host/join` when it wanted `/join`.
  assert.equal(origin, 'https://gw.company.com');
});

test('X-Forwarded-Proto and X-Forwarded-Host are used when nothing is configured', () => {
  assert.equal(
    resolvePublicOrigin({ req: req({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'gw.company.com' }) }),
    'https://gw.company.com',
  );
});

test('the RFC 7239 Forwarded header is understood too', () => {
  assert.equal(
    resolvePublicOrigin({ req: req({ forwarded: 'for=10.0.0.1;proto=https;host=gw.company.com' }) }),
    'https://gw.company.com',
  );
});

test('an untouched Host header still produces a usable origin', () => {
  // Direct bind, no proxy: what the client asked for is what it can reach.
  assert.equal(resolvePublicOrigin({ req: req({ host: '192.168.1.5:3095' }) }), 'http://192.168.1.5:3095');
});

test('a missing protocol defaults to http rather than guessing https', () => {
  // Guessing https would produce a link that fails to connect on an internal plain-http host; guessing http at
  // worst produces a redirect. The safer default is the one whose failure is visible.
  assert.equal(resolvePublicOrigin({ req: req({ host: 'example.local' }) }), 'http://example.local');
});

test('an unknown forwarded protocol is not trusted into a URL', () => {
  assert.equal(
    resolvePublicOrigin({ req: req({ 'x-forwarded-proto': 'ftp', 'x-forwarded-host': 'gw.company.com' }) }),
    'http://gw.company.com',
  );
});

test('the listener address is the last resort', () => {
  assert.equal(resolvePublicOrigin({ origin: () => 'http://127.0.0.1:3095' }), 'http://127.0.0.1:3095');
});

test('nothing known returns an empty string, not a guess', () => {
  // An empty origin makes the caller emit a relative URL, which is visibly a path. A guessed domain would be
  // invisibly wrong.
  assert.equal(resolvePublicOrigin({}), '');
});

test('a trailing slash never survives', () => {
  assert.equal(resolvePublicOrigin({ configured: 'https://gw.company.com/' }), 'https://gw.company.com');
  assert.equal(
    resolvePublicOrigin({ req: req({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'gw.company.com/' }) }),
    'https://gw.company.com',
  );
});

test('array-valued headers are read, not stringified', () => {
  // Node gives repeated headers as an array; `String(array)` would yield "https,https".
  assert.equal(
    resolvePublicOrigin({
      req: req({ 'x-forwarded-proto': ['https'], 'x-forwarded-host': ['gw.company.com'] }),
    }),
    'https://gw.company.com',
  );
});

test('the join URL is absolute when an origin is known', () => {
  assert.equal(
    buildJoinUrl({ token: 'abc123', origin: 'https://gw.company.com', path: '/join' }),
    'https://gw.company.com/join?t=abc123',
  );
});

test('the join URL falls back to a path when no origin is known', () => {
  // Deliberately not an empty string: a bare path is visibly incomplete, and it still works when the reader is
  // already on the host. An empty link would look like a broken feature with no clue.
  assert.equal(buildJoinUrl({ token: 'abc123', origin: '', path: '/join' }), '/join?t=abc123');
});

test('a token is encoded into the query string', () => {
  assert.equal(
    buildJoinUrl({ token: 'a b&c', origin: 'https://gw.company.com', path: '/join' }),
    'https://gw.company.com/join?t=a%20b%26c',
  );
});
