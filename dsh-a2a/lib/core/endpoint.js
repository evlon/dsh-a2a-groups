/**
 * Work out this instance's own A2A address, so a member who joins can be reached.
 *
 * THE PROBLEM THIS SOLVES
 *
 * The `endpoint` field on a member row has existed since the beginning and has always been empty,
 * because `join` only took an endpoint the caller passed in — and no caller knows their own
 * address. So "reach that person directly" was never possible, and the colleague card had no
 * address to show.
 *
 * WHY THE ADDRESS IS COMPOSED, NOT DISCOVERED
 *
 * Members reach each other through the gateway, whose convention is already fixed by configuration:
 *
 *     <gatewayBase>/<agentName>
 *     http://gw:3000/a2a/zhangsan
 *
 * That is exactly the shape the invite link already encodes (it carries `gw` and `agent`), so
 * composing it here does not invent a convention — it reuses the one that already lets a colleague
 * join.
 *
 * WHERE IT REFUSES TO GUESS
 *
 * When either half is unconfigured, the answer is `undefined`, not a plausible-looking URL. A wrong
 * endpoint is worse than none: a caller that tries to reach it waits for a timeout and concludes the
 * whole feature is broken, while an absent one lets the caller say "no address, use the group".
 *
 * @module dsh-a2a/endpoint
 */

/** Characters allowed in one path segment of an agent name. */
const SAFE_SEGMENT = /^[A-Za-z0-9._~-]+$/u;

/**
 * Join a base URL and an agent name into an endpoint.
 *
 * @param {object} input
 * @param {string} [input.gatewayBase] the A2A gateway base, e.g. `http://gw:3000/a2a`.
 * @param {string} [input.agentName] this instance's name at the gateway, e.g. `zhangsan`.
 * @returns {string|undefined} the endpoint, or undefined when either half is missing.
 */
export function composeEndpoint({ gatewayBase, agentName } = {}) {
  const base = typeof gatewayBase === 'string' ? gatewayBase.trim() : '';
  const name = typeof agentName === 'string' ? agentName.trim() : '';

  // Both halves are required. Half a URL is not a shorter answer, it is a wrong one.
  if (base === '' || name === '') return undefined;

  // The name becomes a path segment, so it has to survive being one. A name containing `/` or `?`
  // would silently truncate or misroute, and the failure would surface as "colleague unreachable"
  // long after the join that caused it.
  if (!SAFE_SEGMENT.test(name)) return undefined;

  // A base with a trailing slash and a name with a leading one would produce `//`, which some
  // gateways treat as a different path.
  const trimmedBase = base.replace(/\/+$/u, '');
  return `${trimmedBase}/${name}`;
}

/**
 * The endpoint for this host, from its normalized config.
 *
 * @param {object} config - normalized config (`config.groups`).
 * @returns {string|undefined} the endpoint, or undefined when not configured.
 */
export function ownEndpointFromConfig(config) {
  const groups = config?.groups ?? {};
  return composeEndpoint({ gatewayBase: groups.gatewayBase, agentName: groups.agentName });
}
