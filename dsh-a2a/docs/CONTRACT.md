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
6. 不打印凭据：`token` / `claimKey` / `memberKey` / `ownerKey` / `apiKey` 在日志与错误信息里必须脱敏成 `sha256:前8位`。

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
| `group/create` | `data.name/topic?/ownerDisplayName?/visibility?` | artifact `group`（含 `groupId`、**仅此一次**的 ownerKey） |
| `group/invite` | `data.groupId/memberId/memberKey/label?/expiresInHours?` | artifact `invite`（链接 + 提示词文本）。`expiresInHours: null` = 永不过期；不传 = 配置默认（7 天）。**无次数限制**，只有群主可发 |
| `group/join` | `data.groupId/token/displayName?/endpoint?` | artifact `member`（`memberId`、`memberKey`、群摘要、`feedTail`）。**只需 token，无密码** |
| `group/post` | `data.groupId/memberId/memberKey/text/payload?` | artifact `posted`（`seq`、`msgId`） |
| `group/read` | `data.groupId/memberId/memberKey/sinceSeq?/limit?` | artifact `feed`（增量条目） |
| `group/subscribe` | 同上 + `sinceSeq` | **流式**：每条新帖一个 `artifactUpdate`，心跳 `statusUpdate working` |
| `group/members` | `data.groupId/memberId/memberKey` | artifact `members` |
| `group/info` | `data.groupId/memberId/memberKey` | artifact `info`（`name`/`topic`/`memberCount`/`onlineCount`/`lastSeq`/`lastPostAt`/`isOwner`）。**不含名单** |
| `group/directory` | `data.query?/limit?/offset?` — **无凭证** | artifact `directory`：只含 `groupId/name/topic/memberCount/onlineCount/lastActivityAt/lastSeq`。`unlisted` 的群**完全不出现在结果里**（不是标了隐藏） |
| `group/role` | `data.groupId/memberId/memberKey/roleAbout?/tags?` | artifact `member`（层 A：按群独立的自我描述，只能改自己） |
| `group/leave` | 同上 | artifact `left` |
| `group/request` | `data.groupId/displayName/reason?` — **无凭证** | artifact `request`（`requestId` 公开队列索引 + `claimKey` **仅此一次**的秘密）。`unlisted` 的群返回 `unknown_group` |
| `group/requests` | `data.groupId/memberId/memberKey/status?` — **仅群主** | artifact `requests`（待审列表，含申请人的名字与理由） |
| `group/decide` | 同上 + `requestId/approve` | artifact `decided`。**批准不直接建成员**——申请人用自己的 `claimKey` 去领 |
| `group/claim` | `data.groupId/requestId/claimKey` — **无群密码** | artifact `member`（领取已批准的成员身份；`claimKey` 一次性） |

**为什么 `group/claim` 不需要密码**：群密码的全部作用是"阻止不认识的人"，
而审批本身就是"我认识并同意"。两条入群路径的凭证因此不同且不重叠：

| | 邀请链接 | 申请审批 |
|---|---|---|
| 凭证 | `token`（群主批量发） | `claimKey`（申请人自己持有） |
| 有效期 | 可设，含永不过期 | 固定 7 天 |
| 次数 | 不限 | 一次 |
| 撤销 | `revokeInvite` 精确撤那一条 | 拒绝即结束 |

错误码（JSON-RPC `error.code`）：

| code | 含义 |
|---|---|
| `-32700` / `-32600` / `-32601` / `-32602` / `-32603` | JSON-RPC 标准（解析/请求/方法/参数/内部） |
| `-32001` | 未认证（缺/错 `x-api-key`、缺 `memberKey`） |
| `-32002` | 未授权（不是成员、令牌过期/撤销/耗尽） |
| `-32003` | 版本不支持（`A2A-Version` 不匹配） |
| `-32004` | 业务拒绝，`data.code` 带稳定子码（见下表） |

业务子码（`data.code`，稳定，可被程序判断）：

