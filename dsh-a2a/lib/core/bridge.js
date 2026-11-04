/**
 * A2A 1.0 客户端（bridge）：发现对端、发一条消息、订阅一条流。
 *
 * ## 这个文件解决什么问题
 *
 * 把「一个对端地址 + 一把可选凭证」收敛成三个动作：
 *   - `discover(target)` —— 我能不能调它、它自称能干什么（Agent Card，带 TTL 缓存）；
 *   - `send(target, input)` —— 一问一答（JSON-RPC `SendMessage`），拿回任务结论；
 *   - `stream(target, input)` —— 订阅或长任务进度（`SendStreamingMessage`，SSE）。
 * 上层（工具层、群订阅器）只跟这三个动作打交道，不必知道 JSON-RPC 信封、SSE 分帧，
 * 或 AISIX 网关对卡片 url 的改写行为。
 *
 * ## 边界（明确不做的事）
 *
 * - **不含任何 DSH 概念**：不碰 Session、不碰磁盘，只 `import node:*`，绝不 import
 *   `@deepseek-ai/*` 或第三方包（CONTRACT §0.1：插件由普通 Node 解析加载，bare
 *   specifier 解析不到 DSH 安装目录）。
 * - **不持有任务真相**：任务状态在对端，本模块只把这一次的结论回给调用方。
 * - **只在「这条流本来就可续」时重连**：调用方给了 `sinceSeq` 才算可续；否则重连
 *   等于把同样的事件再投一遍，对群的收件人就是重复消息。
 *
 * ## 为什么总是 POST 到 `baseUrl`，而不是卡片里的 `url`
 *
 * AISIX 网关在自己没收到 `X-Forwarded-Proto` 时会假设前面有 TLS 终结器，于是把卡片
 * 里的 `url` 写成 `https://<host>:<port>/a2a/<agent>`，而本地联调实际是 `http`。
 * 卡片 url 是「对端自我描述」，`baseUrl` 是「调用方实测可达的地址」；两者冲突时用
 * `baseUrl` 并 warn 一次——否则会掉进「卡片取得到、消息发不出去」这个最费时间的坑。
 *
 * @module dsh-a2a/bridge
 */

import { createHash, randomUUID } from 'node:crypto';

/** 我们唯一实现的 A2A 线格式版本（CONTRACT §1：显式 1.0，不猜）。 */
export const A2A_VERSION = '1.0';

/** 线上 skill 的缺省值：把文本投进对端绑定的会话并等这一回合结束。 */
export const DEFAULT_SKILL = 'session/ask';

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_CARD_TTL_MS = 300000;
const DEFAULT_RECONNECT_ATTEMPTS = 3;

/**
 * 重连退避的起点与上限。
 *
 * 250ms 起步足够让「网关刚重启」「网络瞬断」这种秒级抖动自愈，又不会让调用方
 * 在演示时盯着一个不动的界面太久；上限 8s 避免多试图叠加成几十秒的空等。
 */
const RECONNECT_BASE_DELAY_MS = 250;
const RECONNECT_MAX_DELAY_MS = 8000;

/** 错误正文只留这么多：够定位问题，又不会把整页 HTML 错误页灌进日志。 */
const MAX_ERROR_BODY_CHARS = 400;

/** 线上状态枚举名前缀（protobuf JSON 的枚举名）。 */
const WIRE_STATE_PREFIX = 'TASK_STATE_';

/**
 * 可以合法结束一条流的状态。
 *
 * A2A 用 `final:true` 标记流结束，但那个标记要跟状态**对上**：`submitted` / `working`
 * 的帧声称自己是最后一帧，是自相矛盾的（真实见过：把 `final` 算成
 * `state !== 'WORKING'` 的实现，会让第一帧 `submitted` 就带上 `final:true`）。
 * 遇到这种帧不能就这么收线——否则一条正常的流会在第一帧后静默截断。
 *
 * `input_required` / `auth_required` 也在里面：它们表示「这一轮到此为止，等调用方
 * 补充信息」，流确实该结束。
 */
const TERMINAL_STATES = new Set([
  'completed',
  'canceled',
  'failed',
  'rejected',
  'input_required',
  'auth_required',
]);

/**
 * JSON-RPC 错误码 → 我们的一级分类（CONTRACT §1 的错误码表）。
 *
 * 只映射「调用方能自救」的那三个：认证没带对可以去补 key，权限不对得找管理员开
 * ACL，版本不对得改配置。其余（-326xx 与 -32004）都是对端或业务层面的拒绝，归 rpc。
 */
const RPC_ERROR_KINDS = new Map([
  [-32001, 'auth'],
  [-32002, 'permission'],
  [-32003, 'version'],
]);

/**
 * `onEvent` 自己抛的异常的包装。
 *
 * 存在的唯一理由：把它和「网络断了」区分开。网络错误可以重连，调用方的回调错误
 * 不能——重连会把事件再投一遍。类放在这里（而不是 bridge 内部）是因为 `once()`
 * 里要用 `instanceof` 判断。
 */
class EventDeliveryError extends Error {
  /** @param {unknown} cause - 调用方回调抛出的原始异常。 */
  constructor(cause) {
    super('the onEvent callback threw', { cause });
    this.name = 'EventDeliveryError';
  }
}

/**
 * 一次 A2A 客户端失败。
 *
 * `kind` 是预先分好类的动作提示，调用方据此决定「补凭证 / 找管理员 / 改配置 / 重试 /
 * 把错误原文回给模型」，而不是去匹配 error message 的字符串。
 */
export class A2aClientError extends Error {
  /**
   * @param {'auth'|'permission'|'version'|'network'|'rpc'} kind - 一级分类。
   * @param {string} message - 面向人的说明（**绝不包含明文凭证**）。
   * @param {object} [detail] - 结构化细节。
   * @param {number|string} [detail.code] - JSON-RPC 错误码，或稳定的子码（如 `aborted`、`bad_target`）。
   * @param {number} [detail.status] - HTTP 状态码（若有）。
   * @param {string} [detail.data] - 错误正文摘录（已截断）。
   * @param {unknown} [detail.cause] - 原始异常，便于上层打日志。
   */
  constructor(kind, message, detail = {}) {
    super(message, detail.cause === undefined ? undefined : { cause: detail.cause });
    this.name = 'A2aClientError';
    this.kind = kind;
    this.code = detail.code;
    this.status = detail.status;
    this.data = detail.data;
  }

