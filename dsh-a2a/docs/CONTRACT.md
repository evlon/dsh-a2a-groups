# dsh-a2a 模块契约（并行开发必须遵守）

> 这份文件是**唯一的接口真相**。三个开发分支按此实现，Lead 负责集成与最终验证。
> 任何一方要改这些签名，先改这份文件并在团队消息里说明，不要私自改。

## 0. 硬约束（所有模块）

1. **零外部依赖**：只允许 `node:*` 与相对路径 import。`@deepseek-ai/*` 只能在 Host 通过 `ctx` 注入，绝不 `import`。
   - 原因：profile/workspace 插件由普通 Node 解析加载，bare specifier 解析不到 DSH 安装目录。
2. **ESM**，Node ≥ 22，纯 `.js`（不引入 TypeScript 构建）。
3. 每个文件顶部写模块级 JSDoc：这文件解决什么问题、边界在哪。
4. 不用 `#private` 字段以外的花活；导出命名函数 + 一个 factory。
5. 时间一律 epoch 毫秒在内部流转，只在**边界**（日志/输出）转 ISO。
6. 不打印凭据：`token` / `password` / `memberKey` / `apiKey` 在日志与错误信息里必须脱敏成 `sha256:前8位`。

## 1. A2A 线格式（决策：**1.0**）

调用方（网关、其他 A2A 客户端）说的是 A2A **1.0**：

| 维度 | 取值 |
|---|---|
| 方法名 | PascalCase：`SendMessage` / `SendStreamingMessage` / `GetTask` / `CancelTask` |
| 一元结果 | `{"jsonrpc":"2.0","id":…,"result":{"task":{…}}}` 或 `{"result":{"message":{…}}}` |
| 流式结果 | `{"result":{"statusUpdate":{…}}}`、`{"result":{"artifactUpdate":{…}}}` |
| 任务状态 | protobuf 枚举名：`TASK_STATE_SUBMITTED` / `_WORKING` / `_COMPLETED` / `_CANCELED` / `_FAILED` / `_INPUT_REQUIRED` / `_AUTH_REQUIRED` / `_REJECTED` |
| 请求消息 | `params.message` = `{role:"user", messageId, contextId?, parts:[{kind:"text", text}], metadata?}` |
| 流结束 | `statusUpdate` 上带 `final: true` |
| 版本头 | 每个请求带 `A2A-Version: 1.0`；缺省按 `0.3` 理解 → 我们**显式拒绝**不匹配的版本 |

**技能选择**：`params.message.metadata.skill`（字符串）。缺省 = `session/ask`。

**我们的技能表**（`metadata.skill` 的合法值）：

| skill | 输入 | 输出 |
|---|---|---|
| `session/ask` | `text` + 可选 `data.timeoutMs` | artifact `reply`，一键把事情投进绑定会话并等回合结束 |
| `ping` | 无 | artifact `pong`，回带 `sessionId`/`version`，用于连通性自检 |
| `group/create` | `data.name/topic/password?/joinPolicy?` | artifact `group`（含 `groupId`、**仅此一次**的本机 ownerKey） |
| `group/invite` | `data.groupId/password/label/expiresInHours?/maxUses?` | artifact `invite`（链接 + 提示词文本） |
| `group/join` | `data.invite(+groupId/token)/password/displayName` | artifact `member`（`memberId`、`memberKey`、群摘要、`feedTail`） |
| `group/post` | `data.groupId/memberId/memberKey/text/payload?` | artifact `posted`（`seq`、`msgId`） |
| `group/read` | `data.groupId/memberId/memberKey/sinceSeq?/limit?` | artifact `feed`（增量条目） |
| `group/subscribe` | 同上 + `sinceSeq` | **流式**：每条新帖一个 `artifactUpdate`，心跳 `statusUpdate working` |
| `group/members` | `data.groupId/memberId/memberKey` | artifact `members` |
| `group/leave` | 同上 | artifact `left` |

错误码（JSON-RPC `error.code`）：

| code | 含义 |
|---|---|
| `-32700` / `-32600` / `-32601` / `-32602` / `-32603` | JSON-RPC 标准（解析/请求/方法/参数/内部） |
| `-32001` | 未认证（缺/错 `x-api-key`、缺 `memberKey`） |
| `-32002` | 未授权（不是成员、令牌过期、密码错） |
| `-32003` | 版本不支持（`A2A-Version` 不匹配） |
| `-32004` | 业务拒绝（如 hop 预算耗尽、消息过长），`data.code` 带稳定子码 |

## 2. 模块职责与导出

### 2.1 `lib/wire.js`（分支 A）

纯粹的 A2A 1.0 编解码 + 任务存储。**不含任何 DSH 概念**。

