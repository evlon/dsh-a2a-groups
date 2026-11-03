// Render the panel's snapshot path against the data the Host actually injected
// into a live DSH instance. This closes the last gap between "the Host publishes
// groups" and "the panel can show them" without needing a browser.
//
//   node scripts/verify-panel.mjs [url] [token]
//
// With a url+token it reads the REAL index.html, extracts the real
// `__DSH_A2A_GROUPS__` value the Host rendered, and feeds it to the bundle's own
// normalizer. Without one it runs the same path against a fixture, so the check
// still works offline.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = join(here, '..', 'client.js');
const source = readFileSync(bundlePath, 'utf8');

/** The window the bundle expects, recording what it registers. */
const registration = { def: undefined };
const windowObject = {
  __ModuleLoader__: { load: (definition) => { registration.def = definition; } },
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
};

const sandbox = {
  window: windowObject,
  document: { createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }) },
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  URL,
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox);

if (registration.def === undefined) {
  console.error('FAIL  the bundle did not register itself with __ModuleLoader__');
  process.exit(1);
}
console.log(`PASS  bundle registered as ${JSON.stringify(registration.def.id)}`);

/** Minimal React: enough for the components this bundle exports. */
const react = {
  Fragment: 'Fragment',
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn,
  useRef: () => ({ current: null }),
  memo: (component) => component,
};
const sharedRequire = (name) => {
  if (name === 'react') return react;
  if (name === 'react/jsx-runtime') {
    return {
      jsx: (type, props) => react.createElement(type, props),
      jsxs: (type, props) => react.createElement(type, props),
    };
  }
  // Everything else is an optional shared module; the bundle feature-detects it.
  return {};
};

const api = registration.def.factory(sharedRequire);

// --- obtain the data -------------------------------------------------------
let snapshot;
let sourceLabel;
const [, , url, token] = process.argv;
if (url !== undefined) {
  // A token URL answers 303 and sets the session cookie; the index is only
  // readable with that cookie, so it has to be carried across the redirect by
  // hand (Node's fetch does not manage a cookie jar).
  let cookie = '';
  const base = token === undefined ? url : `${url}${url.includes('?') ? '&' : '?'}token=${token}`;
  let response = await fetch(base, { redirect: 'manual', headers: cookie === '' ? {} : { cookie } });
  const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  if (setCookies.length > 0) cookie = setCookies.map((entry) => entry.split(';')[0]).join('; ');
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location') ?? '/';
    response = await fetch(new URL(location, base).toString(), { headers: { cookie } });
  }
  const html = await response.text();
  if (!response.ok) {
    console.error(`FAIL  the index answered ${response.status}; pass a fresh --token from \`dsh web\``);
    process.exit(1);
  }
  // The Host renders the row as `globalThis["__DSH_A2A_GROUPS__"] = {…}` inside a
  // script element. Match on the name alone, then take the object up to the
  // closing tag: pinning the exact spelling of the assignment would break on a
  // renderer change that is not a change in meaning.
  const match = /__DSH_A2A_GROUPS__"[^\n]*?=\s*(\{.*?\})<\/script>/s.exec(html);
  if (match === null) {
    console.error('FAIL  the Host rendered no __DSH_A2A_GROUPS__ value into index.html');
    process.exit(1);
  }
  snapshot = JSON.parse(match[1]);
  sourceLabel = `live index.html (${snapshot.groups.length} group(s) as rendered by the Host)`;
} else {
  snapshot = {
    updatedAt: 1793711580228,
    unreadTotal: 0,
    groups: [{
      id: 'g-fixture', groupId: 'g-fixture', name: 'gateway proof', topic: 'proving the chain',
      role: 'owner', memberCount: 1, unreadCount: 0, lastSeq: 1, lastTime: 1793711481738,
      members: [], feed: [],
    }],
  };
  sourceLabel = 'fixture (no url given)';
}

// --- drive the bundle's own normalizer ------------------------------------
windowObject.__DSH_A2A_GROUPS__ = snapshot;
const normalized = api.currentSnapshot();
console.log(`PASS  normalized ${sourceLabel}`);
console.log(`      groups=${normalized.groups.length} ok=${normalized.ok} unreadTotal=${normalized.unreadTotal}`);
for (const group of normalized.groups) {
  // `role` is a MEMBER field, not a group one: the ledger records what this
  // instance is to each group, and the panel renders it on the member chip. A
  // group shows its name, member count, and unread badge.
  console.log(`      · ${group.name} (${group.id}) members=${group.memberCount} unread=${group.unreadCount}`);
}

const failures = [];
if (normalized.groups.length !== snapshot.groups.length) {
  failures.push(`expected ${snapshot.groups.length} groups, normalized ${normalized.groups.length}`);
}
if (snapshot.groups.length > 0 && normalized.groups[0].name !== snapshot.groups[0].name) {
  failures.push(`name was mangled: ${normalized.groups[0].name} !== ${snapshot.groups[0].name}`);
}
const empty = api.readSnapshot(undefined);
if (empty.groups.length !== 0) failures.push('a missing snapshot must normalize to zero groups');

console.log('');
if (failures.length === 0) {
  console.log('panel: OK');
  // No `process.exit(0)`: on Windows the global fetch keeps a handle open and an
  // explicit exit trips a libuv assertion in the middle of closing it, which
  // turns a passing check into a non-zero exit code. Letting the process drain
  // its own handles exits cleanly with the same status.
} else {
  for (const failure of failures) console.error(`FAIL  ${failure}`);
  process.exitCode = 1;
}
