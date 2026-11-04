/**
 * Self-check: is this DSH instance reachable as an A2A agent through the gateway?
 *
 * Why this exists, and why it is not the admin API: the question a person
 * actually has is "will my colleague's invite link work", and the only honest way
 * to answer it is to make the same call a colleague would. Reading the gateway's
 * configured agent list proves the config was *written*, not that the route
 * *works* — a wrong secret, a wrong URL, or a disabled entry all look fine in the
 * config and fail at the door.
 *
 * The probe therefore walks the real path, in order, and stops at the first step
 * that fails so the report names the actual obstacle:
 *
 *   1. Is the local server attached?           (no gateway involved)
 *   2. Does the gateway serve our card?        (auth + ACL + upstream reach)
 *   3. Does the card come back rewritten?      (the gateway is really in front)
 *   4. Does a real skill answer through it?    (the whole chain)
 *
 * Step 1 needs no network, so an instance that is up but not yet registered gets
 * "your side is fine, the gateway entry is what is missing" instead of a generic
 * failure.
 *
 * @module dsh-a2a/probe
 */

/** How long one probe request may take, in milliseconds. */
const PROBE_TIMEOUT_MS = 8000;

/**
 * Check whether this instance is reachable through a gateway.
 *
 * @param {object} options - probe inputs.
 * @param {object} [options.config] - normalized plugin config.
 * @param {object} [options.server] - the server facade (for `info()`).
 * @param {object} [options.fetchImpl] - fetch implementation, for tests.
 * @returns {Promise<object>} a report: `{ok, checks, hint}`.
 */
