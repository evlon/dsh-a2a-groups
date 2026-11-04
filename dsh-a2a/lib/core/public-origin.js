/**
 * Decide which public address to put in a link the host hands out.
 *
 * THE PROBLEM
 *
 * The host listens on `http://127.0.0.1:3095`. The colleague reaches it at `https://gw.company.com/a2a-host`.
 * A link built from what the host knows is unusable for the person who receives it, and a link built from the raw
 * `Host` header is wrong whenever a proxy rewrote it.
 *
 * So the address has four possible sources, and they are tried in this order:
 *
 *   1. an explicitly configured value — the only source that is authoritative, because an operator typed it
 *   2. `X-Forwarded-Proto` + `X-Forwarded-Host` — what a proxy says it served
 *   3. `Forwarded` (RFC 7239) — the same facts in the standard form
 *   4. the `Host` header — correct when nothing rewrote anything
 *
 * WHY THE ORDER MATTERS, AND WHY CONFIG WINS
 *
 * A proxy may add a forwarded header AND leave Host intact (or rewrite both). Guessing wrong produces a link that
 * fails on somebody else's machine, which is the worst kind of failure: the sender sees a URL, the receiver sees an
 * error, and neither has a way to know what the sender's URL should have said. An explicit setting removes the
 * guess, so it is checked first and never overridden.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * No attempt to reach out and discover the address. That would mean network calls during a page render, and the
 * answer would be the address the HOST sees — the same wrong answer as before, arrived at more slowly.
 */

/** Headers a proxy uses to describe what it actually served. */
const FORWARDED_HOST = ['x-forwarded-host', 'x-original-host'];
const FORWARDED_PROTO = ['x-forwarded-proto', 'x-forwarded-protocol'];

/**
 * Read one header from a request, tolerating both the node:http shape and the WHATWG shape.
 *
 * @param {object} req - request.
 * @param {string} name - lowercase header name.
 * @returns {string} the first value, or `''`.
 */
function header(req, name) {
  const raw = req?.headers?.[name];
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0];
  // WHATWG `Headers` (used by the injected registrar in some hosts).
  const getter = req?.headers?.get;
  if (typeof getter === 'function') {
    const value = getter.call(req.headers, name);
    return typeof value === 'string' ? value : '';
  }
  return '';
}

/**
 * Parse the first element of a `Forwarded` header.
 *
 * @param {string} value - the header value.
 * @returns {{ host: string, proto: string }} what it declares, blank when absent.
 */
function parseForwarded(value) {
  if (typeof value !== 'string' || value === '') return { host: '', proto: '' };
  const first = value.split(',')[0] ?? '';
  const out = { host: '', proto: '' };
  for (const part of first.split(';')) {
    const [rawKey, rawValue] = part.split('=');
    const key = (rawKey ?? '').trim().toLowerCase();
    const val = (rawValue ?? '').trim().replace(/^"|"$/gu, '');
    if (key === 'host' && val !== '') out.host = val;
    if (key === 'proto' && val !== '') out.proto = val;
  }
  return out;
}

/**
 * Work out the origin a link should use.
 *
 * @param {object} input - inputs.
 * @param {object} [input.req] - the request being answered.
 * @param {string} [input.configured] - `server.publicUrl`, authoritative when set.
 * @param {() => string|undefined} [input.origin] - the listen address, as a last resort.
 * @returns {string} an origin like `https://gw.company.com`, or `''` when nothing usable was found.
 */
export function resolvePublicOrigin({ req, configured, origin } = {}) {
  // 1. An operator typed it. Nothing may override a deliberate setting.
  const given = typeof configured === 'string' ? configured.trim().replace(/\/+$/u, '') : '';
  if (given !== '') {
    // An operator may write the full endpoint rather than a bare origin; keep only scheme+host so callers can
    // append their own path without producing `/a2a/../join`.
    try {
      const parsed = new URL(given);
      return `${parsed.protocol}//${parsed.host}`;
    } catch {
      // Not a URL — treat it as an origin and let the caller see it rather than silently dropping the setting.
      return given;
    }
  }

  // 2. What a proxy says it served.
  const protoHint = FORWARDED_PROTO.map((name) => header(req, name)).find((value) => value !== '') ?? '';
  const hostHint = FORWARDED_HOST.map((name) => header(req, name)).find((value) => value !== '') ?? '';

  // 3. The RFC 7239 form, when the proxy used it instead.
  const forwarded = parseForwarded(header(req, 'forwarded'));

  const proto = (protoHint || forwarded.proto || '').trim().toLowerCase();
  const host = (hostHint || forwarded.host || header(req, 'host')).trim();

  if (host !== '') {
    // Only `http` and `https` are meaningful here: a link is opened by a browser, and anything else would be a
    // header we should not trust into a URL.
    const scheme = proto === 'https' || proto === 'http' ? proto : 'http';
    return `${scheme}://${host.replace(/\/+$/u, '')}`;
  }

  // 4. Whatever the listener thinks it is. Usually loopback, so this is the weakest answer — but it beats an
  // empty string, and a same-machine test still works.
  if (typeof origin === 'function') {
    try {
      const value = origin();
      if (typeof value === 'string' && value.trim() !== '') return value.trim().replace(/\/+$/u, '');
    } catch {
      // A listener that has not bound yet cannot answer; fall through to empty.
    }
  }
  return '';
}

/**
 * Build a link to the join page.
 *
 * @param {object} input - inputs.
 * @param {string} input.token - the one-time token.
 * @param {string} origin - from {@link resolvePublicOrigin}.
 * @param {string} path - the join route path.
 * @returns {string} an absolute URL when an origin is known, otherwise the path alone.
 */
export function buildJoinUrl({ token, origin, path }) {
  const query = `?t=${encodeURIComponent(token)}`;
  if (typeof origin !== 'string' || origin === '') {
    // A relative URL still works when the reader is already on the host. Better than no link: the failure is
    // visible (a path with no domain) rather than silent.
    return `${path}${query}`;
  }
  return `${origin.replace(/\/+$/u, '')}${path}${query}`;
}
