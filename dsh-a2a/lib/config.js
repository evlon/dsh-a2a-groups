/**
 * Configuration for dsh-a2a.
 *
 * Config is validated here rather than by a Cordis schema, for the same
 * self-containment reason as the rest of this plugin: a `Config` export would
 * require `schemastery`, and a profile plugin is loaded by plain Node
 * resolution, so bare `@deepseek-ai/...` specifiers would not resolve.
 *
 * Every malformed value falls back to its default instead of throwing. A plugin
 * that refuses to mount because one number was a string is a plugin an operator
 * cannot diagnose; one that mounts with a logged fallback is one they can.
 *
 * @module dsh-a2a/config
 */

/** Delivery presentations: how an inbound A2A message shows up in a Session. */
export const PRESENTATIONS = Object.freeze(['notice', 'bubble']);

/** Delivery modes accepted by the deliverer. */
export const DELIVERY_MODES = Object.freeze(['queue', 'steer', 'interrupt', 'inbox']);

/** The A2A wire versions this plugin speaks. */
export const PROTOCOL_VERSIONS = Object.freeze(['1.0']);

/** Every default in one place, so a test and an operator read the same numbers. */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  /**
   * Identity in the agent card.
   *
   * Both fields are OPTIONAL and both have a derived default: with nothing set,
   * the card names this instance after how it names itself across groups, and
   * describes it with the roles it declared there (layer B). An operator sets
   * these only when they want an identity that does not move as memberships
   * change — which is a legitimate want, not the default.
   */
  agent: Object.freeze({
    name: '',
    description: '',
    version: '',
  }),
  server: Object.freeze({
    enabled: true,
    publicUrl: '',
    token: '',
    bindSessionId: 'self',
    maxBodyBytes: 1048576,
    taskTimeoutMs: 600000,
    streaming: true,
    skills: Object.freeze({ session: true, group: true }),
  }),
  client: Object.freeze({
    enabled: true,
    apiKey: '',
    gatewayBase: '',
    protocolVersion: '1.0',
    forwardProto: '',
    cardTtlMs: 300000,
    timeoutMs: 120000,
    reconnectAttempts: 3,
    streamIdleMs: 120000,
  }),
  groups: Object.freeze({
    enabled: true,
    home: '',
    // Hours an invite stays valid.
    //
    // `null` makes invites permanent by default; a number keeps them bounded. There
    // is no use counter — revoking a link is how an owner stops it, which is more
    // precise than waiting for a quota to run out.
    inviteExpiresInHours: 168,
    maxPostChars: 32000,
    maxPostsPerMinute: 20,
    retentionDays: 30,
    wakeMembers: true,
    publicUrl: '',
    agentName: '',
    gatewayBase: '',
    // Whether THIS instance hosts groups itself, instead of a standalone agent-groups
    // server. Off by default: the normal shape is one shared host behind the gateway
    // and every DSH instance as a member. Turning it on makes this instance accept
    // group/create locally, which is only useful for a single-machine setup.
    embedded: false,
  }),
  delivery: Object.freeze({
    presentation: 'notice',
    defaultMode: 'queue',
    hopBudget: 16,
    dedupeWindowMs: 600000,
    deliveryTimeoutMs: 120000,
  }),
  tools: true,
  promptSection: true,
});

/**
 * Validate and fill in a raw plugin config.
 *
 * Unknown keys are dropped: a config that carries a key this version does not
 * understand is either from a newer release or a typo, and forwarding either
 * into the runtime would let a typo silently become behaviour.
 *
 * @param {object} [raw] - plugin configuration from the profile patch.
 * @returns {typeof DEFAULT_CONFIG} the normalized settings.
 */