  /**
   * 结构化输出（日志 / 工具返回值用）。
   * @returns {{kind: string, code: (number|string|undefined), status: (number|undefined), message: string}}
   */
  toJSON() {
    return { kind: this.kind, code: this.code, status: this.status, message: this.message };
  }
}

/**
 * 把凭证压成 `sha256:前8位`，只用于日志与错误信息（CONTRACT §0.6）。
 *
 * 用哈希而不是 `***` 的原因是：出问题时能比对「两边是不是同一把 key」，
 * 又不把明文写进任何持久化产物。
 *
 * @param {unknown} value - 明文凭证。
 * @returns {string} 可直接进日志的短标识；空值返回空串。
 */
export function maskSecret(value) {
  if (typeof value !== 'string' || value === '') return '';
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 8)}`;
}

/* -------------------------------------------------------------------------- */
/* 小工具                                                                      */
/* -------------------------------------------------------------------------- */

/** 取字符串，非字符串一律当空。 */
function str(value) {
  return typeof value === 'string' ? value : '';
}

/** 取有限数字，否则用兜底值。 */
function num(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

/** 去掉末尾斜杠；`baseUrl` 拼路径时不能出现 `//`。 */
function trimSlash(value) {
  return String(value).replace(/\/+$/, '');
}

/**
 * 从线格式状态名得到内部小写状态：`TASK_STATE_WORKING` → `working`。
 *
 * 内部统一小写，是为了让上层（工具输出、群面板）不用记住 protobuf 的命名习惯；
 * 反向转换由服务端的 `wire.js` 负责，客户端不重复那一半。
 *
 * @param {unknown} wire - 线格式状态名。
 * @returns {string} 内部状态名；未知返回 `'unknown'`。
 */
function fromWireState(wire) {
  if (typeof wire !== 'string' || wire === '') return 'unknown';
  const bare = wire.startsWith(WIRE_STATE_PREFIX) ? wire.slice(WIRE_STATE_PREFIX.length) : wire;
  return bare.toLowerCase() || 'unknown';
}

/** 线格式状态名（回传给 `stream` 的调用方，便于直接对照协议）。 */
function toWireState(state) {
  return `${WIRE_STATE_PREFIX}${String(state).toUpperCase()}`;
}

/** 拼 `parts[]` 里的文本；非文本 part（未来可能有 file/data）直接跳过。 */
function textOfParts(parts) {
  if (!Array.isArray(parts)) return '';
  return parts
    .map((part) => (part !== null && typeof part === 'object' && typeof part.text === 'string' ? part.text : ''))
    .filter((text) => text !== '')
    .join('\n');
}

/**
 * 客户端配置：一元调用、流式重连与卡片缓存共用的那一组旋钮。
 *
 * 单独命名，是因为 `readClientConfig()` 允许调用方直接传 `client` 段——单测和
 * 「只关心客户端」的调用方不必伪造整个配置对象。写成 union 就是把这条已经存在
 * 的运行时判断（`typeof config.client === 'object'`）说清楚。
 *
 * @typedef {object} BridgeClientConfig
 * @property {string} [apiKey] - 上游网关的 Key，一人一把。
 * @property {string} [protocolVersion] - 默认 1.0。
 * @property {string} [forwardProto] - 联调 http 时填 http。
 * @property {number} [cardTtlMs] - 卡片缓存时长。
 * @property {number} [timeoutMs] - 一元调用超时。
 * @property {number} [reconnectAttempts] - 流式断线重试次数。
 */

/**
 * `readClientConfig()` 接受的两种形状，合并成一个类型。
 *
 * 写成 `{client?: ...} & BridgeClientConfig` 而不是 union：union 会让「有 client」
 * 那一支上读 `apiKey` 不合法、另一支上读 `client` 不合法，而函数本身是两者都读、
 * 再按运行时判断取舍。类型跟着真实判断走，才不需要在多处重复收窄。
 *
 * @typedef {object} BridgeConfigInput
 * @property {BridgeClientConfig} [client] - 完整配置里的 client 段。
 * @property {string} [apiKey]
 * @property {string} [protocolVersion]
 * @property {string} [forwardProto]
 * @property {number} [cardTtlMs]
 * @property {number} [timeoutMs]
 * @property {number} [reconnectAttempts]
 */

/**
 * 一个 A2A 1.0 任务对象，本模块真正会读的那几个字段。
 *
 * 只列读到的字段而非完整 schema：这样「这里读了一个上游不会给的字段」会变成
 * 类型错误，而不是安静地拿到 undefined 再退回空文本。
 *
 * @typedef {object} BridgeTask
 * @property {string} [id]
 * @property {string} [contextId]
 * @property {BridgeTaskStatus} [status]
 * @property {BridgeArtifact[]} [artifacts]
 * @property {object} [metadata]
 */

/**
 * @typedef {object} BridgeTaskStatus
 * @property {string} [state] - `TASK_STATE_*`。
 * @property {object} [message] - 状态附带的说明消息。
 * @property {string|number} [timestamp]
 */

/**
 * @typedef {object} BridgeArtifact
 * @property {string} [artifactId]
 * @property {string} [name]
 * @property {Array<{kind: string, text?: string}>} [parts]
 */
/**
 * 从一个任务里取「这次答复」的文本。
 *
 * 优先取 `name === 'reply'` 的 artifact：群技能一次可能回多个 artifact（`posted`、
 * `feed`、`members`…），`reply` 是约定的「给人看的那段」，其余是给程序读的结构。
 *
 * @param {BridgeTask} task - A2A 任务对象。
 * @returns {string} 文本；没有 artifact 时退回任务状态消息里的文本。
 */
