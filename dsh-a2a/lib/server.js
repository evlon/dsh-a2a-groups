/**
 * The A2A 1.0 HTTP endpoint: routing, authentication, version gate, dispatch.
 *
 * This module is the membrane. On one side is a JSON-RPC speaker that knows only
 * A2A; on the other is a skill registry whose entries run inside this DSH host.
 * Everything risky about that membrane is decided here, once:
 * who may call (token or loopback), which protocol they speak, how big a body
 * they may send, how long a skill may run, and what a peer sees when it all goes
 * wrong.
 *
 * Boundaries:
 * - It never imports DSH. Host capability arrives as `ctx`, and only
 *   `ctx.webServer` is touched, only to register routes.
 * - It never formats a reply. Skills produce `{text, artifacts, finalState}`;
 *   `wire.js` turns that into 1.0 envelopes. A handler that hand-built JSON here
 *   would be the first place a protocol field could drift.
 * - The agent card is public on purpose. A2A discovery happens before the caller
 *   has credentials; requiring a token for the card would make the endpoint
 *   undiscoverable through the gateways this plugin exists to talk to.
 *
 * @module dsh-a2a/server
 */

import {
  RPC_ERRORS,
  PROTOCOL_VERSION,
  IMPLIED_LEGACY_VERSION,
  artifactUpdate,
  makeArtifact,
  redactAll,
  rpcError,
  rpcResult,
  safeEqual,
  statusUpdate,
  textOfMessage,
  toWireTask,
  writeComment,
  writeSse,
  writeSseHead,
} from './wire.js';
import { A2A_PATH, CARD_ALIAS_PATH, CARD_PATH, buildCard, resolveAgentUrl } from './card.js';

/** Methods this deployment answers. Anything else is `-32601`. */
const SUPPORTED_METHODS = Object.freeze([
  'SendMessage',
  'SendStreamingMessage',
  'GetTask',
  'CancelTask',
]);

/** Method names that stream; used by the `streaming: false` gate. */
const STREAMING_METHODS = Object.freeze(new Set(['SendStreamingMessage']));

/** Header the protocol version travels in. */
const VERSION_HEADER = 'a2a-version';

/** Default request body ceiling (1 MiB): one text message, not a file upload. */
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/** Default per-skill execution ceiling (10 min). */
const DEFAULT_TASK_TIMEOUT_MS = 10 * 60 * 1000;

/** Keep-alive cadence for a long stream, below the usual 60 s proxy idle cut. */
const HEARTBEAT_MS = 15000;

/** Default skill when the caller names none. */
const DEFAULT_SKILL = 'session/ask';

/**
 * Build the A2A server facade.
 *
 * The facade needs a way to add four routes and nothing else, so the route table is
 * injected instead of reached for on `ctx`. That single indirection is what lets the
 * SAME server code run in two very different homes:
 *
 *   - inside DSH (a member instance, and the embedded host): pass
 *     `ctx.webServer` as `registrar`;
 *   - as a standalone Node program (a production group host): pass an object whose
 *     `register` attaches to a plain `http.Server`.
 *
 * @param {object} options - server options.
 * @param {object} [options.ctx] - Host context. Optional now; kept so existing
 *   callers need no change, and unused when `registrar` is given.
 * @param {object} [options.registrar] - `{register({kind, path, handler}) => disposeFn}`.
 *   Defaults to `ctx?.webServer`.
 * @param {string} [options.where] - where this server runs, for error messages
 *   ("inside DSH" / "standalone").
 * @param {object} [options.logger] - logger with `info` / `warn` / `debug`.
 * @param {object} options.config - normalized plugin config (§3 of the contract).
 * @param {object} options.deliverer - from `createDeliverer`.
 * @param {object} options.tasks - a `TaskStore`.
 * @param {object} options.skills - skill registry `{get, list}`.
 * @returns {{attach: () => () => void, detach: () => void, card: () => object, info: () => object}} the facade.
 */