| 子码 | 含义 |
|---|---|
| `invite_invalid` / `invite_expired` / `invite_revoked` | 邀请不可用 |
| `request_pending` / `request_rejected` / `request_expired` / `request_invalid` / `request_not_found` | 申请不可领取 |
| `not_owner` | 非群主（发邀请、看申请、审批） |
| `not_member` | 凭证无效或不是成员 |
| `unknown_group` | 群不存在，或（对无凭证路径）是 `unlisted` 因而不承认存在 |
| `missing_gateway` / `missing_agent_name` | 生成邀请前未配置网关坐标 |
| `group_full` / `too_long` / `empty_message` / `rate_limited` | 容量与内容限制 |

## 2. 模块职责与导出

### 2.0 目录边界：一句话判断一个文件属于哪个宿主

```
lib/
├── core/     零 DSH 依赖，任何宿主可复用
├── dsh/      唯一读 ctx 的地方
├── shared/   两个宿主共用，谁也不属于
├── mcp/      唯一读 MCP 协议的地方
├── index.js      DSH 插件入口（包 main）
└── mcp-server.js MCP 入口（bin: agent-groups-mcp）
```

| 目录 | 文件 | 判据 |
|---|---|---|
| `core/` | groups, memberships, invite, card, wire, server, bridge, registry, skills, skills-group, skills-session, probe, config | 不 import `ctx`，只用 `node:*` 和彼此 |
| `dsh/` | deliver, sessions, inbox, tools, toolkit, profile, prompt | 读 `ctx` |
| `shared/` | tool-specs, tool-runtime | 纯数据 + 纯逻辑，两个宿主都调 |
| `mcp/` | mcp-deps | 为"没有 DSH 的进程"接线 |

**这条边界是可检查的，不是口号**：

```bash
# 除 index.js 外，lib/dsh/ 之外不应出现"真实"的 ctx 代码（注释不算）
grep -rn '\bctx\b' lib/ --include='*.js' | grep -v '^lib/dsh/' | grep -v '^lib/index.js'
```

目前只剩 `lib/core/server.js` 的 3 处，全部是**可选注入**：

```js
createServer({ ctx, registrar = ctx?.webServer, ... })   // 有 ctx 就用，没有就靠 registrar
function originProvider() { const webServer = ctx?.webServer; ... }   // 拿不到就返回 undefined
```

这正是 `core/` 能同时服务两种宿主的机制：DSH 传 `ctx`，独立宿主传 `registrar`，
同一个文件两种用法。`ctx?.` 的可选链是让"没有 DSH"成为一种正常情况，而不是异常路径。

**为什么 `index.js` 和 `mcp-server.js` 留在 `lib/` 而不是搬进子目录**：它们是
`package.json` 的入口。插件是通过 junction 装进 DSH profile 的，改包入口会破坏一个
正在运行的安装，而收益只是路径好看一点。

### 2.1 `lib/core/wire.js`（分支 A）

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

### 2.2 `lib/dsh/deliver.js`（分支 A）

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

### 2.3 `lib/core/server.js`（分支 A）

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

### 2.4 `lib/core/bridge.js`（分支 B）

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

### 2.5 `lib/core/registry.js`（分支 B）

对端登记簿，落盘 `<DSH_HOME>/a2a/agents.json`。

```js
export function createRegistry({ home, logger });
// → { list(), get(name), upsert(entry), remove(name), resolve(nameOrUrl) → target, flush() }
// entry: { name, description?, baseUrl, agent?, protocolVersion?, apiKey?, enabled }
```

### 2.6 `lib/core/groups.js`（分支 C）

群状态机 + 加密 + 邀请 + feed。**纯逻辑，不碰网络、不碰 DSH**。