function textOfTask(task) {
  const artifacts = Array.isArray(task?.artifacts) ? task.artifacts : [];
  const preferred = artifacts.find((artifact) => artifact?.name === 'reply') ?? artifacts[0];
  if (preferred !== undefined) return textOfParts(preferred.parts);
  return textOfParts(task?.status?.message?.parts);
}

/** 从一个事件里尽量找出 feed 的 `seq`，供重连时作 `sinceSeq`。 */
function seqOfEvent(result) {
  const candidates = [
    result?.artifactUpdate?.artifact?.metadata?.seq,
    result?.artifactUpdate?.metadata?.seq,
    result?.artifactUpdate?.seq,
    result?.statusUpdate?.metadata?.seq,
    result?.statusUpdate?.seq,
    result?.metadata?.seq,
    result?.seq,
  ];
  let best;
  for (const candidate of candidates) {
    if (Number.isFinite(candidate)) best = best === undefined ? candidate : Math.max(best, candidate);
  }
  return best;
}

/** 可被 abort 打断的等待。 */
function sleep(ms, signal) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new A2aClientError('network', 'aborted while waiting to reconnect', { code: 'aborted' }));
    }
    if (signal?.aborted === true) {
      clearTimeout(timer);
      reject(new A2aClientError('network', 'aborted while waiting to reconnect', { code: 'aborted' }));
      return;
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/* -------------------------------------------------------------------------- */
/* SSE 解析                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 增量 SSE 解析器：喂任意切分的文本，吐出**完整**的 `data` 帧。
 *
 * 为什么需要它：SSE 的一帧可能在任意字节位置被 TCP/网关切开（实测 `data: {"result":`
 * 与 `{"task":…}}` 分成两个 chunk 到达），所以不能「每读到一块就 JSON.parse」。
 * 这里只做分帧，不解释内容：把「一帧」的字符串交给回调，帧内是什么由调用方决定。
 *
 * 按 SSE 规范处理：
 *   - 空行才是帧分隔符；`\n` 与 `\r\n` 都认（先剥行尾 `\r`）；
 *   - `data:` 可多行，用 `\n` 拼（多行 JSON 是合法 SSE）；
 *   - `:` 开头是注释（网关心跳），忽略但不能当成空帧，否则心跳会把半帧提前截断；
 *   - 其它字段（`event:` / `id:` / `retry:`）忽略，不参与拼装；
 *   - `flush()` 把末帧交出去：有的网关发完最后一个 `data:` 直接 `end()`，不带空行。
 *
 * @param {(payload: string) => void} onFrame - 收到一个完整帧的 `data` 载荷。
 * @returns {{push: (chunk: string) => void, flush: () => void}} 增量写入接口。
 */
export function createSseParser(onFrame) {
  let buffer = '';
  let dataLines = [];

  function dispatch() {
    if (dataLines.length === 0) return;
    const payload = dataLines.join('\n');
    dataLines = [];
    onFrame(payload);
  }

  function consumeLine(rawLine) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') {
      dispatch();
      return;
    }
    if (line.startsWith(':')) return; // 心跳注释
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') dataLines.push(value);
  }

  return {
    push(chunk) {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const rawLine = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        consumeLine(rawLine);
        index = buffer.indexOf('\n');
      }
    },
    flush() {
      if (buffer !== '') {
        const rawLine = buffer;
        buffer = '';
        consumeLine(rawLine);
      }
      dispatch();
    },
  };
}

/* -------------------------------------------------------------------------- */
/* 请求构造                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 读取客户端配置（每次调用现读，让设置页改动立即生效）。
 *
 * 允许直接把 `client` 段传进来：这样单测和「只关心客户端」的调用方不必伪造整个
 * 配置对象。
 *
 * @param {BridgeConfigInput} config - `normalizeConfig()` 的产物，或其 `client` 段。
 * @returns {{apiKey: string, protocolVersion: string, forwardProto: string, cardTtlMs: number, timeoutMs: number, reconnectAttempts: number}}
 */
function readClientConfig(config) {
  const section = config !== null && typeof config === 'object' && config.client !== null && typeof config.client === 'object'
    ? config.client
    : (config !== null && typeof config === 'object' ? config : {});
  return {
    apiKey: str(section.apiKey),
    protocolVersion: str(section.protocolVersion) || A2A_VERSION,
    forwardProto: str(section.forwardProto),
    cardTtlMs: Math.max(0, num(section.cardTtlMs, DEFAULT_CARD_TTL_MS)),
    timeoutMs: Math.max(0, num(section.timeoutMs, DEFAULT_TIMEOUT_MS)),
    reconnectAttempts: Math.max(0, Math.trunc(num(section.reconnectAttempts, DEFAULT_RECONNECT_ATTEMPTS))),
  };
}

/**
 * 一个对端目标：要么是网关里的 agent，要么是直连的 A2A 端点。
 *
 * 只有 `baseUrl` 必填——其余三项目标里不给就继承客户端配置。把「哪些必须由
 * 调用方提供」写进类型，比在错误信息里补一句更容易被发现。
 *
 * @typedef {object} BridgeTarget
 * @property {string} baseUrl - `http://gw:3000/a2a/<agent>` 或 `http://host:3091/a2a`。
 * @property {string} [agent] - 网关里的 agent 名，拼在 baseUrl 后面。
 * @property {string} [apiKey] - 覆盖客户端配置里的 Key。
 * @property {string} [protocolVersion] - 覆盖客户端配置里的版本。
 * @property {string} [forwardProto] - 覆盖客户端配置里的 X-Forwarded-Proto。
 */

/**
 * `send()` 的入参。
 *
 * @typedef {object} BridgeSendInput
 * @property {string} [skill] - `metadata.skill`，缺省 `session/ask`。
 * @property {string} [text] - 消息正文。
 * @property {object} [data] - 结构化参数，进 `metadata.data`。
 * @property {string} [contextId] - 续接已有的 A2A 上下文。
 * @property {number} [timeoutMs] - 覆盖客户端超时。
 * @property {string} [from] - 调用方标识，进 `metadata.from`。
 */