export function createServer({
  ctx,
  registrar = ctx?.webServer,
  where = 'inside DSH',
  logger,
  config,
  deliverer,
  tasks,
  skills,
  profileProvider,
} = {}) {
  const serverConfig = config?.server ?? {};
  const maxBodyBytes = positiveInt(serverConfig.maxBodyBytes, DEFAULT_MAX_BODY_BYTES);
  const taskTimeoutMs = positiveInt(serverConfig.taskTimeoutMs, DEFAULT_TASK_TIMEOUT_MS);
  const token = typeof serverConfig.token === 'string' ? serverConfig.token.trim() : '';
  const streaming = serverConfig.streaming !== false;

  /** @type {Array<() => void>} disposers for every registered route. */
  let disposers = [];
  let attached = false;

  /**
   * Attach every route to the Host webserver.
   *
   * Registration order carries no request-facing meaning (the webserver matches
   * exact-first, then longest prefix), so the three registrations are listed
   * longest-path-first purely for readability. The `/a2a/.well-known/` prefix
   * route is what turns an unknown discovery path into a JSON 404 instead of the
   * SPA's HTML shell, which would make a probing peer think it got a card.
   *
   * @returns {() => void} a disposer removing every route this call added.
   */
  function attach() {
    if (attached) return detach;
    // The route table comes from an injected registrar rather than from `ctx`: a
    // group host runs as a standalone Node program with a plain `http.Server`, and a
    // member instance runs inside DSH and uses `ctx.webServer`. Both pass the same
    // four registrations, so the A2A surface is identical either way.
    const register = registrar?.register;
    if (typeof register !== 'function') {
      throw new Error(`dsh-a2a: no route registrar was provided; the A2A endpoint cannot attach (${where})`);
    }
    if (token === '') {
      warn('no server.token configured; the A2A endpoint accepts loopback callers only. Set config.server.token to expose it.');
    }
    disposers = [
      register.call(registrar, { kind: 'exact', path: CARD_PATH, handler: handleCard }),
      register.call(registrar, { kind: 'exact', path: CARD_ALIAS_PATH, handler: handleCard }),
      register.call(registrar, { kind: 'prefix', path: `${A2A_PATH}/.well-known/`, handler: handleWellKnownFallback }),
      register.call(registrar, { kind: 'exact', path: A2A_PATH, handler: handleRpc }),
    ];
    attached = true;
    info();
    return detach;
  }

  /**
   * Remove every route this facade registered.
   *
   * A disposed route must leave the Host clean: a plugin reload re-registers the
   * same paths, and the webserver throws on a duplicate, so a missed disposer
   * turns "reload the plugin" into a startup failure.
   *
   * @returns {void}
   */
  function detach() {
    for (const dispose of disposers.reverse()) {
      try {
        if (typeof dispose === 'function') dispose();
      } catch (error) {
        warn('failed to dispose a route', error);
      }
    }
    disposers = [];
    attached = false;
  }

  /**
   * Build the current agent card.
   * @returns {object} the card document.
   */
  function card() {
    return buildCard({
      config,
      skills,
      url: resolveAgentUrl({ config, origin: originProvider() }),
      name: config?.agent?.name,
      description: config?.agent?.description,
      version: config?.agent?.version,
      // Layer B: derived per read, never stored. A provider that throws must not
      // take the card down — a peer needs the skills list even if the identity
      // aggregation is unhappy, so a failed profile degrades to "no extension".
      profile: readProfile(profileProvider),
    });
  }

  /**
   * Describe this endpoint for a human or for a diagnostics tool.
   * @returns {object} a credential-free summary.
   */
  function info() {
    const summary = {
      url: resolveAgentUrl({ config, origin: originProvider() }) || A2A_PATH,
      path: A2A_PATH,
      card: CARD_PATH,
      attached,
      streaming,
      tokenConfigured: token !== '',
      loopbackOnly: token === '',
      maxBodyBytes,
      taskTimeoutMs,
      protocolVersion: PROTOCOL_VERSION,
      methods: [...SUPPORTED_METHODS],
      skills: typeof skills?.list === 'function' ? skills.list().map((skill) => skill?.id).filter(Boolean) : [],
      tasks: typeof tasks?.size === 'number' ? tasks.size : 0,
    };
    if (typeof logger?.debug === 'function') logger.debug(`dsh-a2a: server ${attached ? 'attached' : 'detached'} at ${summary.url}`);
    return summary;
  }

  /**
   * Serve the agent card.
   * @param {object} req - `node:http` request.
   * @param {object} res - `node:http` response.
   * @returns {Promise<void>} resolves when the response is written.
   */
  async function handleCard(req, res) {
    if (!isReadMethod(req?.method)) {
      writeJson(res, 405, rpcError(null, RPC_ERRORS.INVALID_REQUEST, 'the agent card is served over GET'), { allow: 'GET, HEAD' });
      return;
    }
    writeJson(res, 200, card());
  }

  /**
   * Answer any other `/.well-known/` path with a JSON 404.
   *
   * This route exists to keep a probing peer on the wire format it expects. The
   * SPA fallback would otherwise answer 200 with HTML, and a client that parsed
   * the body would report a confusing schema error instead of "no such document".
   *
   * @param {object} req - `node:http` request.
   * @param {object} res - `node:http` response.
   * @returns {Promise<void>} resolves when the response is written.
   */
  async function handleWellKnownFallback(req, res) {
    const path = pathOf(req);
    writeJson(res, 404, rpcError(null, RPC_ERRORS.INVALID_REQUEST, `no A2A discovery document at ${path}`));
  }

  /**
   * Handle one JSON-RPC call.
   *
   * Order is deliberate: auth, then size, then version, then parse. Authenticating
   * before reading the body keeps an unauthenticated peer from making this Host
   * buffer a megabyte, and versioning before parsing means a 0.3 caller gets a
   * precise `-32003` instead of an `-32600` that hides the real problem.
   *
   * @param {object} req - `node:http` request.
   * @param {object} res - `node:http` response.
   * @returns {Promise<void>} resolves when the response is written.
   */
  async function handleRpc(req, res) {
    res?.setHeader?.('A2A-Version', PROTOCOL_VERSION);
    if (!isWriteMethod(req?.method)) {
      writeJson(res, 405, rpcError(null, RPC_ERRORS.INVALID_REQUEST, 'the JSON-RPC endpoint is POST-only'), { allow: 'POST' });
      return;
    }
    const auth = authenticate(req);
    if (!auth.ok) {
      writeJson(res, 401, rpcError(null, RPC_ERRORS.UNAUTHENTICATED, auth.reason), { 'www-authenticate': 'Bearer' });
      return;
    }
    let raw;
    try {
      raw = await readBody(req, maxBodyBytes);
    } catch (error) {
      if (error?.code === 'body_too_large') {
        writeJson(res, 413, rpcError(null, RPC_ERRORS.INVALID_REQUEST, `request body exceeds ${maxBodyBytes} bytes`));
        return;
      }
      writeJson(res, 400, rpcError(null, RPC_ERRORS.INVALID_REQUEST, 'could not read the request body'));
      return;
    }
    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch {
      writeJson(res, 400, rpcError(null, RPC_ERRORS.PARSE, 'request body is not valid JSON'));
      return;
    }
    if (Array.isArray(envelope)) {
      // A2A 1.0 is one call per request; a batch has no single task to bind the
      // reply to, so answering anything but an error would invent semantics.
      writeJson(res, 400, rpcError(null, RPC_ERRORS.INVALID_REQUEST, 'batch requests are not supported'));
      return;
    }
    if (envelope === null || typeof envelope !== 'object') {
      writeJson(res, 400, rpcError(null, RPC_ERRORS.INVALID_REQUEST, 'request must be a JSON object'));
      return;
    }
    const id = envelope.id ?? null;
    if (envelope.jsonrpc !== '2.0') {
      writeJson(res, 200, rpcError(id, RPC_ERRORS.INVALID_REQUEST, 'jsonrpc must be "2.0"'));
      return;
    }
    const version = versionOf(req);
    if (version !== PROTOCOL_VERSION) {
      const detail = version === IMPLIED_LEGACY_VERSION
        ? `missing A2A-Version header implies ${IMPLIED_LEGACY_VERSION}`
        : `requested ${version}`;
      writeJson(
        res,
        200,
        rpcError(id, RPC_ERRORS.VERSION_UNSUPPORTED, `this agent speaks A2A ${PROTOCOL_VERSION} only (${detail})`, {
          supported: [PROTOCOL_VERSION],
        }),
      );
      return;
    }
    const method = envelope.method;
    if (typeof method !== 'string' || method === '') {
      writeJson(res, 200, rpcError(id, RPC_ERRORS.INVALID_REQUEST, 'method must be a non-empty string'));
      return;
    }
    if (!SUPPORTED_METHODS.includes(method)) {
      writeJson(res, 200, rpcError(id, RPC_ERRORS.METHOD_NOT_FOUND, `unknown method "${method}"`, { method }));
      return;
    }
    if (!streaming && STREAMING_METHODS.has(method)) {
      writeJson(res, 200, rpcError(id, RPC_ERRORS.METHOD_NOT_FOUND, 'streaming is disabled on this agent', { method }));
      return;
    }
    if (method === 'GetTask') return respond(handleGetTask(req, res, id, envelope.params));
    if (method === 'CancelTask') return respond(handleCancelTask(req, res, id, envelope.params));
    if (method === 'SendStreamingMessage') return handleStreaming(req, res, id, envelope.params);
    return respond(handleSendMessage(req, res, id, envelope.params));
  }

  /**
   * Wrap one handler so an unexpected throw still produces a JSON-RPC error.
   *
   * Without this a skill bug would surface as the webserver's bare 400, which
   * tells an A2A peer nothing and looks like a network fault.
   *
   * @param {Promise<void>} work - handler promise.
   * @returns {Promise<void>} resolves when the handler finished or failed.
   */
  async function respond(work) {
    try {
      await work;
    } catch (error) {
      warn('unhandled error while answering an A2A call', error);
      // The handler may already have written; a second write would throw.
    }
  }

  /**
   * Unary `SendMessage`: run one skill to completion and return the task.
   *
   * @param {object} req - `node:http` request.
   * @param {object} res - `node:http` response.
   * @param {string|number|null} id - request id.
   * @param {object} params - `{message}`.
   * @returns {Promise<void>} resolves when the response is written.
   */
  async function handleSendMessage(req, res, id, params) {
    const admitted = await admit({ res, params });
    if (admitted.error !== undefined) {
      writeJson(res, 200, rpcError(id, admitted.error.code, admitted.error.message, admitted.error.data));
      return;
    }
    const { task, skill, skillId, text, message } = admitted;
    try {
      await Promise.race([
        runSkill({ task, skill, skillId, text, message, signal: admitted.signal, res: null, id }),
        admitted.timeout,
      ]);
      writeJson(res, 200, rpcResult(id, { task: toWireTask(tasks.get(task.id) ?? task) }));
    } catch (error) {
      const failure = classify(error);
      tasks.update(task.id, { state: 'failed', note: failure.message });
      tasks.flush();
      writeJson(res, 200, rpcError(id, failure.code, failure.message, { ...failure.data, taskId: task.id }));
    } finally {
      admitted.cleanup();
    }
  }

  /**
   * Streaming `SendStreamingMessage`: frame the same run as SSE.
   *
   * The four committed frame kinds are `submitted`, `working`, one `artifactUpdate`
   * per artifact, and the terminal `statusUpdate` carrying `final: true`. A peer
   * that only waits for `final` still works, and a peer that renders progress gets
   * something real instead of a single blob at the end.
   *
   * @param {object} req - `node:http` request.
   * @param {object} res - `node:http` response.
   * @param {string|number|null} id - request id.
   * @param {object} params - `{message}`.
   * @returns {Promise<void>} resolves when the stream ended.
   */
  async function handleStreaming(req, res, id, params) {
    const admitted = await admit({ res, params });
    if (admitted.error !== undefined) {
      // Nothing has been streamed yet, so this is still a clean HTTP error.
      writeJson(res, 200, rpcError(id, admitted.error.code, admitted.error.message, admitted.error.data));
      return;
    }
    const { task, skill, skillId, text, message } = admitted;
    const contextId = task.contextId;
    writeSseHead(res);
    writeSse(res, rpcResult(id, { statusUpdate: statusUpdate({ taskId: task.id, contextId, state: 'submitted', at: task.createdAt }) }));
    tasks.update(task.id, { state: 'working' });
    writeSse(res, rpcResult(id, { statusUpdate: statusUpdate({ taskId: task.id, contextId, state: 'working' }) }));
    const heartbeat = setInterval(() => {
      writeComment(res, `keep-alive ${new Date().toISOString()}`);
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
    const stop = () => clearInterval(heartbeat);
    res?.once?.('close', stop);
    try {
      const outcome = await Promise.race([
        runSkill({ task, skill, skillId, text, message, signal: admitted.signal, res, id }),
        admitted.timeout,
      ]);
      for (const artifact of outcome.artifacts) {
        writeSse(
          res,
          rpcResult(id, {
            artifactUpdate: artifactUpdate({ taskId: task.id, contextId, artifact, append: false, lastChunk: true }),
          }),
        );
      }
      const finalState = outcome.finalState ?? 'completed';
      const settled = tasks.update(task.id, { state: finalState }) ?? task;
      writeSse(
        res,
        rpcResult(id, {
          statusUpdate: statusUpdate({
            taskId: task.id,
            contextId,
            state: finalState,
            at: settled.updatedAt,
            final: true,
          }),
        }),
      );
    } catch (error) {
      const failure = classify(error);
      const settled = tasks.update(task.id, { state: 'failed', note: failure.message }) ?? task;
      writeSse(
        res,
        rpcResult(id, {
          statusUpdate: statusUpdate({
            taskId: task.id,
            contextId,
            state: 'failed',
            note: failure.message,
            at: settled.updatedAt,
            final: true,
          }),
        }),
      );
    } finally {
      stop();
      res?.off?.('close', stop);
      tasks.flush();
      admitted.cleanup();
      if (res?.writableEnded !== true) res?.end?.();
    }
  }

  /**
   * `GetTask`: read one task by id.
   *
   * @param {object} req - `node:http` request.
   * @param {object} res - `node:http` response.
   * @param {string|number|null} id - request id.
   * @param {object} params - `{id}` (also tolerates `taskId` and 0.3's `name`).
   * @returns {Promise<void>} resolves when the response is written.
   */
  async function handleGetTask(req, res, id, params) {
    const taskId = taskIdOf(params);
    if (taskId === '') {
      writeJson(res, 200, rpcError(id, RPC_ERRORS.INVALID_PARAMS, 'GetTask requires params.id'));
      return;
    }
    const task = tasks.get(taskId);
    if (task === undefined) {
      writeJson(res, 200, rpcError(id, RPC_ERRORS.INVALID_PARAMS, `no task "${taskId}"`, { code: 'task_not_found', taskId }));
      return;
    }
    writeJson(res, 200, rpcResult(id, { task: toWireTask(task) }));
  }

  /**
   * `CancelTask`: cancel a task that has not settled.
   *
   * @param {object} req - `node:http` request.
   * @param {object} res - `node:http` response.
   * @param {string|number|null} id - request id.
   * @param {object} params - `{id}`.
   * @returns {Promise<void>} resolves when the response is written.
   */
  async function handleCancelTask(req, res, id, params) {
    const taskId = taskIdOf(params);
    if (taskId === '') {
      writeJson(res, 200, rpcError(id, RPC_ERRORS.INVALID_PARAMS, 'CancelTask requires params.id'));
      return;
    }
    const { task } = tasks.cancel(taskId);
    if (task === undefined) {
      writeJson(res, 200, rpcError(id, RPC_ERRORS.INVALID_PARAMS, `no task "${taskId}"`, { code: 'task_not_found', taskId }));
      return;
    }
    tasks.flush();
    writeJson(res, 200, rpcResult(id, { task: toWireTask(task) }));
  }

  /**
   * Validate one `SendMessage` request and open a task for it.
   *
   * Task creation happens before the skill runs so that every path after this
   * point — success, timeout, failure, cancellation — has a task id to attach
   * the outcome to. A peer that disconnects mid-call can still `GetTask` the id
   * it guessed from a submission frame.
   *
   * @param {object} input - admission inputs.
   * @param {object} input.res - the HTTP response, for the disconnect signal.
   * @param {object} input.params - JSON-RPC params.
   * @returns {Promise<object>} `{task, skill, text, signal, timeout, cleanup}` or `{error}`.
   */
  async function admit({ res, params }) {
    const message = params?.message;
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      return { error: { code: RPC_ERRORS.INVALID_PARAMS, message: 'SendMessage requires params.message' } };
    }
    if (!Array.isArray(message.parts) || message.parts.length === 0) {
      return { error: { code: RPC_ERRORS.INVALID_PARAMS, message: 'params.message.parts must be a non-empty array' } };
    }
    const skillId = skillIdOf(message);
    const skill = typeof skills?.get === 'function' ? skills.get(skillId) : undefined;
    if (skill === undefined || skill === null) {
      const known = typeof skills?.list === 'function' ? skills.list().map((entry) => entry?.id) : [];
      return {
        error: {
          code: RPC_ERRORS.INVALID_PARAMS,
          message: `unknown skill "${skillId}"`,
          data: { code: 'unknown_skill', skill: skillId, known },
        },
      };
    }
    const text = textOfMessage(message);
    const contextId = typeof message.contextId === 'string' && message.contextId !== '' ? message.contextId : undefined;
    const task = tasks.create({ contextId, metadata: message.metadata });
    return { task, skill, skillId, text, message, ...openCancellation({ res, taskId: task.id, skillId }) };
  }

  /**
   * Arm the two ways a skill run can be cut short: a timeout and a disconnect.
   *
   * The timeout is enforced with an independent rejection rather than relying on
   * the skill to honour its `AbortSignal` — a skill stuck in synchronous work or
   * awaiting a promise it cannot cancel would otherwise hold the task open past
   * its own deadline forever. The abort still fires so a cooperative skill can
   * wind down, but the race is what guarantees the caller is answered.
   *
   * Disconnect detection watches the *response*, not the request. `req.close`
   * also fires on a normal, fully-read request, so keying off it would abort
   * every successful call; `res.close` fires when the connection goes away, and
   * `res.writableEnded` tells us whether we had already answered.
   *
   * @param {object} input - cancellation inputs.
   * @param {object} input.res - the response, for the disconnect signal.
   * @param {string} input.taskId - task being run.
   * @param {string} input.skillId - skill being run.
   * @returns {{signal: AbortSignal, timeout: Promise<never>, cleanup: () => void}} cancellation handles.
   */
  function openCancellation({ res, taskId, skillId }) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`skill "${skillId}" exceeded the ${taskTimeoutMs} ms task timeout`);
        error.code = 'task_timeout';
        controller.abort(error);
        reject(error);
      }, taskTimeoutMs);
      timer.unref?.();
    });
    // A rejection nobody raced against must not become an unhandled rejection.
    timeout.catch(() => {});
    const onClose = () => {
      if (res?.writableEnded === true) return;
      controller.abort(new Error(`the A2A caller disconnected while task ${taskId} was running`));
    };
    res?.once?.('close', onClose);
    const cleanup = () => {
      clearTimeout(timer);
      res?.off?.('close', onClose);
    };
    return { signal: controller.signal, timeout, cleanup };
  }

  /**
   * Run one skill and normalize its result into wire artifacts.
   *
   * A skill may return a bare string (the common case), `{text, artifacts}`, or
   * `{finalState}`. Normalizing here keeps every skill free of wire vocabulary
   * and guarantees that every successful run produces at least one artifact —
   * a completed task with no artifacts looks like a bug to a peer.
   *
   * The state transition is recorded on the task *before* the caller serializes
   * it, so the `task` a unary caller receives and the `statusUpdate` a streaming
   * caller receives are the same facts read from one place.
   *
   * `context.emit` is the streaming half of the skill contract. It is offered
   * only when a stream exists; a skill that needs it (a subscription) throws
   * `not_streaming` otherwise, which is truthful — a unary call has nowhere to
   * put an unsolicited frame. `untilCancelled` is what lets a long-lived skill
   * hold its stream open without owning the timeout policy.
   *
   * @param {object} input - run inputs.
   * @param {object} input.task - task row.
   * @param {object} input.skill - registry skill.
   * @param {string} input.skillId - resolved skill id.
   * @param {string} input.text - request text.
   * @param {object} input.message - the original 1.0 message.
   * @param {AbortSignal} input.signal - cancellation and timeout.
   * @param {object|null} input.res - response, for skills that stream themselves.
   * @param {string|number|null} [input.id] - JSON-RPC id, echoed on each emitted frame.
   * @returns {Promise<{artifacts: object[], finalState: string}>} the normalized outcome.
   * @throws {Error} when the skill throws, aborts, or times out.
   */
  async function runSkill({ task, skill, skillId, text, message, signal, res, id }) {
    const streaming = res !== null && res !== undefined && typeof res.write === 'function';
    const context = {
      taskId: task.id,
      contextId: task.contextId,
      messageId: typeof message?.messageId === 'string' ? message.messageId : undefined,
      skill: skillId,
      signal,
      deliverer,
      tasks,
      logger,
      now: () => Date.now(),
      server: { card, info },
      res,
      request: { text, skill: skillId, message },
      /**
       * Stream one skill-defined event as an artifact frame.
       *
       * The artifact name carries the skill's own event name so a subscriber can
       * tell a `post` from anything else a future skill emits; the payload is a
       * single JSON text part, which is what keeps the wire shape stable no
       * matter what the skill puts inside.
       *
       * @param {string} name - skill-defined event name, e.g. `post`.
       * @param {unknown} body - event payload.
       * @returns {void}
       */
      emit: streaming
        ? (name, body) => {
            const artifact = makeArtifact({
              name: typeof name === 'string' && name !== '' ? name : 'event',
              text: typeof body === 'string' ? body : JSON.stringify(body ?? null),
            });
            writeSse(
              res,
              rpcResult(id ?? null, {
                artifactUpdate: artifactUpdate({ taskId: task.id, contextId: task.contextId, artifact, append: false, lastChunk: true }),
              }),
            );
          }
        : undefined,
      /**
       * Resolve when the caller goes away or the task deadline passes.
       *
       * Rejection is the honest outcome: a cancelled subscription was not
       * "finished", and swallowing the abort would make the skill report a
       * normal completion for work that never completed.
       *
       * @returns {Promise<never>} never resolves; rejects with the abort reason.
       */
      untilCancelled: () =>
        new Promise((_resolve, reject) => {
          if (signal === undefined || signal === null) {
            reject(new Error('this skill requires a cancellable stream'));
            return;
          }
          if (signal.aborted) {
            reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
            return;
          }
          signal.addEventListener(
            'abort',
            () => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted')),
            { once: true },
          );
        }),
    };
    let result;
    try {
      // `data` is the caller's structured payload, unwrapped from the metadata
      // envelope: the wire carries `metadata: {skill, data}`, and a skill that
      // had to reach through `.data.data` would be inventing a second shape for
      // the same idea. `metadata` is passed alongside for a skill that genuinely
      // needs the whole envelope.
      result = await skill.run(
        {
          text,
          message,
          data: isPlainObject(task.metadata?.data) ? task.metadata.data : {},
          metadata: task.metadata,
          skill: skillId,
          messageId: message?.messageId,
        },
        context,
      );
    } catch (error) {
      // A timeout or disconnect aborts the signal; report that reason rather
      // than whatever the skill happened to throw while unwinding.
      if (signal?.aborted === true && signal.reason instanceof Error) throw signal.reason;
      throw error;
    }
    // A skill that finished after its deadline must not overwrite the failure
    // the caller was already told about.
    if (signal?.aborted === true) throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
    const artifacts = normalizeArtifacts(result);
    for (const artifact of artifacts) tasks.attachArtifact(task.id, artifact);
    // A skill's structured result rides on the task's own metadata, under a key of
    // its own. It has to travel: `group/join` returns a member credential and
    // `group/read` returns entries, and neither belongs in a text artifact a model
    // would then have to parse back out. Mutated on the live task rather than
    // through `update()`, which owns state transitions and nothing else.
    if (isPlainObject(result?.meta)) {
      const live = tasks.get(task.id);
      if (live !== undefined) live.metadata = { ...(live.metadata ?? {}), result: result.meta };
    }
    const finalState = typeof result?.finalState === 'string' && result.finalState !== '' ? result.finalState : 'completed';
    tasks.update(task.id, { state: finalState });
    return { artifacts, finalState };
  }

  /**
   * Decide whether a request may call this endpoint.
   *
   * With a token configured, the token is the only gate. Without one, loopback is
   * the gate: an endpoint that silently accepts the whole LAN because an operator
   * left a field blank is the classic way this class of plugin becomes an
   * incident. The refusal names the reason (missing vs wrong credential) but
   * never echoes what was presented.
   *
   * @param {object} req - `node:http` request.
   * @returns {{ok: true} | {ok: false, reason: string}} the verdict.
   */
  function authenticate(req) {
    if (token === '') {
      if (isLoopback(req?.socket?.remoteAddress)) return { ok: true };
      return { ok: false, reason: 'this agent is bound to loopback; set config.server.token to accept remote callers' };
    }
    const presented = presentedToken(req);
    if (presented === '') return { ok: false, reason: 'missing x-api-key or Authorization: Bearer credential' };
    if (!safeEqual(presented, token)) return { ok: false, reason: 'invalid credential' };
    return { ok: true };
  }

  /** Origin provider that tolerates a webserver whose listener has not bound. */
  function originProvider() {
    const webServer = ctx?.webServer;
    if (webServer === null || typeof webServer !== 'object') return undefined;
    if (typeof webServer.getOrigin !== 'function') return undefined;
    return () => webServer.getOrigin();
  }

  /** Log a warning, scrubbing credentials out of any error detail. */
  function warn(message, error) {
    if (typeof logger?.warn !== 'function') return;
    const detail = error === undefined ? '' : `: ${scrub(errorMessage(error))}`;
    logger.warn(`dsh-a2a: ${scrub(message)}${detail}`);
  }

  return { attach, detach, card, info };
}