```js
export const TASK_STATES = {...};              // 枚举名常量
export function toWireState(internal);         // 'working' → 'TASK_STATE_WORKING'
export function fromWireState(wire);           // 反向，未知 → 'unknown'
export function rpcResult(id, payload);        // payload = {task|message|statusUpdate|artifactUpdate}
export function rpcError(id, code, message, data); // data 可选
export function textOfMessage(message);        // parts 里 kind==='text' 拼接
export function makeMessage({role, text, messageId, contextId, metadata}); // 造 1.0 消息
export function makeArtifact({artifactId, name, text});                     // {kind:'text'} part
export function statusUpdate({taskId, contextId, state, note, final});
export function artifactUpdate({taskId, contextId, artifact, append, lastChunk});
export function writeSseHead(res);             // 设 SSE 头（一次）
export function writeSse(res, payload);        // 写一帧 `data: <json>\n\n`
export function writeComment(res, text);       // 心跳注释 `: text\n\n`
export class TaskStore { ... }                 // 内存 + 可选落盘 + TTL
```

`TaskStore` 契约：

```js
new TaskStore({ ttlMs = 24*3600e3, persistPath, clock, limit = 500 })
store.create({ contextId, metadata })   // → { id, contextId, state:'submitted', … }
store.update(id, { state, note })       // → 任务；未知 id 返回 undefined
store.attachArtifact(id, artifact)      // 追加 artifact
store.get(id)                            // → 任务 | undefined
store.cancel(id)                         // → {task, changed:boolean}
store.list({ limit })                    // 最新在前
store.onChange(fn)                       // → dispose；fn(task)，供订阅者使用
store.flush()                            // 落盘（best-effort，不抛）
```

### 2.2 `lib/deliver.js`（分支 A）

把「一段外部文本」变成「目标会话里真实的一轮」，是 session-bus 语义的最小复用。

```js
export function createDeliverer({ ctx, logger, config });
// → { deliver(input) → Promise<receipt>, isBusy(sessionId), waitIdle(sessionId, ms) }

// input: { sessionId, text, messageId, mode='queue'|'steer'|'inbox', source }
// receipt: { injected:'followup'|'steer'|'inbox'|'duplicate', interrupted:boolean }
```

要求：
- 优先走 `ctx.sessionController.resolveAgent(sessionId)` → `agent.followup|steer|inject`，带 `source.kind='agent-message'`（左侧卡片，不伪装成本人输入）。
- Host 不支持 agent-sourced 投递时，退回 `ctx.sessionController.prompt({requestId, sessionId, mode, content})`。
- **幂等**：同 `messageId` 已在本会话 inbox/日志里就不重复投（按 `source.busMessageId` 或 `source.a2aMessageId` 查）。
- 失败要回滚：投递抛错就不要留下任何副作用。

### 2.3 `lib/server.js`（分支 A）

```js
export function createServer({ ctx, logger, config, deliverer, tasks, skills });
// → { attach(), detach(), card(), info() }
```

- `attach()`：用 `ctx.webServer.register({kind:'exact', path:'/a2a', handler})` 与 `card` 路由；返回 disposer。
- 路由：
  - `GET /a2a/.well-known/agent-card.json`（+ `agent.json` 别名）
  - `GET /a2a/.well-known/` 前缀下其它路径 → 404 JSON
  - `POST /a2a` → JSON-RPC 分发
- 鉴权：`config.server.token`，接受 `Authorization: Bearer <t>` 或 `x-api-key: <t>`；未配置 token 时**只允许 loopback**（`req.socket.remoteAddress` 是 127.0.0.1/::1）并打一条 warn。
- 版本校验：`A2A-Version` 缺失按 `0.3`；不是 `1.0` → `-32003`。
- `message` 一元 → 返回 `result.task`；`SendStreamingMessage` → SSE。
- 请求体上限 `config.server.maxBodyBytes`（默认 1 MiB），超限 413。
- 超时：技能执行超过 `config.server.taskTimeoutMs`（默认 10 min）→ 任务 `TASK_STATE_FAILED` + JSON-RPC 错误。
- `card()` 返回的对象**必须**包含：`name`、`description`、`url`（`config.server.publicUrl`）、`version`、`protocolVersion:'1.0'`、`preferredTransport:'JSONRPC'`、`capabilities`、`defaultInputModes/OutputModes`、`supportedInterfaces:[{url, protocolBinding:'JSONRPC', protocolVersion:'1.0'}]`、`skills[]`。

`skills` 是注入的注册表，形状：

```js
{ get(id) → { id, name, description, examples, run(input, context) → Promise<result> } | undefined,
  list() → [meta…] }
// run 的 context: { taskId, contextId, signal, deliverer, tasks, logger, now() }
// run 返回: { text, artifacts?: [artifact], finalState? }
```

### 2.4 `lib/bridge.js`（分支 B）