/**
 * `stream()` 的入参：在一元入参之上多了订阅位置与取消。
 *
 * @typedef {object} BridgeStreamInput
 * @property {string} [skill]
 * @property {string} [text]
 * @property {object} [data]
 * @property {string} [contextId]
 * @property {number} [sinceSeq] - 断线重连时的续读位置。
 * @property {AbortSignal} [signal] - 取消订阅。
 * @property {(event: object) => void} [onEvent] - 每帧回调。
 * @property {number} [timeoutMs]
 * @property {string} [from]
 */

/**
 * 规范化一个 target。
 *
 * `baseUrl` 是唯一必填项。`agent` 可以单独给：网关的基址是 `…/a2a`，具体 agent 是
 * 路径段，登记簿里两者分开存更省事，这里负责拼起来（已经带上了就不重复拼）。
 *
 * @param {BridgeTarget} raw - 调用方给的 target。
 * @param {ReturnType<typeof readClientConfig>} cfg - 客户端配置。
 * @returns {{baseUrl: string, agent: string, apiKey: string, protocolVersion: string, forwardProto: string}}
 * @throws {A2aClientError} `baseUrl` 缺失或不是合法 URL 时（kind `'rpc'`，属于调用方用法错误）。
 */
function normalizeTarget(raw, cfg) {
  const baseUrl = trimSlash(str(raw?.baseUrl));
  if (baseUrl === '') {
    throw new A2aClientError('rpc', 'a target baseUrl is required (e.g. http://host:3091/a2a)', { code: 'bad_target' });
  }
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new A2aClientError('rpc', `target baseUrl is not a valid URL: ${baseUrl}`, { code: 'bad_target' });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new A2aClientError('rpc', `target baseUrl must be http(s): ${baseUrl}`, { code: 'bad_target' });
  }
  const agent = str(raw?.agent).trim();
  return {
    baseUrl,
    agent,
    apiKey: str(raw?.apiKey) || cfg.apiKey,
    protocolVersion: str(raw?.protocolVersion) || cfg.protocolVersion,
    forwardProto: str(raw?.forwardProto) || cfg.forwardProto,
  };
}

/**
 * JSON-RPC 端点的实际地址：基址 + 可选的 agent 路径段。
 *
 * @param {ReturnType<typeof normalizeTarget>} target - 规范化后的 target。
 * @returns {string} 可 POST 的 URL。
 */
function endpointOf(target) {
  if (target.agent === '') return target.baseUrl;
  const suffix = `/${encodeURIComponent(target.agent)}`;
  return target.baseUrl.endsWith(suffix) ? target.baseUrl : `${target.baseUrl}${suffix}`;
}

/**
 * 请求头。
 *
 * 三个头都是必需的，各自解决一个真实问题：
 *   - `A2A-Version` 缺省会被对端按 0.3 理解（方法名就变成小写管道），所以每次都带；
 *   - `x-api-key` 是 AISIX 的门禁；
 *   - `X-Forwarded-Proto` 决定网关把卡片里的 url 写成 http 还是 https，本地联调
 *     不带它就会出现「卡片 url 是 https、实际是 http」的偏差。
 *
 * @param {ReturnType<typeof normalizeTarget>} target - 规范化后的 target。
 * @param {'json'|'sse'} mode - 期望的响应类型。
 * @returns {Record<string, string>} 请求头。
 */
function headersOf(target, mode) {
  const headers = {
    'content-type': 'application/json',
    accept: mode === 'sse' ? 'text/event-stream, application/json' : 'application/json',
    'A2A-Version': target.protocolVersion,
  };
  if (target.apiKey !== '') headers['x-api-key'] = target.apiKey;
  if (target.forwardProto !== '') headers['X-Forwarded-Proto'] = target.forwardProto;
  return headers;
}

/**
 * 造 1.0 的信封（CONTRACT §1 的 `params.message` 形状）。
 *
 * `data` 放在 `message.metadata.data` 而不是铺平进 `metadata`：`metadata` 里已经有
 * `skill` 这个协议级字段，业务载荷单独一层才不会跟未来的协议字段撞名。
 * 文本为空时不造 text part——`group/subscribe` 这类「只要流、不带话」的调用本来
 * 就没有正文，塞一个空 part 会让对端的校验器犯难。
 *
 * @param {object} options - 信封参数。
 * @param {string} options.method - `SendMessage` 或 `SendStreamingMessage`。
 * @param {object} options.input - `send`/`stream` 的入参。
 * @param {number} [options.sinceSeq] - 断点续传位置（仅流式）。
 * @returns {object} 可直接 `JSON.stringify` 的 JSON-RPC 请求体。
 */
function buildEnvelope({ method, input, sinceSeq }) {
  const skill = str(input?.skill).trim() || DEFAULT_SKILL;
  const metadata = { skill };

  const data = { ...(input?.data !== null && typeof input?.data === 'object' ? input.data : {}) };
  // sinceSeq 是「续到哪」而不是业务数据，但它是这次调用的入参，跟着 data 走对端才读得到。
  if (sinceSeq !== undefined && sinceSeq !== null) data.sinceSeq = sinceSeq;
  if (Object.keys(data).length > 0) metadata.data = data;

  const message = {
    role: 'user',
    messageId: randomUUID(),
    parts: [],
    metadata,
  };
  const text = str(input?.text);
  if (text !== '') message.parts.push({ kind: 'text', text });
  if (str(input?.contextId) !== '') message.contextId = str(input.contextId);

  return { jsonrpc: '2.0', id: randomUUID(), method, params: { message } };
}

/* -------------------------------------------------------------------------- */
/* 错误归类                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 把 HTTP 状态码归类。
 *
 * 401/403 分开是因为处置方式完全不同：401 是「补 key / 换 key」，403 是「找管理员
 * 开 allowed_agents 的 ACL」。合成一个 auth 会让人白换一遍 key。
 *
 * @param {Response} response - fetch 响应。
 * @param {string} url - 请求地址（不含凭证，可安全进错误信息）。
 * @returns {Promise<A2aClientError>} 归类后的错误。
 */