/**
 * Resolve the local Session an incoming A2A message is delivered to.
 *
 * `config.server.bindSessionId: 'self'` means "whichever Session owns this
 * plugin instance"; the Host exposes that through one of several properties
 * depending on generation. Returning `undefined` is a valid answer — the caller
 * decides whether that is a configuration error — so this never throws.
 *
 * @param {object} input - resolution inputs.
 * @param {object} input.ctx - Host context.
 * @param {object} input.config - normalized config.
 * @returns {string|undefined} the bound Session id.
 */
export function resolveBoundSessionId({ ctx, config } = {}) {
  const configured = typeof config?.server?.bindSessionId === 'string' ? config.server.bindSessionId.trim() : '';
  if (configured !== '' && configured !== 'self') return configured;
  // Every probe is guarded: Cordis throws on a bare read of a service the plugin
  // did not `inject`, and "which Session is this" is a best-effort question that
  // must not be able to fail a mount. A Host that exposes none of these simply has
  // no self-binding, which the caller then reports as a configuration error.
  const probe = (read) => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
  const controller = ctx?.get?.('sessionController');
  const candidates = [
    probe(() => ctx?.session?.id),
    probe(() => ctx?.agent?.id),
    probe(() => ctx?.currentSessionId),
    probe(() => (typeof controller?.currentSessionId === 'function' ? controller.currentSessionId() : undefined)),
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '') return candidate;
  }
  return undefined;
}