export async function probeReachability({ config, server, fetchImpl } = {}) {
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  const checks = [];

  // --- 1. the local side ---------------------------------------------------
  const info = typeof server?.info === 'function' ? server.info() : undefined;
  const localUp = info?.attached === true;
  checks.push({
    step: 'local',
    ok: localUp,
    detail: localUp
      ? `this instance serves ${info.url}`
      : 'the A2A server is not attached (server.enabled is false, or webServer is unavailable)',
  });
  if (!localUp) {
    return finish(checks, 'Start the A2A server first: set server.enabled = true and restart.');
  }

  // --- what the gateway should be asked for -------------------------------
  const gatewayBase = config?.groups?.gatewayBase ?? config?.client?.gatewayBase ?? '';
  const agentName = config?.groups?.agentName ?? '';
  if (gatewayBase === '' || agentName === '') {
    checks.push({
      step: 'config',
      ok: false,
      detail: gatewayBase === ''
        ? 'groups.gatewayBase is not set'
        : 'groups.agentName is not set (the name this instance has inside the gateway; one name, all groups)',
    });
    return finish(checks, 'Fill in groups.gatewayBase and groups.agentName, then run this check again.');
  }
  checks.push({ step: 'config', ok: true, detail: `gateway ${gatewayBase}, agent "${agentName}"` });

  // --- 2. the card through the gateway ------------------------------------
  const cardUrl = `${gatewayBase}/${agentName}/.well-known/agent-card.json`;
  const headers = {};
  if (config?.client?.apiKey) headers['x-api-key'] = config.client.apiKey;
  // The gateway assumes https unless told otherwise, and a wrong scheme makes the
  // card it hands back unusable; this header is what the local http setup needs.
  if (config?.client?.forwardProto) headers['x-forwarded-proto'] = config.client.forwardProto;

  let card;
  try {
    const response = await withTimeout(doFetch, cardUrl, { headers }, PROBE_TIMEOUT_MS);
    if (response.status === 401 || response.status === 403) {
      checks.push({
        step: 'gateway-auth',
        ok: false,
        detail: `the gateway refused our key (HTTP ${response.status}); this is client.apiKey, not server.token`,
      });
      return finish(checks, 'The gateway rejected the caller key. Check client.apiKey against the gateway\'s api_keys.');
    }
    if (response.status === 404) {
      checks.push({
        step: 'gateway-registered',
        ok: false,
        detail: `the gateway knows no agent named "${agentName}"`,
      });
      return finish(checks, registrationHint(gatewayBase, agentName, info));
    }
    if (response.status !== 200) {
      checks.push({ step: 'gateway', ok: false, detail: `the gateway answered HTTP ${response.status}` });
      return finish(checks, 'The gateway could not reach this instance. Check that its URL uses an address the gateway can actually dial.');
    }
    card = await response.json();
    checks.push({ step: 'gateway-registered', ok: true, detail: `card served at ${cardUrl}` });
  } catch (error) {
    checks.push({ step: 'gateway', ok: false, detail: describe(error) });
    return finish(checks, 'The gateway is unreachable from here. Check groups.gatewayBase.');
  }

  // --- 3. the card must point back at the gateway -------------------------
  const advertised = String(card?.url ?? '');
  const rewritten = advertised.includes(`/a2a/${agentName}`) || advertised.startsWith(gatewayBase);
  checks.push({
    step: 'card-rewritten',
    // A card still advertising the upstream address means the caller would bypass
    // the gateway; it also leaks an internal address, which is why it is a
    // failure rather than a warning.
    ok: rewritten,
    detail: rewritten ? `advertised url: ${advertised}` : `card advertises "${advertised}", which is not the gateway`,
  });

  // --- 4. a real skill through the whole chain ---------------------------
  const skills = Array.isArray(card?.skills) ? card.skills.map((skill) => skill?.id) : [];
  if (!skills.includes('ping')) {
    checks.push({ step: 'skill', ok: false, detail: 'the card does not advertise "ping", so the chain cannot be proven' });
    return finish(checks, 'Register this plugin\'s server.backgrounded skills, or check that server.skills are enabled.');
  }
  try {
    const response = await withTimeout(doFetch, `${gatewayBase}/${agentName}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', 'a2a-version': '1.0' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `probe-${Date.now()}`,
        method: 'SendMessage',
        params: {
          message: {
            role: 'user',
            messageId: `probe-${Date.now()}`,
            parts: [{ kind: 'text', text: 'ping' }],
            metadata: { skill: 'ping' },
          },
        },
      }),
    }, PROBE_TIMEOUT_MS);
    const body = await response.json().catch(() => undefined);
    const text = (body?.result?.task?.artifacts ?? [])
      .flatMap((artifact) => artifact.parts ?? [])
      .map((part) => part.text ?? '')
      .join('');
    const answered = response.status === 200 && text !== '';
    checks.push({
      step: 'roundtrip',
      ok: answered,
      detail: answered
        ? `ping answered through the gateway: ${text.replace(/\s+/g, ' ').slice(0, 80)}`
        : `the gateway answered HTTP ${response.status}${body?.error ? ` (${body.error.code}: ${body.error.message})` : ''}`,
    });
  } catch (error) {
    checks.push({ step: 'roundtrip', ok: false, detail: describe(error) });
  }

  return finish(checks, undefined);
}

/** Assemble the report and the one-line advice that goes with it. */
function finish(checks, hint) {
  const ok = checks.every((check) => check.ok);
  const failed = checks.filter((check) => !check.ok);
  return {
    ok,
    checks,
    hint: ok
      ? 'Ready: a colleague\'s invite link will work as soon as you mint one.'
      : (hint ?? failed[0]?.detail ?? 'One step failed; see the checks above.'),
  };
}

/**
 * The gateway entry this instance needs, spelled out.
 *
 * Printed only when the gateway does not know the name, because that is the one
 * case where the operator genuinely has to edit a file — and it happens once per
 * INSTANCE, not once per group.
 */
export function registrationHint(gatewayBase, agentName, info) {
  const token = info?.tokenConfigured === true ? '<this profile\'s server.token>' : '<set server.token first>';
  return [
    `The gateway has no agent named "${agentName}". Register this instance ONCE (not per group):`,
    '',
    'a2a_agents:',
    `  - name: "${agentName}"`,
    `    url: "${info?.url ?? 'http://127.0.0.1:3091/a2a'}"`,
    `    protocol_version: "1.0"`,
    '    auth_type: api_key',
    `    secret: "${token}"`,
    '    timeout_ms: 600000',
    '    enabled: true',
    '',
    `Then reload the gateway and run this check again. Every group you create afterwards`,
    `reuses this one entry — the group id travels in the request, not in the URL.`,
  ].join('\n');
}

/** Fetch with a deadline, so a wedged gateway cannot hang the tool that asked. */
async function withTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** One line about an error, without a stack. */
function describe(error) {
  if (error?.name === 'AbortError') return 'timed out';
  return error instanceof Error ? error.message : String(error);
}