async function httpErrorOf(response, url) {
  let body = '';
  try {
    body = (await response.text()).slice(0, MAX_ERROR_BODY_CHARS);
  } catch {
    body = '';
  }
  const status = response.status;
  const suffix = body === '' ? '' : ` — ${body}`;
  if (status === 401) {
    return new A2aClientError('auth', `upstream rejected the credential (HTTP 401 from ${url})${suffix}`, { status, code: 401, data: body });
  }
  if (status === 403) {
    return new A2aClientError('permission', `upstream denied this caller (HTTP 403 from ${url})${suffix}`, { status, code: 403, data: body });
  }
  return new A2aClientError('rpc', `upstream returned HTTP ${status} from ${url}${suffix}`, { status, code: status, data: body });
}

/**
 * 把 JSON-RPC 的 `error` 归类。
 *
 * @param {object} error - 响应里的 `error` 对象。
 * @param {string} url - 请求地址。
 * @returns {A2aClientError} 归类后的错误。
 */
function rpcErrorOf(error, url) {
  const code = Number.isFinite(error?.code) ? error.code : undefined;
  const kind = RPC_ERROR_KINDS.get(code) ?? 'rpc';
  const detail = str(error?.message) || 'unspecified JSON-RPC error';
  const business = str(error?.data?.code);
  const where = url === '' ? 'upstream' : `upstream ${url}`;
  return new A2aClientError(kind, `${where} rejected the call: ${detail} (code ${code ?? '?'}${business === '' ? '' : `, ${business}`})`, {
    code,
    data: business === '' ? undefined : business,
  });
}

/**
 * 把 fetch 抛出的异常归一成 network 类。
 *
 * 超时与主动取消要分开：前者值得重试，后者是调用方自己不想等了，重试是错的。
 *
 * @param {unknown} err - fetch 抛出的异常。
 * @param {string} url - 请求地址。
 * @returns {A2aClientError} 归类后的错误。
 */
function networkErrorOf(err, url) {
  const name = err?.name;
  if (name === 'TimeoutError') {
    return new A2aClientError('network', `request to ${url} timed out`, { code: 'timeout', cause: err });
  }
  if (name === 'AbortError') {
    return new A2aClientError('network', `request to ${url} was aborted by the caller`, { code: 'aborted', cause: err });
  }
  const cause = err?.cause;
  const detail = cause?.code ?? cause?.message ?? err?.message ?? 'unknown error';
  return new A2aClientError('network', `cannot reach ${url}: ${detail}`, { code: typeof cause?.code === 'string' ? cause.code : undefined, cause: err });
}

/* -------------------------------------------------------------------------- */
/* bridge                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 造一个 A2A 客户端。
 *
 * 一个实例持有一份卡片缓存。缓存放在实例上（而不是模块级）是为了让「多套配置」与
 * 单测互不串味：`invalidate()` 清掉的必须只是自己这份。
 *
 * @param {object} options - 依赖注入。
 * @param {{warn?: Function, info?: Function, debug?: Function, error?: Function}} [options.logger] - 日志器（可缺省，缺省静默）。
 * @param {object} [options.config] - `normalizeConfig()` 的产物。
 * @param {() => number} [options.clock] - 时钟注入，单测用来快进 TTL。
 * @returns {{
 *   discover: (target: object) => Promise<object>,
 *   send: (target: object, input?: object) => Promise<object>,
 *   stream: (target: object, input?: object) => Promise<object>,
 *   invalidate: (target: object|string) => void,
 *   invalidateAll: () => void
 * }}
 */
