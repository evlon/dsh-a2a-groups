/**
 * The A2A agent card: what a peer reads before it sends anything.
 *
 * The card is a promise. Every field in it is something the server will honour
 * or something a peer will branch on, so it is assembled from the same config
 * and the same skill registry the dispatcher uses — never hand-written. A card
 * that advertises a skill the dispatcher does not route is worse than no card at
 * all: the peer discovers it, calls it, and gets `-32601`.
 *
 * Boundaries:
 * - No HTTP. `buildCard()` returns a value; the server decides where to serve it.
 * - Path constants live here because both the server routes and the card's
 *   `supportedInterfaces[].url` must agree, and a divergence is silent.
 *
 * @module dsh-a2a/card
 */

import { PROTOCOL_VERSION } from './wire.js';

/** Where the JSON-RPC endpoint lives, relative to the host origin. */
export const A2A_PATH = '/a2a';

/** The card's canonical location, as A2A 1.0 defines it. */
export const CARD_PATH = '/a2a/.well-known/agent-card.json';

/**
 * Legacy alias for the card path.
 *
 * 0.3 clients (and a few gateways that never updated) probe `agent.json`. It
 * costs one route to serve both, and refusing would make a working deployment
 * look broken to an older peer.
 */
export const CARD_ALIAS_PATH = '/a2a/.well-known/agent.json';

/** Media types a 1.0 peer expects on the two input/output mode fields. */
const DEFAULT_INPUT_MODES = Object.freeze(['text/plain']);
const DEFAULT_OUTPUT_MODES = Object.freeze(['text/plain']);

/**
 * The subset of a plugin config the card reads.
 *
 * Declared apart from the full §3 config because the card builder needs three
 * facts only: whether streaming is served at all (it changes what the card
 * promises), the public endpoint to advertise, and the agent identity strings.
 * A wider type here would let the card quietly start depending on more config.
 *
 * @typedef {object} CardConfig
 * @property {CardServerConfig} [server] - the server slice of the config.
 */

/**
 * The server-config fields the card cares about.
 *
 * @typedef {object} CardServerConfig
 * @property {string} [publicUrl] - fully qualified endpoint; empty means derive from origin.
 * @property {boolean} [streaming] - whether SendStreamingMessage is served at all.
 */

/**
 * One skill as the registry exposes it and the card publishes it.
 *
 * Note what is NOT here: the run function. The card is a public JSON document,
 * so the callable body never travels with it — a peer names the skill id and the
 * server dispatches. Listing it would either serialize as undefined or leak a
 * function reference into a document that is served to anyone.
 *
 * @typedef {object} CardSkill
 * @property {string} id - the value a caller puts in message.metadata.skill.
 * @property {string} [name] - display name; falls back to the id.
 * @property {string} [description]
 * @property {string[]} [tags] - free-form grouping, for example a streaming marker.
 * @property {string[]} [examples] - sample prompts, shown in a discovery UI.
 * @property {string[]} [inputModes] - defaults to text/plain when absent.
 * @property {string[]} [outputModes] - defaults to text/plain when absent.
 */

/**
 * What the card builder accepts.
 *
 * @typedef {object} CardOptions
 * @property {CardConfig} [config] - normalized plugin config.
 * @property {{list: () => CardSkill[]}} [skills] - skill registry.
 * @property {string} [url] - absolute endpoint URL, already ending in /a2a.
 * @property {string} [name] - agent display name.
 * @property {string} [description] - agent description.
 * @property {string} [version] - plugin version.
 * @property {object} [profile] - layer-B profile extension, or absent.
 */
/**
 * Resolve the public endpoint URL advertised in the card and its interfaces.
 *
 * Per §3 of the contract, `config.server.publicUrl` is the *fully qualified*
 * endpoint a peer should call — an operator behind a gateway writes the whole
 * `/a2a/me` path there, because only they know what the gateway rewrote. An
 * empty setting instead means "derive it": the webserver's origin plus `/a2a`,
 * which is right for a direct bind and for localhost debugging. Appending `/a2a`
 * to a configured publicUrl would produce `/a2a/me/a2a`, so the two cases are
 * kept distinct rather than folded into one "base" concept.
 *
 * @param {{config?: CardConfig, origin?: () => string|undefined}} input - resolution inputs.
 * @returns {string} absolute endpoint URL without a trailing slash, or `''` when unknown.
 */
export function resolveAgentUrl({ config, origin } = {}) {
  const configured = typeof config?.server?.publicUrl === 'string' ? config.server.publicUrl.trim() : '';
  if (configured !== '') return configured.replace(/\/+$/, '');
  if (typeof origin !== 'function') return '';
  try {
    const value = origin();
    if (typeof value !== 'string' || value.trim() === '') return '';
    return `${value.trim().replace(/\/+$/, '')}${A2A_PATH}`;
  } catch {
    // getOrigin() throws before the listener binds; a card built that early can
    // still be useful to the operating human, so return an empty url instead.
    return '';
  }
}