```js
export function createGroupStore({ home, logger, clock, config });
// → {
//   create({ name, topic, ownerDisplayName, settings }) → { group, ownerKey },
//   invite({ groupId, ownerKey, label, expiresInHours }) → { token, link, prompt, expiresAt, inviteId },
//     // ownerKey 必填（只有群主能发邀请）；expiresInHours: null = 永不过期
//   join({ groupId, token, displayName, endpoint }) → { member, memberKey, group, feedTail },
//   authenticate({ groupId, memberId, memberKey }) → member | undefined,
//   post({ groupId, member, text, payload }) → { seq, msgId, at },
//   read({ groupId, member, sinceSeq, limit }) → { entries, lastSeq, truncated },
//   members({ groupId, member }) → [publicMember…],
//   leave({ groupId, member }) → boolean,
//   revokeInvite({ groupId, ownerKey, token }) → boolean,
//   subscribe({ groupId, fn }) → dispose,     // 新帖回调，供 group/subscribe 用
//   snapshot({ groupId, member }) → 摘要（不含任何密钥；带 member 时含 feedTail）
//   listDirectory({ query, limit, offset }) → 频道目录页（无凭证，无名单）
//   requestJoin({ groupId, displayName, reason }) → { requestId, claimKey, expiresAt },
//   listRequests({ groupId, member, status }) → [请求视图]（仅群主）,
//   decideRequest({ groupId, member, requestId, approve }) → { status }（仅群主）,
//   claimJoin({ groupId, requestId, claimKey }) → { member, memberKey, group },
//   flush()
// }
```

安全要求（必须实现，验收会测）：
- **没有群密码**。入群凭证只有两种，互不重叠：邀请 `token`、审批后领取用的 `claimKey`。
- 邀请令牌 / 成员凭证 / `claimKey`：存 `sha256` 十六进制，**明文只在创建/加入的响应里出现一次**。
- 常量时间比较（`crypto.timingSafeEqual`）。
- 邀请：`expiresAt`（可为 `null` = 永不过期）+ `revoked`。**没有次数计数**——撤销才是精确控制。
- 申请：`expiresAt` 固定 7 天；一条申请只能被领取一次（状态机 `pending → approved/rejected → claimed`）。
- feed：`seq` 单调递增，`msgId` 为 uuid；`retentionDays` 之外的老条目在 `flush` 时裁掉。
- 令牌桶：每成员 `maxPostsPerMinute`（默认 20），超限抛 `code:'rate_limited'`。
- 落盘文件权限 `0o600`，目录 `0o700`；写入用「临时文件 + rename」。
- `snapshot()` / `members()` / `listDirectory()` 绝不能带出 `tokenHash` / `keyHash` / `claimHash`。

`unlisted` 的语义（验收会测）：`listDirectory` 里**整行不返回**，`requestJoin` 返回 `unknown_group`。
它不是"标了隐藏"——那等于回答了"存在这个 id 的群"，是一个存在性探测。

邀请链接格式（固定，UI 与提示词都依赖）：

```
agent-a2a://group?v=1&gw=<网关基址>&agent=<网关里的 agent 名>&g=<groupId>&t=<token>&n=<群名>&e=<expiresAt ISO>
```

`e=` 在永不过期的邀请里省略。

提示词（`invite()` 返回的 `prompt`，中文，可直接粘到 IM）：

```
我在 DSH 里建了个协作群「{name}」，邀请你加入。

把下面这一行贴到你的 DSH 会话里直接发送即可：
/a2a-join {link}

也可以直接用自然语言让我加群：
  用 a2a_group_join 加入这个群：{link}

入群后：群里有人发言或派活时会自动出现在你会话里（左侧「收到任务消息」卡片），
直接回复就是在群里回话。想静音用 a2a_group_inbox off，想退出用 a2a_group_leave。
（此邀请在 {expiresAt} 前有效；群主可以随时撤销。链接谁拿到谁能用，别转发到无关的地方。）
```

永不过期时最后一行改为：
`（此邀请长期有效；群主可以随时撤销这条链接。）`

### 2.7 `lib/core/config.js` / `lib/index.js` / `lib/dsh/tools.js` / `lib/dsh/prompt.js`（Lead）

- `config.js`：`normalizeConfig(raw)` → 完整默认值（见 §3）。
- `index.js`：`apply(ctx, config)` —— 装配 store/registry/deliverer/server/tools/prompt。
- `tools.js`：面给模型的工具，调用方是会话。
- `prompt.js`：系统提示词段（群礼仪：不要刷屏、结论要收线、什么时候该发群）。