export function normalizeConfig(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const defaults = DEFAULT_CONFIG;
  const agent = isPlainObject(source.agent) ? source.agent : {};
  const server = isPlainObject(source.server) ? source.server : {};
  const client = isPlainObject(source.client) ? source.client : {};
  const groups = isPlainObject(source.groups) ? source.groups : {};
  const delivery = isPlainObject(source.delivery) ? source.delivery : {};
  const skills = isPlainObject(server.skills) ? server.skills : {};

  return {
    enabled: bool(source.enabled, defaults.enabled),
    agent: {
      name: text(agent.name, defaults.agent.name),
      description: text(agent.description, defaults.agent.description),
      version: text(agent.version, defaults.agent.version),
    },
    server: {
      enabled: bool(server.enabled, defaults.server.enabled),
      publicUrl: text(server.publicUrl, defaults.server.publicUrl),
      token: text(server.token, defaults.server.token),
      bindSessionId: text(server.bindSessionId, defaults.server.bindSessionId),
      maxBodyBytes: integer(server.maxBodyBytes, defaults.server.maxBodyBytes, 1024, 64 * 1024 * 1024),
      taskTimeoutMs: integer(server.taskTimeoutMs, defaults.server.taskTimeoutMs, 1000, 24 * 3600 * 1000),
      streaming: bool(server.streaming, defaults.server.streaming),
      skills: {
        session: bool(skills.session, defaults.server.skills.session),
        group: bool(skills.group, defaults.server.skills.group),
      },
    },
    client: {
      enabled: bool(client.enabled, defaults.client.enabled),
      apiKey: text(client.apiKey, defaults.client.apiKey),
      gatewayBase: stripTrailingSlash(text(client.gatewayBase, defaults.client.gatewayBase)),
      protocolVersion: oneOf(client.protocolVersion, PROTOCOL_VERSIONS, defaults.client.protocolVersion),
      // Local http development: the gateway advertises `https` on the card unless
      // a proxy says otherwise, so this header is what makes the card honest.
      forwardProto: oneOf(text(client.forwardProto, ''), ['', 'http', 'https'], ''),
      cardTtlMs: integer(client.cardTtlMs, defaults.client.cardTtlMs, 0, 24 * 3600 * 1000),
      timeoutMs: integer(client.timeoutMs, defaults.client.timeoutMs, 1000, 24 * 3600 * 1000),
      reconnectAttempts: integer(client.reconnectAttempts, defaults.client.reconnectAttempts, 0, 20),
      streamIdleMs: integer(client.streamIdleMs, defaults.client.streamIdleMs, 1000, 24 * 3600 * 1000),
    },
    groups: {
      enabled: bool(groups.enabled, defaults.groups.enabled),
      home: text(groups.home, defaults.groups.home),
      // `null` = invites never expire by default; a number = that many hours.
      inviteExpiresInHours: groups.inviteExpiresInHours === null
        ? null
        : integer(groups.inviteExpiresInHours, defaults.groups.inviteExpiresInHours, 1, 24 * 365 * 10),
      maxPostChars: integer(groups.maxPostChars, defaults.groups.maxPostChars, 200, 1024 * 1024),
      maxPostsPerMinute: integer(groups.maxPostsPerMinute, defaults.groups.maxPostsPerMinute, 1, 10000),
      retentionDays: integer(groups.retentionDays, defaults.groups.retentionDays, 1, 3650),
      wakeMembers: bool(groups.wakeMembers, defaults.groups.wakeMembers),
      publicUrl: stripTrailingSlash(text(groups.publicUrl, defaults.groups.publicUrl)),
      agentName: text(groups.agentName, defaults.groups.agentName),
      gatewayBase: stripTrailingSlash(text(groups.gatewayBase, defaults.groups.gatewayBase)),
      embedded: bool(groups.embedded, defaults.groups.embedded),
    },
    delivery: {
      presentation: oneOf(delivery.presentation, PRESENTATIONS, defaults.delivery.presentation),
      defaultMode: oneOf(delivery.defaultMode, DELIVERY_MODES, defaults.delivery.defaultMode),
      hopBudget: integer(delivery.hopBudget, defaults.delivery.hopBudget, 1, 64),
      dedupeWindowMs: integer(delivery.dedupeWindowMs, defaults.delivery.dedupeWindowMs, 0, 24 * 3600 * 1000),
      deliveryTimeoutMs: integer(
        delivery.deliveryTimeoutMs,
        defaults.delivery.deliveryTimeoutMs,
        1000,
        24 * 3600 * 1000,
      ),
    },
    tools: bool(source.tools, defaults.tools),
    promptSection: bool(source.promptSection, defaults.promptSection),
  };
}

/**
 * The directory that owns this plugin's durable state.
 *
 * `<DSH_HOME>/a2a` by default: a plugin's state belongs beside the Sessions it
 * belongs to, so a profile copied to another machine carries its groups with it.
 * A configured `groups.home` wins so a deployment can put the state on a shared
 * volume.
 *
 * @param {object} settings - normalized config.
 * @param {NodeJS.ProcessEnv} [env] - environment to read `DSH_HOME` from.
 * @returns {string} the state directory.
 */
export function resolveHome(settings, env = process.env) {
  const configured = settings?.groups?.home ?? '';
  if (configured !== '') return configured;
  const home = typeof env.DSH_HOME === 'string' && env.DSH_HOME !== '' ? env.DSH_HOME : undefined;
  const base = home ?? process.cwd();
  return `${base.replace(/[\\/]+$/, '')}/a2a`;
}

/** Coerce to a boolean, falling back when absent. */
function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/** Coerce to a trimmed string, falling back when absent or blank. */
function text(value, fallback) {
  if (typeof value !== 'string') return fallback;
  return value;
}

/** Coerce to an integer inside `[min, max]`, falling back when unusable. */
function integer(value, fallback, min, max) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  const rounded = Math.trunc(number);
  if (rounded < min || rounded > max) return fallback;
  return rounded;
}

/** Coerce to one of `allowed`, falling back otherwise. */
function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

/** Drop trailing slashes so two spellings of the same base compare equal. */
function stripTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

/** Whether a value is a plain JSON object (not an array, not null). */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
