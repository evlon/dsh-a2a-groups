/**
 * 对端登记簿：把「我认识的 A2A agent」持久化到 `<DSH_HOME>/a2a/agents.json`。
 *
 * ## 这个文件解决什么问题
 *
 * 模型和用户不该每次调用都重新输入一长串 URL 与网关 Key。登记簿把「一个短名字」
 * 映射到一份完整的 `target`（`baseUrl` / `agent` / `apiKey` / 版本 / 开关），于是
 * 工具层可以先 `resolve('zhang')` 再 `send(target, …)`。
 *
 * ## 边界（明确不做的事）
 *
 * - **不联网**：这里只增删查改与落盘，连通性由 `bridge.discover()` 负责。
 * - **不算业务规则**：`enabled:false` 只是个标记，由调用方决定是否跳过（登记簿
 *   不该替上层决定「禁用后是报错还是静默」）。
 * - **不 encrypt**：`apiKey` 是明文落盘（权限 0600）。这一条是刻意的取舍，理由见
 *   `flush()` 上方注释——用零依赖做「真加密」意味着把密钥也放在同一台机器上，
 *   只会给出「已加密」的错觉。
 *
 * ## 为什么用「临时文件 + rename」
 *
 * 插件随时可能被重启或断电。直接 `writeFile` 到目标文件时，进程死在中间会留下
 * 半截 JSON，下次启动就读不出来了；写临时文件再 `rename` 是同一文件系统上的原子
 * 替换，最坏结果是「丢掉最后一次修改」，而不是「登记簿整体损坏」。
 *
 * @module dsh-a2a/registry
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

/** 登记簿的文件名（放在传入的 `home` 目录下）。 */
const FILE_NAME = 'agents.json';

/** 落盘格式的版本号：以后改结构时用它做迁移分支，而不是猜字段。 */
const FORMAT_VERSION = 1;

/** 文件权限：只有属主可读写（CONTRACT §2.6 对 groups.json 的要求，这里沿用同一标准）。 */
const FILE_MODE = 0o600;

/** 目录权限：只有属主可进入。 */
const DIR_MODE = 0o700;

/**
 * 判断「这是不是一个 URL 而不是名字」：解析成功且有 http(s) 协议。
 */
function looksLikeUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 取字符串，非字符串当空串。 */
function str(value) {
  return typeof value === 'string' ? value : '';
}

/** 去尾部斜杠：`baseUrl` 参与字符串比较，必须规范化。 */
function trimSlash(value) {
  return String(value ?? '').replace(/\/+$/, '');
}

/**
 * 名字的规范化键：大小写不敏感，避免 `alice` 与 `Alice` 变成两条记录。
 *
 * @param {unknown} name - 原始名字。
 * @returns {string} 比较用的键。
 */
function keyOf(name) {
  return str(name).trim().toLowerCase();
}

/**
 * 把一个任意对象收敛成合法登记项。
 *
 * `name` 缺失时抛错（没有名字就无法 `resolve`，留着它只会让列表里出现幽灵项）；
 * `baseUrl` 缺失时也抛错（没有任何地方可调用）。其余字段缺省即省略，不做无意义
 * 的 `undefined` 填充——落盘文件要人能读。
 *
 * @param {object} raw - 调用方给的对象。
 * @returns {object} 只含合法字段的登记项。
 * @throws {Error} `name` 或 `baseUrl` 缺失时（带 `code='invalid_entry'`）。
 */
function normalizeEntry(raw) {
  if (raw === null || typeof raw !== 'object') throw invalidEntry('entry must be an object');
  const name = str(raw.name).trim();
  if (name === '') throw invalidEntry('entry.name is required');
  const baseUrl = trimSlash(str(raw.baseUrl));
  if (baseUrl === '') throw invalidEntry(`entry "${name}" is missing baseUrl`);

  const entry = { name, baseUrl };
  const description = str(raw.description).trim();
  if (description !== '') entry.description = description;
  const agent = str(raw.agent).trim();
  if (agent !== '') entry.agent = agent;
  const protocolVersion = str(raw.protocolVersion).trim();
  if (protocolVersion !== '') entry.protocolVersion = protocolVersion;
  const apiKey = str(raw.apiKey);
  if (apiKey !== '') entry.apiKey = apiKey;
  const forwardProto = str(raw.forwardProto).trim();
  if (forwardProto !== '') entry.forwardProto = forwardProto;
  // `enabled` 缺省为 true：登记一个对端的目的就是用它，默认关闭会让人以为没生效。
  entry.enabled = raw.enabled !== false;
  return entry;
}