/**
 * Read the request body up to a hard byte ceiling.
 *
 * The ceiling is enforced while reading, not from `Content-Length`: a peer can
 * lie about the header, and buffering whatever it sends is the whole attack this
 * check exists to stop.
 *
 * @param {object} req - `node:http` request.
 * @param {number} limit - maximum bytes.
 * @returns {Promise<string>} the decoded body.
 * @throws {Error} with `code: 'body_too_large'` when the ceiling is exceeded.
 */
async function readBody(req, limit) {
  if (req === null || typeof req !== 'object') return '';
  const declared = Number(req.headers?.['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    const error = new Error('body too large');
    error.code = 'body_too_large';
    throw error;
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limit) {
      const error = new Error('body too large');
      error.code = 'body_too_large';
      throw error;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Write a JSON response, guarding against a double write when the peer left.
 * @param {object} res - `node:http` response.
 * @param {number} status - HTTP status.
 * @param {object} payload - JSON body.
 * @param {object} [headers] - extra headers.
 * @returns {void}
 */
function writeJson(res, status, payload, headers) {
  if (res === null || typeof res !== 'object') return;
  if (res.writableEnded === true || res.destroyed === true) return;
  try {
    if (res.headersSent !== true) {
      res.statusCode = status;
      res.setHeader?.('Content-Type', 'application/json; charset=utf-8');
      res.setHeader?.('Cache-Control', 'no-store');
      if (headers !== null && typeof headers === 'object') {
        for (const [key, value] of Object.entries(headers)) res.setHeader?.(key, value);
      }
    }
    res.end(JSON.stringify(payload));
  } catch {
    // The socket is gone; nothing left to report to.
  }
}

/**
 * Extract the presented credential from either accepted header.
 *
 * `Authorization: Bearer` wins when both are present because it is the standard
 * one; a caller that sets both is usually a proxy adding a header.
 *
 * @param {object} req - `node:http` request.
 * @returns {string} the credential, or `''`.
 */
function presentedToken(req) {
  const headers = req?.headers;
  if (headers === null || typeof headers !== 'object') return '';
  const apiKey = firstHeader(headers['x-api-key']);
  if (apiKey !== '') return apiKey;
  const authorization = firstHeader(headers.authorization);
  if (authorization === '') return '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match === null ? '' : match[1].trim();
}

/**
 * Read one header as a trimmed string, tolerating the array form Node uses for
 * repeated headers.
 * @param {string|string[]|undefined} value - header value.
 * @returns {string} the value, or `''`.
 */
function firstHeader(value) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === 'string' && entry.trim() !== '') return entry.trim();
    }
    return '';
  }
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Read the `A2A-Version` header, defaulting to the implied legacy version.
 * @param {object} req - `node:http` request.
 * @returns {string} the version the caller speaks.
 */