**工具面（19 个）**，`a2a_group_*` 全部作用于**当前会话**（`senderOf(exec).id`）：

| 工具 | 作用 |
|---|---|
| `a2a_group_create` / `invite` / `join` / `post` / `read` | 基本操作 |
| `a2a_group_info` / `role` / `leave` | 元数据与层 A 角色 |
| `a2a_group_directory` | 浏览宿主上的群（无凭证） |
| `a2a_group_request` / `requests` / `decide` / `claim` | 申请审批四步 |
| `a2a_groups` / `a2a_group_inbox` | 本会话的群列表与静音 |

`a2a_group_create` 在 `groups.embedded: false`（默认）时**通过 A2A 在远端宿主上建群**，
这现在是常态；`embedded: true` 时才在本机建。

### 2.7b `lib/core/memberships.js`（成员账本）

**键是 `(sessionId, groupId)`，不是 `groupId`。** 这是本次最重要的模型变更。

```js
export const HOST_SESSION_ID = 'host';   // 纯宿主用它（宿主没有会话，也不该有 membership）

createMembershipLedger({ home, logger, clock })
// → {
//   list({ sessionId?, groupId? }) → [record…],
//   get(groupId, sessionId?) → record | undefined,
//   has(groupId) → boolean,              // 任意会话是否为成员
//   membershipsOf(sessionId) → [record…],
//   localMemberships() / remoteMemberships(),
//   upsert({ sessionId, groupId, memberId, memberKey, baseUrl, local, groupName,
//            role, lastSeq, groupTopic?, memberCount?, onlineCount?, lastTime?,
//            isOwner?, feed? }) → record,
//   remove({ groupId?, sessionId? }) → 删除条数,
//   flush(), path()
// }
```

规则：

1. **`sessionId` 必填**。一条无法指明会话的 membership 永远无法被投递，接受它只会造出
   一条静默失效的记录。
2. **同一个群可被同一台机器的两个会话分别加入** —— 一个项目里负责两个模块的人，在那个群
   里就是两个成员，两个凭证、两个未读游标。这是设计目标。
3. 文件格式 `version: 2`。`version: 1`（实例级、无 `sessionId`）**拒绝加载并重新开始**，
   不猜测归属——猜错会把别人的群消息投进这个会话。
4. `memberKey` 以明文存于 `0600` 文件。必须如此：插件每次调用都要出示它，本地加密的
   密钥只能放在同一台机器上，对"本机另一个进程"这个真实威胁毫无作用。
5. 缓存的群视图（`groupName` / `memberCount` / `feed` 等）由 `a2a_group_info` 填充。
   面板从账本渲染而非从网络取数，没有缓存就只能显示裸 id 和"0 人"。

### 2.7c `lib/dsh/inbox.js` 的投递路由

订阅**按群**（一个群一条 SSE，两个会话在同一个群不需要两条连接），投递**按 membership**：

```
群消息到达
  → 查该 groupId 的所有远程 membership
  → 逐个投给各自 sessionId，去重键是 (sessionId, msgId)
  → 一个会话看过，不影响另一个会话收到
```

订阅凭证用其中任意一条 membership 的（群宿主只回答一个订阅者），
但**由哪条凭证开的流不决定谁能收到**。

水位（`sinceSeq`）取该群所有 membership 里**最小**的 `lastSeq`：
读得多的那个重读几条（去重会丢掉），读得少的不会漏。反过来会静默跳过。

### 2.7d `bin/agent-groups.js`（独立群宿主）

群宿主**不是** DSH 实例：不加载模型、没有会话、不投递。它是一个零依赖 Node 程序。

```js
export { createHttpRegistrar, parseFlags, usage };   // 可被测试导入，导入无副作用
```

`createHttpRegistrar(logger)` → `{ registrar, handle, routes }`：

- `registrar.register({ kind: 'exact'|'prefix', path, handler }) → disposeFn`
  挂到原生 `http.Server`；`detach()` 真的能移除，所以同一进程内可重启。
- 路由匹配规则与 DSH webserver **一致**：exact 优先于 prefix，prefix 里最长者胜。
  这样才保证"嵌入"与"独立"两种形态下 A2A 表面完全相同。