/**
 * Project one registry skill into the card's `skills[]` entry.
 *
 * Only declared metadata is copied. `run` is dropped on purpose: the card is a
 * public document, and shipping a function reference would serialize as
 * `undefined` in JSON and silently change the shape under test.
 *
 * @param {CardSkill} skill - registry skill.
 * @returns {object|undefined} the card entry, or `undefined` for a malformed skill.
 */
export function buildSkillEntry(skill) {
  if (skill === null || typeof skill !== 'object') return undefined;
  const id = typeof skill.id === 'string' ? skill.id.trim() : '';
  if (id === '') return undefined;
  const entry = {
    id,
    name: typeof skill.name === 'string' && skill.name !== '' ? skill.name : id,
    description: typeof skill.description === 'string' ? skill.description : '',
  };
  if (Array.isArray(skill.tags) && skill.tags.length > 0) entry.tags = skill.tags.map(String);
  if (Array.isArray(skill.examples) && skill.examples.length > 0) entry.examples = skill.examples.map(String);
  if (Array.isArray(skill.inputModes) && skill.inputModes.length > 0) entry.inputModes = skill.inputModes.map(String);
  if (Array.isArray(skill.outputModes) && skill.outputModes.length > 0) entry.outputModes = skill.outputModes.map(String);
  return entry;
}

/**
 * Build the agent card document.
 *
 * `capabilities` reports what this deployment actually does. `streaming` follows
 * config because a deployment with streaming off answers `SendStreamingMessage`
 * with `-32601`, and a card claiming otherwise would make every 1.0 client pick
 * the wrong method first. `pushNotifications` and `stateTransitionHistory` stay
 * false: neither is implemented, and a peer that trusts a true here will wait
 * forever for pushes that never arrive.
 *
 * `profile` is the emergent identity (layer B): who this instance is across the
 * groups it belongs to. It is derived at read time from memberships, so it can
 * never be stale — which is why it is a parameter here rather than stored state.
 *
 * @param {CardOptions} input - card inputs.
 * @returns {object} the card document, ready to serialize as JSON.
 */
export function buildCard({ config, skills, url, name, description, version, profile } = {}) {
  const endpoint = typeof url === 'string' && url.trim() !== '' ? url.trim().replace(/\/+$/, '') : '';
  const streaming = config?.server?.streaming !== false;
  const registrySkills = typeof skills?.list === 'function' ? skills.list() : [];
  const entries = [];
  if (Array.isArray(registrySkills)) {
    for (const skill of registrySkills) {
      const entry = buildSkillEntry(skill);
      if (entry !== undefined) entries.push(entry);
    }
  }
  // The profile supplies the identity when the operator did not hard-code one:
  // `name` falls back to how this person names themselves across groups, and
  // `description` to an auto-generated line naming their busiest roles.
  const resolvedName = typeof name === 'string' && name !== ''
    ? name
    : (typeof profile?.name === 'string' && profile.name !== '' ? profile.name : 'dsh-a2a');
  const resolvedDescription = typeof description === 'string' && description !== ''
    ? description
    : (typeof profile?.headline === 'string' && profile.headline !== ''
      ? profile.headline
      : 'Exposes a DSH Session as an A2A 1.0 agent and carries invite-only collaboration groups.');

  const card = {
    name: resolvedName,
    description: resolvedDescription,
    url: endpoint,
    version: typeof version === 'string' && version !== '' ? version : '0.1.0',
    protocolVersion: PROTOCOL_VERSION,
    preferredTransport: 'JSONRPC',
    capabilities: {
      streaming,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: [...DEFAULT_INPUT_MODES],
    defaultOutputModes: [...DEFAULT_OUTPUT_MODES],
    supportedInterfaces: [
      {
        url: endpoint,
        protocolBinding: 'JSONRPC',
        protocolVersion: PROTOCOL_VERSION,
      },
    ],
    skills: entries,
  };
  // Vendor extension, preserved verbatim by an A2A gateway and ignored by a peer
  // that does not understand it. Carries the per-group identity so a caller can
  // tell "this is the developer on invoice, the product owner on contracts".
  if (profile !== undefined && profile !== null && Array.isArray(profile.groups) && profile.groups.length > 0) {
    const extension = { groups: profile.groups };
    if (typeof profile.headline === 'string' && profile.headline !== '') extension.headline = profile.headline;
    if (Array.isArray(profile.tags) && profile.tags.length > 0) extension.tags = profile.tags;
    card['x-agent-profiles'] = extension;
  }
  return card;
}