function versionOf(req) {
  const value = firstHeader(req?.headers?.[VERSION_HEADER]);
  return value === '' ? IMPLIED_LEGACY_VERSION : value;
}

/**
 * Extract the skill id from a message's metadata.
 * @param {object} message - A2A message.
 * @returns {string} the skill id, defaulting to `session/ask`.
 */
function skillIdOf(message) {
  const candidate = message?.metadata?.skill;
  if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
  return DEFAULT_SKILL;
}

/**
 * Extract a task id from either the 1.0 (`id`) or legacy (`taskId`) spelling.
 * @param {object} params - JSON-RPC params.
 * @returns {string} the task id, or `''`.
 */
function taskIdOf(params) {
  for (const key of ['id', 'taskId', 'name']) {
    const value = params?.[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return '';
}

/** Whether a method may be answered from cache semantics (read-only). */
function isReadMethod(method) {
  return method === 'GET' || method === 'HEAD';
}

/** Whether a method may carry a body. */
function isWriteMethod(method) {
  return method === 'POST';
}

/**
 * Whether an address is loopback, including the IPv4-mapped IPv6 forms Node
 * reports for a `127.0.0.1` connection on a dual-stack listener.
 * @param {string|undefined} address - `socket.remoteAddress`.
 * @returns {boolean} true when the peer is this machine.
 */
function isLoopback(address) {
  if (typeof address !== 'string' || address === '') return false;
  const value = address.trim().toLowerCase();
  if (value === '::1' || value === '::ffff:127.0.0.1' || value === '0:0:0:0:0:0:0:1') return true;
  const match = /^(?:\.)?(?:ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (match !== null) return Number(match[1]) === 127;
  return false;
}

/** Read the request pathname without a URL parse (the Host may have rewritten it). */
function pathOf(req) {
  const raw = typeof req?.url === 'string' ? req.url : '';
  const cut = raw.split('?')[0];
  return cut === '' ? '/' : cut;
}

/**
 * Classify a thrown value into a JSON-RPC error.
 *
 * A skill that wants a specific A2A code raises an error with a string `code`
 * from the contract's table; everything else is an internal failure. Returning
 * `-32004` with `data.code` is what lets a caller distinguish "you are over your
 * post budget" from "this plugin crashed", without parsing prose.
 *
 * @param {unknown} error - the thrown value.
 * @returns {{code: number, message: string, data: object}} the JSON-RPC error fields.
 */
function classify(error) {
  const message = errorMessage(error);
  const raw = typeof error?.code === 'string' ? error.code : '';
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    return { code: RPC_ERRORS.INTERNAL, message, data: { code: 'aborted' } };
  }
  // A deadline or a disconnect is this Host's failure, not a business refusal;
  // the stable sub-code still tells the peer it may retry.
  if (raw === 'task_timeout' || raw === 'aborted') {
    return { code: RPC_ERRORS.INTERNAL, message, data: { code: raw } };
  }
  if (raw !== '') {
    return { code: RPC_ERRORS.REJECTED, message, data: { code: raw } };
  }
  if (typeof error?.status === 'number' && error.status === 401) {
    return { code: RPC_ERRORS.UNAUTHENTICATED, message, data: { code: 'unauthenticated' } };
  }
  return { code: RPC_ERRORS.INTERNAL, message: message === '' ? 'skill execution failed' : message, data: { code: 'internal' } };
}

/** Render a thrown value as a message string. */
function errorMessage(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error === null || error === undefined) return '';
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Normalize whatever a skill returned into wire artifact values.
 *
 * Skills are ordinary code, often written by another branch of this project, so
 * the accepted shapes are generous: a bare string, `{text}`, `{artifacts: [...]}`
 * with either pre-built parts or a `text` field. The one rule enforced here is
 * that a successful run yields at least one artifact — an empty `artifacts` array
 * on a completed task reads as a silent failure to every A2A client.
 *
 * @param {unknown} result - value returned by `skill.run()`.
 * @returns {object[]} zero or more artifact values.
 */
function normalizeArtifacts(result) {
  const artifacts = [];
  if (typeof result === 'string') {
    if (result !== '') artifacts.push(makeArtifact({ name: 'reply', text: result }));
    return artifacts;
  }
  if (result === null || typeof result !== 'object') return artifacts;
  const declared = Array.isArray(result.artifacts) ? result.artifacts : [];
  for (const entry of declared) {
    if (entry === null || typeof entry !== 'object') continue;
    if (typeof entry.artifactId === 'string' && entry.artifactId !== '' && Array.isArray(entry.parts)) {
      artifacts.push(entry);
      continue;
    }
    artifacts.push(
      makeArtifact({
        artifactId: typeof entry.artifactId === 'string' ? entry.artifactId : undefined,
        name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : 'reply',
        parts: Array.isArray(entry.parts) ? entry.parts : undefined,
        text: typeof entry.text === 'string' ? entry.text : '',
      }),
    );
  }
  if (artifacts.length === 0 && typeof result.text === 'string' && result.text !== '') {
    artifacts.push(makeArtifact({ name: typeof result.name === 'string' && result.name !== '' ? result.name : 'reply', text: result.text }));
  }
  return artifacts;
}

/**
 * Mask credential-looking `key=value` or `key: value` pairs in a log line.
 *
 * Server-side logging is the last place a token can escape: an upstream error
 * message, a skill's own error, or a misconfigured card all flow through here.
 * @param {string} text - candidate log text.
 * @returns {string} text with secrets replaced by a short digest.
 */
function scrub(text) {
  return redactAll(String(text ?? ''), [process.env?.A2A_LOG_SECRET]);
}

/** Coerce a config number into a positive integer, falling back on nonsense. */
function positiveInt(value, fallback) {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

/**
 * Whether a value is a plain JSON object (not an array, not null).
 *
 * Used to decide whether a caller's `metadata.data` is structured input or
 * absent: an array or a primitive there is a client mistake, and passing it
 * through as `data` would make every skill re-check the same thing.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read the layer B profile, tolerating a provider that fails.
 *
 * A card is how a peer discovers what this agent can do; losing the whole card
 * because the identity aggregation hit a corrupt file would be the wrong trade.
 * A failed read therefore degrades to "no profile", which the card renders as its
 * default name and description.
 *
 * @param {(() => object)|undefined} provider - returns the profile, or undefined.
 * @returns {object|undefined} the profile, or undefined.
 */
function readProfile(provider) {
  if (typeof provider !== 'function') return undefined;
  try {
    const value = provider();
    return value === null || value === undefined ? undefined : value;
  } catch {
    return undefined;
  }
}