A2A **客户端**。零依赖，用全局 `fetch`。

```js
export function createBridge({ logger, config, clock });
// → {
//   discover(target) → Promise<card>,           // 带缓存（ttlMs）
//   send(target, { skill, text, data, contextId, timeoutMs }) → Promise<{taskId, state, text, raw}>,
//   stream(target, { skill, text, data, sinceSeq, signal, onEvent }) → Promise<{taskId, state}>
//   invalidate(target)
// }

// target: { baseUrl, agent?, apiKey?, protocolVersion?, forwardProto? }
//   baseUrl 形如 http://gw:3000/a2a/<agent> 或直连 http://host:3091/a2a
```

要求：
- 请求头固定带 `A2A-Version: <protocolVersion ?? '1.0'>`；有 `apiKey` 带 `x-api-key`；`forwardProto` 有值时带 `X-Forwarded-Proto`。
- 一元用 `SendMessage`，流式用 `SendStreamingMessage`。
- SSE 解析：支持跨 chunk 分帧、`data:` 多行、注释行忽略、`[DONE]` 容错。
- **断线重连**：`stream` 收到异常 EOF 且给了 `sinceSeq` 时按指数退避重连（最多 `config.client.reconnectAttempts`，默认 3），通过 `onEvent({type:'reconnect', attempt})` 告知。
- 错误分类：`{kind:'auth'|'permission'|'version'|'network'|'rpc', code?, message}`，抛 `A2aClientError`。
- 卡片 `url` 的 scheme 若是 `https` 但 `baseUrl` 是 `http` 且端口不同 → 直接用 `baseUrl`（`X-Forwarded-Proto` 缺失导致的可预期偏差），只记 warn。

### 2.5 `lib/registry.js`（分支 B）

对端登记簿，落盘 `<DSH_HOME>/a2a/agents.json`。

```js
export function createRegistry({ home, logger });
// → { list(), get(name), upsert(entry), remove(name), resolve(nameOrUrl) → target, flush() }
// entry: { name, description?, baseUrl, agent?, protocolVersion?, apiKey?, enabled }
```

### 2.6 `lib/groups.js`（分支 C）

群状态机 + 加密 + 邀请 + feed。**纯逻辑，不碰网络、不碰 DSH**。

```js
export function createGroupStore({ home, logger, clock, config });
// → {
//   create({ name, topic, password, ownerDisplayName, joinPolicy, settings }) → { group, ownerKey },
//   invite({ groupId, password, label, expiresInHours, maxUses }) → { token, link, prompt, expiresAt, maxUses },
//   join({ groupId, token, password, displayName, endpoint }) → { member, memberKey, group, feedTail },
//   authenticate({ groupId, memberId, memberKey }) → member | undefined,
//   post({ groupId, member, text, payload }) → { seq, msgId, at },
//   read({ groupId, member, sinceSeq, limit }) → { entries, lastSeq, truncated },
//   members({ groupId, member }) → [publicMember…],
//   leave({ groupId, member }) → boolean,
//   revokeInvite({ groupId, ownerKey, token }) → boolean,
//   subscribe({ groupId, fn }) → dispose,     // 新帖回调，供 group/subscribe 用
//   snapshot({ groupId, member }) → 摘要（不含任何密钥）
//   flush()
// }
```

安全要求（必须实现，验收会测）：
- 密码：`scrypt`（Node `crypto.scryptSync`，`N=2^14`，随机 16B salt），存 `scrypt$N$salt$hash`。
- 邀请令牌 / 成员凭证：存 `sha256` 十六进制，**明文只在创建/加入的响应里出现一次**。
- 常量时间比较（`crypto.timingSafeEqual`）。
- 邀请：`expiresAt` + `maxUses` + `revoked`，用一次 `uses+1`。
- feed：`seq` 单调递增，`msgId` 为 uuid；`retentionDays` 之外的老条目在 `flush` 时裁掉。
- 令牌桶：每成员 `maxPostsPerMinute`（默认 20），超限抛 `code:'rate_limited'`。
- 落盘文件权限 `0o600`，目录 `0o700`；写入用「临时文件 + rename」。
- `snapshot()` / `members()` 绝不能带出 `passwordHash` / `tokenHash` / `keyHash`。

邀请链接格式（固定，UI 与提示词都依赖）：

```
dsh-a2a://group?v=1&gw=<网关基址>&agent=<网关里的 agent 名>&g=<groupId>&t=<token>&n=<群名>&e=<expiresAt ISO>
```

提示词（`invite()` 返回的 `prompt`，中文，可直接粘到 IM）：