/** 造一个带稳定 code 的参数错误。 */
function invalidEntry(message) {
  const error = new Error(message);
  error.code = 'invalid_entry';
  return error;
}

/** 取 apiKey 的短标识，只用于日志（CONTRACT §0.6）。 */
function maskSecret(value) {
  if (typeof value !== 'string' || value === '') return '';
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 8)}`;
}

/**
 * 造一个对端登记簿。
 *
 * @param {object} options - 依赖注入。
 * @param {string} [options.home] - 存放 `agents.json` 的目录（一般是 `<DSH_HOME>/a2a`）。
 * @param {{warn?: Function, info?: Function, debug?: Function}} [options.logger] - 日志器。
 * @param {() => number} [options.clock] - 时钟注入（记录 `updatedAt` 用；单测可固定）。
 * @param {string} [options.fileName] - 覆盖文件名，单测用。
 * @returns {{
 *   list: () => Array<object>,
 *   get: (name: string) => (object|undefined),
 *   upsert: (entry: object) => object,
 *   remove: (name: string) => boolean,
 *   resolve: (nameOrUrl: string) => (object|undefined),
 *   flush: () => void,
 *   path: () => string
 * }}
 */
export function createRegistry({ home, logger, clock, fileName = FILE_NAME } = {}) {
  const baseDir = str(home).trim();
  if (baseDir === '') {
    // 没有 home 就没有持久化位置。给一个明确的错误，而不是悄悄写到进程 cwd 里
    // ——那会让「配置丢了」这种事故变成「数据写到不知道哪儿去了」。
    const error = new Error('createRegistry requires a home directory');
    error.code = 'invalid_home';
    throw error;
  }
  const filePath = join(baseDir, fileName);
  const now = typeof clock === 'function' ? clock : () => Date.now();

  /** @type {Map<string, object>} 规范化键 → 登记项（插入顺序保留，list 稳定）。 */
  const entries = new Map();
  let loaded = false;

  function warn(message) {
    if (typeof logger?.warn === 'function') logger.warn(`[a2a-registry] ${message}`);
  }

  /**
   * 首次访问时读盘。
   *
   * 惰性读（而不是构造函数里读）是为了让「文件坏了」变成一次可捕获的 warn，而不是
   * 让插件在 `apply()` 阶段直接起不来——登记簿丢了应该退化成「没有对端」，不该
   * 让整个插件失效。
   */
  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    let raw;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch (err) {
      if (err?.code !== 'ENOENT') warn(`cannot read ${filePath}: ${err?.message ?? err}`);
      return;
    }
    if (raw.trim() === '') return;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // 文件坏了不要覆写它：留在原地供人抢救，本次运行从空簿开始。
      warn(`${filePath} is not valid JSON (${err?.message ?? err}); starting with an empty registry and leaving the file untouched`);
      return;
    }
    const list = Array.isArray(parsed?.agents) ? parsed.agents : [];
    for (const item of list) {
      try {
        // `normalizeEntry` 的字段白名单顺带承担了「落盘文件被手改后也不会带进
        // 意外字段」的作用；`enabled` 缺省为 true 的语义在它里面处理。
        const entry = normalizeEntry(item);
        entries.set(keyOf(entry.name), entry);
      } catch (err) {
        warn(`skipping an unusable entry in ${filePath}: ${err?.message ?? err}`);
      }
    }
  }

  /**
   * 原子落盘。
   *
   * 先写同目录的临时文件再 `rename`：`rename` 在同一文件系统内是原子的，所以任何
   * 时刻读到的 `agents.json` 要么是旧的完整内容、要么是新的完整内容。
   *
   * best-effort：失败只 warn 不抛——一次盘写失败不该让用户正在进行的 A2A 调用崩掉。
   *
   * @returns {void}
   */
  function flush() {
    const payload = {
      version: FORMAT_VERSION,
      updatedAt: new Date(now()).toISOString(),
      agents: [...entries.values()],
    };
    const text = `${JSON.stringify(payload, null, 2)}\n`;
    const temp = join(baseDir, `.${fileName}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    try {
      mkdirSync(dirname(filePath), { recursive: true, mode: DIR_MODE });
      writeFileSync(temp, text, { encoding: 'utf8', mode: FILE_MODE });
      renameSync(temp, filePath);
      // Windows 上 `mode` 基本不生效，POSIX 上它受 umask 影响；显式再 chmod 一次，
      // 让 0600 成为事实而不是期望。
      try {
        chmodSync(filePath, FILE_MODE);
      } catch {
        // 某些文件系统（FAT/网络盘）不支持 chmod：不是致命问题。
      }
    } catch (err) {
      warn(`cannot write ${filePath}: ${err?.message ?? err}`);
      try {
        unlinkSync(temp);
      } catch {
        // 临时文件可能压根没建出来。
      }
    }
  }

  /**
   * 列出全部登记项（副本，调用方改它不会污染内部状态）。
   *
   * 返回值里 `apiKey` 保留原值：工具层需要它去发请求；日志由各调用方自己脱敏。
   *
   * @returns {Array<object>} 登记项数组。
   */
  function list() {
    ensureLoaded();
    return [...entries.values()].map((entry) => ({ ...entry }));
  }

  /**
   * 按名字精确取（大小写不敏感）。
   *
   * @param {string} name - 对端名字。
   * @returns {object|undefined} 登记项副本。
   */
  function get(name) {
    ensureLoaded();
    const entry = entries.get(keyOf(name));
    return entry === undefined ? undefined : { ...entry };
  }

  /**
   * 新增或覆盖一个登记项并立即落盘。
   *
   * 覆盖时按名字（大小写不敏感）匹配，但**保留调用方给的新名字的大小写**：用户
   * 把 `alice` 改成 `Alice` 是在表达偏好，不该被旧记录压回去。
   *
   * @param {object} raw - 登记项。
   * @returns {object} 写入后的登记项副本。
   * @throws {Error} `name`/`baseUrl` 缺失时。
   */
  function upsert(raw) {
    ensureLoaded();
    const entry = normalizeEntry(raw);
    entries.set(keyOf(entry.name), entry);
    flush();
    return { ...entry };
  }

  /**
   * 删除一个登记项。
   *
   * @param {string} name - 对端名字。
   * @returns {boolean} 是否真的删掉了（不存在返回 false，便于工具层给出准确提示）。
   */
  function remove(name) {
    ensureLoaded();
    const key = keyOf(name);
    if (!entries.has(key)) return false;
    entries.delete(key);
    flush();
    return true;
  }

  /**
   * 把「名字或裸 URL」解析成可以直接喂给 `bridge` 的 target。
   *
   * 裸 URL 的判定用「能不能 `new URL()` 且是 http(s)」，而不是「像不像 http 开头」：
   * `localhost:3091` 这种既像名字又像地址的输入，交给 `new URL` 是按协议判定的，
   * 不会误判。裸 URL 时不带任何凭证——凭证只能来自显式登记或配置，绝不猜。
   *
   * @param {string} nameOrUrl - 对端名字，或 `http(s)://…` 直连地址。
   * @returns {object|undefined} `{baseUrl, agent?, apiKey?, protocolVersion?, forwardProto?}`。
   */
  function resolve(nameOrUrl) {
    ensureLoaded();
    const raw = str(nameOrUrl).trim();
    if (raw === '') return undefined;
    if (looksLikeUrl(raw)) {
      // 直连 URL 允许自带 `#agent` 片段（`…/a2a#my-agent`），这样一条字符串就能
      // 同时表达网关基址与 agent 名，省掉工具层的第二个参数。
      let agent;
      let baseUrl = raw;
      const hash = raw.indexOf('#');
      if (hash !== -1) {
        baseUrl = raw.slice(0, hash);
        agent = raw.slice(hash + 1).trim();
      }
      const target = { baseUrl: trimSlash(baseUrl) };
      if (agent !== undefined && agent !== '') target.agent = agent;
      return target;
    }
    const entry = entries.get(keyOf(raw));
    if (entry === undefined) return undefined;
    const target = { baseUrl: entry.baseUrl };
    if (entry.agent !== undefined) target.agent = entry.agent;
    if (entry.apiKey !== undefined) target.apiKey = entry.apiKey;
    if (entry.protocolVersion !== undefined) target.protocolVersion = entry.protocolVersion;
    if (entry.forwardProto !== undefined) target.forwardProto = entry.forwardProto;
    return target;
  }

  /** 落盘路径（工具层/诊断用）。 */
  function path() {
    return filePath;
  }

  return { list, get, upsert, remove, resolve, flush, path };
}

/** 供单测与工具层复用的脱敏（避免各处重复实现）。 */
export { maskSecret };