- 未知路径返回 **JSON 404**，不是 HTML 外壳——否则探测卡片的对端会把页面误当成卡片。

`server.js` 因此改为**注入** `registrar` 而不是读 `ctx.webServer`：

```js
createServer({ registrar, where, logger, config, deliverer, tasks, skills, onFlush })
```

- 在 DSH 里：`registrar = ctx.webServer`
- 独立运行：`registrar = createHttpRegistrar()`

注册的 5 条路由：

| 路径 | 说明 |
|---|---|
| `/a2a/.well-known/agent-card.json` | 卡片（公开，发现先于认证） |
| `/a2a/.well-known/agent.json` | 同上（别名） |
| `/a2a/.well-known/*` | JSON 404，把未知发现路径变成结构化回答 |
| `/a2a` | JSON-RPC + SSE |
| `/__health` | 运维端点（见下） |

**`/__health`**（需要与 `/a2a` 相同的令牌）：

- `GET` / `HEAD` → `{ ok, agent, version, uptimeSeconds, skills }`，**不落盘**
- `POST` → 额外执行 `onFlush()`，返回 `{ flushed: true }`；失败时 `500 { ok: false, flushError }`

要求 `POST` 才落盘，是为了让爬虫或浏览器预取**无法触发出磁盘写**。
备份脚本应先 `POST /__health` 再复制 `groups.json`。

命令行（标志优先于环境变量，环境变量优先于默认值）：

| 标志 | 环境变量 | 默认 |
|---|---|---|
| `--port` | `AGENT_GROUPS_PORT` | 3095 |
| `--host` | `AGENT_GROUPS_HOST` | 127.0.0.1 |
| `--data` | `AGENT_GROUPS_DATA` | `./data` |
| `--token` | `AGENT_GROUPS_TOKEN` | 无（仅回环可信） |
| `--agent` | `AGENT_GROUPS_AGENT` | agent-groups |
| `--gateway` | `AGENT_GROUPS_GATEWAY` | 无（则无法生成邀请） |
| `--forward-proto` | `AGENT_GROUPS_FORWARD_PROTO` | 无 |
| `--public-url` | `AGENT_GROUPS_PUBLIC_URL` | 无 |

位置参数一律**报错退出**：静默忽略 `agent-groups 3095` 会在默认端口启动并看起来正常，
那比一个用法错误糟得多。

宿主持有 `groups.json`，**不持有 `memberships.json`**（成员才有 membership）。
技能里那几处"把自己登记为成员"的调用在宿主上按设计**静默跳过**——
群主本来就是所建群的一员，这个语义由群自身满足。

### 2.7e 后加的四个模块与两处行为

名字带 `2.7e` 而不是新章节，是因为它们仍然属于「宿主与账本这一层」，插在这里比另起一节更容易被找到。

#### `lib/core/endpoint.js` —— 谁的地址

```js
ownEndpointFromConfig(config)  // 从 groups.gatewayBase + groups.agentName 拼出本实例地址
normalizeEndpoint(value)       // 校验并规范化外部传入的地址
```

**存在理由**：`group/join` 跑在**宿主进程里**，如果在宿主里调 `ownEndpointFromConfig(config)`，得到的是
**宿主自己的地址**，会被写到每个成员身上。所以宿主只用调用方送来的地址；只有成员侧才调这个函数。

这条曾经是真实缺陷：所有成员的地址都被写成了宿主的，导致「看起来注册了，但谁也收不到」。

#### `lib/core/colleague-cards.js` —— 名片汇编

```js
buildColleagueCards({ persons, memberships })  // → [{ personId, displayName, headline, tags, groups, online }]
```

**为什么不是直接读 `persons[]`**：名片要回答「这个人**和我**有什么关系」，所以需要当前实例的 memberships
才能算出「在哪些共同的群里」「在这个群里负责什么」。纯 persons 表做不到。

#### `lib/core/skills-group.js` 的 `person/profile`

