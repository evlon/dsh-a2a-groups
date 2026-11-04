// The link-derivation logic, as a testable function.
//
// It lives here as well as inline in the page because the page's copy cannot be unit-tested: it is a template
// string, and asserting on it would only prove the characters are present, not that the arithmetic is right. The
// two must agree — the tests below encode the rules, and the page's inline script is the same three lines.
//
// WHY THIS EXISTS AT ALL
//
// A gateway may mount the host at a path prefix and strip it before forwarding, so the process sees only /join and
// cannot know it was reached at /agent-groups/join. `location.pathname` has the answer, and only the browser has it.

/**
 * Derive the shareable join URL from what the browser knows.
 *
 * @param {object} input - inputs.
 * @param {string} input.origin - `location.origin`, e.g. `https://gw.company.com`.
 * @param {string} input.pathname - `location.pathname`, e.g. `/agent-groups/join`.
 * @param {string} input.token - the one-time token.
 * @param {string} [input.route] - the join route path; defaults to `/join`.
 * @returns {string} an absolute join URL with the token.
 */
export function deriveJoinUrl({ origin, pathname, token, route = '/join' }) {
  const base = typeof pathname === 'string' ? pathname : '';
  // Everything before the known route is the mount prefix. Anchored at the end so a directory named `join`
  // earlier in the path is left alone.
  const trimmed = base.replace(new RegExp(`${escapeForRegExp(route)}/?$`, 'u'), '');
  return `${origin}${trimmed}${route}?t=${encodeURIComponent(token ?? '')}`;
}

/**
 * Escape a literal string for use inside a RegExp.
 *
 * @param {string} value - the literal.
 * @returns {string} the escaped form.
 */
function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