```
我在 DSH 里建了个协作群「{name}」，邀请你加入。

把下面这一行贴到你的 DSH 会话里直接发送即可：
/a2a-join {link}

也可以直接用自然语言让我加群：
  用 a2a_group_join 加入这个群：{link} ，群密码：{password}

入群后：群里有人发言或派活时会自动出现在你会话里（左侧「收到任务消息」卡片），
直接回复就是在群里回话。想静音用 a2a_group_inbox off，想退出用 a2a_group_leave。
（此邀请 {expiresAt} 前有效，最多可用 {maxUses} 次。）
```

### 2.7 `lib/config.js` / `lib/index.js` / `lib/tools.js` / `lib/prompt.js`（Lead）

- `config.js`：`normalizeConfig(raw)` → 完整默认值（见 §3）。
- `index.js`：`apply(ctx, config)` —— 装配 store/registry/deliverer/server/tools/prompt。
- `tools.js`：面给模型的工具，调用方是会话。
- `prompt.js`：系统提示词段（群礼仪：不要刷屏、结论要收线、什么时候该发群）。

### 2.8 `client.js`（分支 D，UI）

左侧群面板。DSH 客户端插件规范：
- `package.json` 加 `dsh.client = { platform:'web', inject:[…] }`，`exports['./client']` 指向 `client.js`。
- `client.js` 用 `window.__ModuleLoader__.load({ id, factory: (require) => {...} })` 形式（与已装插件同构），`react` / `react/jsx-runtime` 与 `@deepseek-ai/dsh-client-ui-primitives` 从共享表 `require`。
- 数据来源：不直连 A2A，只读 Host 通过 `ctx.remote` 暴露的只读视图（由 Lead 在 `index.js` 注册）。
- **首版可以只做只读**：群列表、成员、最近 feed；发帖走会话里的工具。

## 3. 配置形状（`normalizeConfig` 的产物）

```js
{
  enabled: true,
  server: {
    enabled: true,
    port: null,                 // null = 复用现有 webServer 端口（推荐）
    publicUrl: '',              // 卡片里对外声明的 url；空则用 webServer.getOrigin()+'/a2a'
    token: '',                  // 空 = 只允许 loopback
    bindSessionId: 'self',      // 'self' = 首个调用会话；或显式 sessionId
    maxBodyBytes: 1048576,
    taskTimeoutMs: 600000,
    streaming: true,            // 关掉后 SendStreamingMessage 返回 -32601
    skills: { session: true, group: true }
  },
  client: {
    enabled: true,
    apiKey: '',                 // AISIX 网关 Key（一人一把）
    gatewayBase: '',            // 形如 http://gw:3000/a2a
    protocolVersion: '1.0',
    forwardProto: '',           // 联调 http 时填 'http'
    cardTtlMs: 300000,
    timeoutMs: 120000,
    reconnectAttempts: 3
  },
  groups: {
    enabled: true,
    home: '',                   // 默认 <DSH_HOME>/a2a
    joinPolicy: 'invite',       // invite | password
    defaultPasswordLength: 12,
    inviteExpiresInHours: 168,
    inviteMaxUses: 5,
    maxPostChars: 32000,
    maxPostsPerMinute: 20,
    retentionDays: 30,
    wakeMembers: true
  },
  delivery: {
    presentation: 'notice',      // notice = agent-message 卡片；bubble = 普通用户消息
    defaultMode: 'queue',
    hopBudget: 16,
    maxHops: 16,
    dedupeWindowMs: 600000
  },
  tools: true,
  promptSection: true
}
```

## 4. 测试约定

- 每个分支自带 `test/<area>.test.mjs`，用 `node --test`。
- **不依赖真实网络/真实 DSH**：`webServer`、`sessionController`、`fs` 都用假对象注入。
- 需要 HTTP 的地方用 `node:http` 起临时端口（`listen(0)`），不引测试框架。
- 断言必须验证**行为**（投递了几次、状态怎么变、密钥有没有泄漏），不是「函数被调用了」。

## 5. 写域（并行不冲突）

| 分支 | 可写 |
|---|---|
| A `wire-server` | `lib/wire.js` `lib/server.js` `lib/deliver.js` `lib/card.js` `test/wire.test.mjs` `test/server.test.mjs` `test/deliver.test.mjs` |
| B `bridge-client` | `lib/bridge.js` `lib/registry.js` `lib/skills-client.js` `test/bridge.test.mjs` `test/registry.test.mjs` |
| C `groups-core` | `lib/groups.js` `lib/invite.js` `test/groups.test.mjs` `test/invite.test.mjs` |
| D `group-ui` | `client.js` `lib/types/client.d.ts` `README-ui.md` |
| Lead | `lib/index.js` `lib/config.js` `lib/tools.js` `lib/prompt.js` `lib/skills/*.js` `package.json` `README.md` `scripts/` `docs/` `PLAN.md` |

> 需要改别人文件的接口时：**先发消息**，改 `docs/CONTRACT.md` 的对应段落，再动代码。