export function createBridge({ logger, config, clock } = {}) {
  const now = typeof clock === 'function' ? clock : () => Date.now();
  /** @type {Map<string, {card: object, at: number}>} */
  const cards = new Map();
  /** 同一组 (baseUrl, agent, cardUrl) 的偏差只提醒一次，避免每条消息刷一行日志。 */
  const warned = new Set();

  function cfg() {
    return readClientConfig(config);
  }

  function warn(message) {
    if (typeof logger?.warn === 'function') logger.warn(`[a2a-bridge] ${message}`);
  }

  function cacheKeyOf(target) {
    return target.agent === '' ? target.baseUrl : `${target.baseUrl}#${target.agent}`;
  }

  /**
   * 卡片 url 与配置 baseUrl 冲突时的收敛。
   *
   * 只处理一种偏差：对端声称 https、我们用的是 http 且主机相同（AISIX 在缺
   * `X-Forwarded-Proto` 时的典型表现）。主机都不一样的「偏差」不猜：那可能是网关
   * 改写成了对外域名，我们无权替它改，只 warn。
   *
   * @param {object} card - 上游给的卡片。
   * @param {ReturnType<typeof normalizeTarget>} target - 规范化后的 target。
   * @returns {object} 修正后的卡片（`url` 指向真正能用的地址）。
   */
  function reconcileCard(card, target) {
    const cardUrl = str(card?.url);
    if (cardUrl === '') return card;
    let claimed;
    try {
      claimed = new URL(cardUrl);
    } catch {
      return card;
    }
    let actual;
    try {
      actual = new URL(endpointOf(target));
    } catch {
      return card;
    }
    if (cardUrl === target.baseUrl) return card;

    const schemeOnly = claimed.protocol === 'https:' && actual.protocol === 'http:' && claimed.hostname === actual.hostname;
    const marker = `${target.baseUrl}|${cardUrl}`;
    if (!schemeOnly) {
      if (!warned.has(marker)) {
        warned.add(marker);
        warn(`agent card claims url=${cardUrl}, but baseUrl=${target.baseUrl} is what we will call; keeping baseUrl`);
      }
      return card;
    }
    if (!warned.has(marker)) {
      warned.add(marker);
      warn(`agent card claims url=${cardUrl} (https) while baseUrl=${target.baseUrl} is http; `
        + 'following baseUrl — set client.forwardProto="http" so the gateway advertises the right scheme');
    }
    return { ...card, url: target.baseUrl };
  }

  /**
   * 取对端 Agent Card（带 TTL 缓存）。
   *
   * @param {object} rawTarget - `{baseUrl, agent?, apiKey?, protocolVersion?, forwardProto?}`。
   * @returns {Promise<object>} 卡片对象（`url` 已按实际可达地址收敛）。
   * @throws {A2aClientError} 凭证/权限/网络/协议错误。
   */
  async function discover(rawTarget) {
    const options = cfg();
    const target = normalizeTarget(rawTarget, options);
    const key = cacheKeyOf(target);
    const cached = cards.get(key);
    if (cached !== undefined && now() - cached.at < options.cardTtlMs) {
      return cached.card;
    }

    const url = `${endpointOf(target)}/.well-known/agent-card.json`;
    let response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: headersOf(target, 'json'),
        signal: AbortSignal.timeout(options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      throw networkErrorOf(err, url);
    }
    if (!response.ok) throw await httpErrorOf(response, url);

    const text = await response.text();
    let card;
    try {
      card = JSON.parse(text);
    } catch {
      throw new A2aClientError('rpc', `agent card at ${url} is not valid JSON`, { data: text.slice(0, MAX_ERROR_BODY_CHARS) });
    }
    if (card === null || typeof card !== 'object') {
      throw new A2aClientError('rpc', `agent card at ${url} is not a JSON object`);
    }

    const declared = str(card.protocolVersion);
    if (declared !== '' && declared !== target.protocolVersion) {
      warn(`agent card declares protocolVersion=${declared} but this client speaks ${target.protocolVersion}`);
    }

    const reconciled = reconcileCard(card, target);
    cards.set(key, { card: reconciled, at: now() });
    return reconciled;
  }

  /**
   * 发一条消息并等结论（JSON-RPC `SendMessage`）。
   *
   * HTTP 超时的取法：显式 `input.timeoutMs` 优先；否则若技能自己带了 `data.timeoutMs`
   * 预算（`session/ask` 会带），就比它多留 5s——否则会出现「对端还在干活、客户端先
   * 超时」这种假失败；都没有才用 `config.client.timeoutMs`。
   *
   * @param {object} rawTarget - target。
   * @param {object} [input] - `{skill, text, data, contextId, timeoutMs}`。
   * @returns {Promise<{taskId: string|undefined, state: string, wireState: string, text: string, contextId: string|undefined, artifacts: Array<object>, raw: object}>}
   * @throws {A2aClientError} 凭证/权限/版本/网络/JSON-RPC 错误。
   */
  async function send(rawTarget, input = {}) {
    const options = cfg();
    const target = normalizeTarget(rawTarget, options);
    const url = endpointOf(target);
    const envelope = buildEnvelope({ method: 'SendMessage', input, sinceSeq: undefined });

    const ownBudget = Number.isFinite(input?.data?.timeoutMs) ? input.data.timeoutMs : undefined;
    const timeoutMs = Number.isFinite(input?.timeoutMs)
      ? input.timeoutMs
      : (ownBudget === undefined ? options.timeoutMs : ownBudget + 5000);

    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: headersOf(target, 'json'),
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      throw networkErrorOf(err, url);
    }
    if (!response.ok) throw await httpErrorOf(response, url);

    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new A2aClientError('rpc', `upstream ${url} returned a non-JSON body`, { data: text.slice(0, MAX_ERROR_BODY_CHARS) });
    }
    if (body?.error !== undefined && body.error !== null) throw rpcErrorOf(body.error, url);

    const result = body?.result ?? {};
    const task = result.task;
    const message = result.message;
    // `result.task` 是一元主路径；`result.message` 是「对端直接回话、还没成任务」的兼容路径。
    const state = task !== undefined ? fromWireState(task?.status?.state) : 'completed';
    const artifacts = Array.isArray(task?.artifacts) ? task.artifacts : [];
    return {
      taskId: task?.id ?? undefined,
      state,
      wireState: toWireState(state),
      text: task !== undefined ? textOfTask(task) : textOfParts(message?.parts),
      contextId: task?.contextId ?? message?.contextId ?? undefined,
      artifacts,
      // 技能返回的结构化结果放在 `task.metadata.result`：`group/join` 要交回成员凭证、
      // `group/read` 要交回条目，这些都不该塞进文本 artifact 让调用方再解析一遍。
      // 调用方的信封（`skill`/`data`）保持原样，所以这里只取 `result` 这一层。
      data: task?.metadata?.result,
      raw: body,
    };
  }

  /**
   * 订阅一条流（JSON-RPC `SendStreamingMessage`）。
   *
   * 重连只在「调用方给了 `sinceSeq`」时发生：那表示这条流有可续的语义（群 feed），
   * 断了从断点补即可；没给 `sinceSeq` 的流（一次性长任务）重连会把已完成的事件
   * 再放一遍，所以宁可把异常 EOF 如实抛给调用方。
   *
   * @param {object} rawTarget - target。
   * @param {object} [input] - `{skill, text, data, sinceSeq, signal, onEvent, timeoutMs}`。
   *   `timeoutMs` 为**空闲**超时（每收到一块数据就重置），默认 0 = 不限，因为订阅
   *   本来就是长连。`onEvent` 收到 `{type:'status'|'artifact'|'event'|'reconnect'}`。
   * @returns {Promise<{taskId: string|undefined, state: string, wireState: string, text: string, final: boolean, reconnects: number, lastSeq: (number|undefined)}>}
   * @throws {A2aClientError} 凭证/权限/版本/网络/JSON-RPC 错误。
   */
  async function stream(rawTarget, input = {}) {
    const options = cfg();
    const target = normalizeTarget(rawTarget, options);
    const url = endpointOf(target);
    const onEvent = typeof input.onEvent === 'function' ? input.onEvent : () => {};
    const signal = input.signal;
    // 「可续」的唯一判据：调用方自己说了从哪开始。没给 sinceSeq 的流是一次性长任务，
    // 重连只会把已投过的进度再投一遍，所以不重连（见下方 reconnect 分支）。
    const resumable = input.sinceSeq !== undefined && input.sinceSeq !== null;

    // 跨重连保留：重连补的是「新事件」，已经收到的文本不该被清空。
    const segments = new Map();
    let taskId;
    let state = 'submitted';
    let final = false;
    let attempts = 0;
    let lastSeqSeen = resumable ? input.sinceSeq : undefined;

    /**
     * 把事件交给调用方。
     *
     * 调用方的回调抛错时必须**立刻、原样**抛出去，不能被当成「连接断了」而触发重连：
     * 重连会把已经投过的事件再投一遍，调用方（群收件人）就会看到重复消息。
     * 用 `EventDeliveryError` 标记，让 `once` 的 catch 认出来直接放行。
     */
    function emit(event) {
      try {
        onEvent(event);
      } catch (err) {
        throw new EventDeliveryError(err);
      }
    }

    /** 记下见到过的最新 seq，重连时用它当 sinceSeq。 */
    function noteSeq(value) {
      if (!Number.isFinite(value)) return;
      if (lastSeqSeen === undefined || value > lastSeqSeen) lastSeqSeen = value;
    }

    /** 把已收到的 artifact 文本拼成最终答复（优先 `reply`，与 `send` 的取法一致）。 */
    function collectedText() {
      const preferred = segments.get('reply');
      if (preferred !== undefined) return preferred;
      return [...segments.values()].join('\n');
    }

    /** 从一次连接里抽事件；可重试的失败放进 `outcome.failure`，不可重试的直接抛。 */
    async function once(sinceSeq) {
      const envelope = buildEnvelope({ method: 'SendStreamingMessage', input, sinceSeq });

      // 空闲超时：只统计「多久没收到字节」，不是总时长——订阅本来就该长连，
      // 用总时长会把一条健康的空闲订阅判死。0/未设 = 不限。
      //
      // 这个 controller 必须**同时**管住 fetch 与读循环：只在一个地方 abort 而信号没
      // 接上去，就是一个永远不响的定时器（这正是最初的实现踩到的坑——不设超时的
      // 订阅会一直挂着，直到对端自己关连接）。
      const idleBudget = Number.isFinite(input.timeoutMs) && input.timeoutMs > 0 ? input.timeoutMs : 0;
      const idleController = new AbortController();
      const fetchSignal = signal === undefined
        ? idleController.signal
        : AbortSignal.any([signal, idleController.signal]);

      let response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: headersOf(target, 'sse'),
          body: JSON.stringify(envelope),
          signal: fetchSignal,
        });
      } catch (err) {
        if (idleController.signal.aborted && signal?.aborted !== true) {
          throw new A2aClientError('network', `stream from ${url} did not respond within ${idleBudget}ms`, { code: 'idle_timeout', cause: err });
        }
        throw networkErrorOf(err, url);
      }
      if (!response.ok) throw await httpErrorOf(response, url);

      const outcome = { final: false, sawDone: false, failure: undefined };

      /**
       * 解释一帧。JSON-RPC 层的错误在这里抛（不能重试的那种），
       * 单帧 JSON 坏了只 warn——一条坏帧不该让整条订阅断掉。
       */
      function onFrame(payload) {
        const trimmed = payload.trim();
        if (trimmed === '') return;
        // 非 A2A 标准，但有些网关/中间层会发它当结束标记：容忍，并当成流结束。
        if (trimmed === '[DONE]') {
          outcome.sawDone = true;
          return;
        }
        let frame;
        try {
          frame = JSON.parse(trimmed);
        } catch {
          warn(`ignoring a malformed SSE frame from ${url}: ${trimmed.slice(0, 120)}`);
          return;
        }
        if (frame?.error !== undefined && frame.error !== null) throw rpcErrorOf(frame.error, url);

        const result = frame?.result ?? {};
        noteSeq(seqOfEvent(result));

        const statusUpdate = result.statusUpdate;
        if (statusUpdate !== undefined) {
          taskId = statusUpdate.taskId ?? taskId;
          const nextState = fromWireState(statusUpdate.status?.state);
          if (nextState !== 'unknown') state = nextState;
          // `final:true` 必须落在终止态上才算结束（见 TERMINAL_STATES 的注释）：
          // 一个声称 final 的 submitted 帧是坏帧，如实上报但不据此收线。
          const claimsFinal = statusUpdate.final === true;
          const isTerminal = claimsFinal && TERMINAL_STATES.has(state);
          if (claimsFinal && !isTerminal) {
            warn(`stream from ${url} sent final:true on a non-terminal state "${state}"; continuing`);
          }
          if (isTerminal) {
            outcome.final = true;
            final = true;
          }
          emit({
            type: 'status',
            taskId,
            state,
            wireState: toWireState(state),
            // 对外只报「这次流真的结束了」，而不是照抄对端那个可能自相矛盾的标记。
            final: isTerminal,
            note: textOfParts(statusUpdate.status?.message?.parts),
            raw: statusUpdate,
          });
          return;
        }

        const artifactUpdate = result.artifactUpdate;
        if (artifactUpdate !== undefined) {
          taskId = artifactUpdate.taskId ?? taskId;
          const artifact = artifactUpdate.artifact ?? {};
          const key = str(artifact.artifactId) || str(artifact.name) || 'default';
          const chunk = textOfParts(artifact.parts);
          // append=false 表示「这份 artifact 从这一帧开始」，所以替换而不是追加；
          // 长文本分片则靠 append=true 逐段拼，两者都能落在同一个 Map 里。
          if (artifactUpdate.append === true) segments.set(key, (segments.get(key) ?? '') + chunk);
          else segments.set(key, chunk);
          emit({
            type: 'artifact',
            taskId,
            artifactId: key,
            name: str(artifact.name),
            text: chunk,
            append: artifactUpdate.append === true,
            lastChunk: artifactUpdate.lastChunk === true,
            raw: artifactUpdate,
          });
          return;
        }

        const task = result.task;
        if (task !== undefined) {
          taskId = task.id ?? taskId;
          const nextState = fromWireState(task.status?.state);
          if (nextState !== 'unknown') state = nextState;
          emit({ type: 'task', taskId, state, wireState: toWireState(state), raw: task });
          return;
        }
        emit({ type: 'event', taskId, raw: frame });
      }

      try {
        const contentType = str(response.headers.get('content-type'));
        if (contentType.includes('application/json')) {
          // 少数网关会把流式塌缩成一次性 JSON；照一元结果处理，别让调用方
          // 误以为「流里没事件」是网络问题。
          const body = JSON.parse(await response.text());
          if (body?.error !== undefined && body.error !== null) throw rpcErrorOf(body.error, url);
          const task = body?.result?.task;
          if (task !== undefined) {
            taskId = task.id ?? taskId;
            state = fromWireState(task.status?.state);
            const artifact = (Array.isArray(task.artifacts) ? task.artifacts : [])[0];
            if (artifact !== undefined) {
              segments.set(str(artifact.artifactId) || 'default', textOfParts(artifact.parts));
              emit({ type: 'artifact', taskId, artifactId: str(artifact.artifactId) || 'default', name: str(artifact.name), text: textOfParts(artifact.parts), append: false, lastChunk: true, raw: artifact });
            }
          }
          outcome.final = true;
          final = true;
          return outcome;
        }

        if (response.body === null || response.body === undefined) {
          throw new A2aClientError('network', `upstream ${url} returned no response body for a streaming call`, { code: 'no_body' });
        }

        // Node 22 的 fetch 返回 web ReadableStream，chunk 是 Uint8Array。
        // 必须 stream:true 解码：中文一个字符 3 字节，可能正好被切在两个 chunk 之间。
        const decoder = new TextDecoder('utf-8');
        const parser = createSseParser(onFrame);
        let idleTimer;
        const armIdle = () => {
          if (idleBudget === 0) return;
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => idleController.abort(), idleBudget);
        };
        armIdle();

        try {
          for await (const chunk of response.body) {
            const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
            if (text !== '') {
              parser.push(text);
              armIdle();
            }
            // 收到 final / [DONE] 就主动收线，避免对着一个不结束的连接白等。
            if (outcome.final || outcome.sawDone) {
              if (typeof response.body.cancel === 'function') void response.body.cancel().catch(() => {});
              break;
            }
          }
        } catch (err) {
          // 空闲超时与调用方取消要分开：前者可重连，后者必须立刻停。
          if (idleController.signal.aborted && signal?.aborted !== true) {
            throw new A2aClientError('network', `stream from ${url} was idle for ${idleBudget}ms`, { code: 'idle_timeout', cause: err });
          }
          throw err;
        } finally {
          clearTimeout(idleTimer);
        }
        // 冲刷解码器与末帧：可能是被切断的多字节字符，也可能是没有空行结尾的最后一帧。
        const tail = decoder.decode();
        if (tail !== '') parser.push(tail);
        parser.flush();
      } catch (err) {
        // 调用方回调抛的错：保留包装继续上抛，由最外层的 `stream` 解包。
        // 在这里解包会被下一层当成网络错误重新归类（进而重连重投）。
        if (err instanceof EventDeliveryError) throw err;
        // 凭证/权限/版本/协议错误不重试：重试只会拿到同一个错误。
        if (err instanceof A2aClientError && err.kind !== 'network') throw err;
        if (signal?.aborted === true) throw networkErrorOf(err, url);
        outcome.failure = err;
      }
      return outcome;
    }

    for (;;) {
      // 一次连接上的失败有两种形态：`once` 直接把网络错误抛出来（连接在拿到响应头
      // 之前就断了），或把可重试的失败放进 `outcome.failure`（拿满响应头、读到一半
      // 断）。两者的重试语义必须一样，否则「网关重启」这种最常见的抖动会时好时坏。
      let outcome;
      let failure;
      try {
        outcome = await once(resumable ? lastSeqSeen : undefined);
        failure = outcome.failure;
      } catch (err) {
        // 调用方回调抛的错：不是这条流的问题，立刻原样上抛。
        // 绝不能落进下面的 network 归类——那会触发重连，把已投过的事件再投一遍。
        if (err instanceof EventDeliveryError) throw err.cause;
        // 只有网络类错误值得重试；凭证/权限/版本类的错误无论如何都是同一个答案。
        const normalized = err instanceof A2aClientError ? err : networkErrorOf(err, url);
        if (normalized.kind !== 'network') throw normalized;
        if (signal?.aborted === true) throw normalized;
        failure = normalized;
      }

      if (failure === undefined) {
        if (outcome === undefined || outcome.final || outcome.sawDone) break;
        break; // 正常 EOF 但没 final：交给调用方判断
      }
      if (outcome?.final === true || outcome?.sawDone === true) break;
      if (!resumable) throw failure; // 不可续的流重连 = 同一批事件投两遍
      if (attempts >= options.reconnectAttempts) throw failure;

      const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** attempts, RECONNECT_MAX_DELAY_MS);
      attempts += 1;
      emit({ type: 'reconnect', attempt: attempts, delayMs: delay, sinceSeq: lastSeqSeen });
      warn(`stream from ${url} ended abnormally; reconnecting (attempt ${attempts}/${options.reconnectAttempts}) after ${delay}ms`);
      await sleep(delay, signal);
    }

    return {
      taskId,
      state,
      wireState: toWireState(state),
      text: collectedText(),
      final,
      reconnects: attempts,
      lastSeq: lastSeqSeen,
    };
  }

  return {
    discover,
    send,
    stream,
    /**
     * 丢掉一个 target 的卡片缓存（改配置、换 key、对端升级后立刻重取）。
     * @param {object|string} rawTarget - target 或裸 baseUrl。
     * @returns {void}
     */
    invalidate(rawTarget) {
      if (typeof rawTarget === 'string') {
        const base = trimSlash(rawTarget);
        for (const key of [...cards.keys()]) {
          if (key === base || key.startsWith(`${base}#`)) cards.delete(key);
        }
        return;
      }
      try {
        const options = cfg();
        cards.delete(cacheKeyOf(normalizeTarget(rawTarget, options)));
      } catch {
        // 连 target 都不合法时无所谓缓存，静默即可——调用方紧接着会收到正式报错。
      }
    },
    /** 清空全部卡片缓存。 */
    invalidateAll() {
      cards.clear();
    },
  };
}