**新 skill，第 22 个。** `group/role` 写的是**某个群内的** `about`/`tags`；`headline` 是**跨群的**人属性，
存在 `persons[]` 里。两者不能合并 —— 一个人可以在 A 群「负责对账」、在 B 群「兼产品」，同时名片上写「后端工程师」。

```js
{ skill: 'person/profile', data: { groupId, personId, personKey, headline } }
```

带 `groupId` 不是因为它属于群，而是因为**凭证挂在群成员身份上** —— 有了凭证才知道写哪个人的行。

#### `announceJoin(group, joiner)`（`skills-group.js` 内部函数）

入群后发两条一对一消息：给群主 `join-notice`，给新人 `welcome`。

三条约束：

1. **欢迎不能由被欢迎者签名** —— `sendPersonMessage` 拒绝自发消息。有群主用群主，没有用保留 id `system`。
2. **两条消息都不带邀请令牌** —— 否则令牌进群主收件箱，正是转发截图的来源。
3. **通知失败不能让入群失败** —— 成员已经落盘了。

#### 行为变更一：`setProfile` 只在真变化时写系统条目

旧版无条件 `appendSystem('X 更新了本群角色')`，导致每次保存都广播 —— 成员观察到的现象是「同一条通知反复刷屏，
间隔从两小时缩到 100 秒」，并合理怀疑「有客户端在循环调用」。

现在比较前后值（tags 两边排序后比较），无变化直接返回 `{ changed: false }`，**且不更新 `profileUpdatedAt`**
（那个字段的含义是「最后修改时间」，空存一次就刷新等于说谎）。

#### 行为变更二：`group/read` 的 `from` 是对象

```js
// 错过的写法（曾存在）
from: entry.from.displayName,
personId: entry.from.personId,

// 正确
from: { personId: entry.from.personId, displayName: entry.from.displayName },
```

`publicEntry` 约定 `from: { personId, displayName }`。降级成字符串后，所有读 `from.displayName` 的消费者拿到
`undefined` —— 而测试只断言了 `from.personId` 和面板文本，所以一直是绿的。

**这条值得记住**：断言「渲染出来的文本」不能代替断言「结构」。

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
    embedded: false,            // true = 本实例自己建群；默认 false，群在共享宿主上
    gatewayBase: '',            // 网关基址，生成邀请链接用
    agentName: '',              // 本实例（或宿主）在网关里的名字，一台实例一个
    inviteExpiresInHours: 168,  // null = 邀请默认永不过期；数字 = 小时数
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

- 每个分支自带 `test/<area>.test.mjs`，用 **Vitest**（`npm test` / `npm run test:all`）。
- **不依赖真实网络/真实 DSH**：`webServer`、`sessionController`、`fs` 都用假对象注入。
- 需要 HTTP 的地方用 `node:http` 起临时端口（`listen(0)`）。
- 断言必须验证**行为**（投递了几次、状态怎么变、密钥有没有泄漏），不是「函数被调用了」。
- **改 UI 相关代码必须做浏览器实操验证**（opencli 驱动真实点击 + 埋点观测），单元测试不算完成。细则见 `test/README.md` 一·五。

  > 这条是血写的：面板不刷新、按钮点两次出两句、接手提示词执行失败——四个 bug 全部在「测试全绿」的状态下存在，因为**没有任何测试真的点过那个按钮**。

## 5. 写域（并行不冲突）

| 分支 | 可写 |
|---|---|
| A `wire-server` | `lib/core/wire.js` `lib/core/server.js` `lib/dsh/deliver.js` | 协议与投递 |
| B `bridge-client` | `lib/core/bridge.js` `lib/core/registry.js` `lib/core/skills-session.js` | 出站调用 |
| C `groups-core` | `lib/core/groups.js` `lib/core/invite.js` `lib/core/memberships.js` `lib/core/skills-group.js` | 群状态机 |
| D `ui` | `client.js` | 浏览器面板 |
| Lead | `lib/index.js` `lib/core/config.js` `lib/shared/*` `lib/mcp/*` `lib/dsh/tools.js` | 装配与适配 |
> 需要改别人文件的接口时：**先发消息**，改 `docs/CONTRACT.md` 的对应段落，再动代码。
