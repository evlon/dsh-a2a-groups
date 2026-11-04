# 架构

## 一、全貌

```
┌─────────────────────────────────────────────────────────────────┐
│ ① 网关（AISIX，可选）                                            │
│    /a2a/agent-group-host  → 转发到群宿主                        │
│    /a2a/agent-person-*    → 转发到各人的 DSH（点对点时用）       │
│    职责：鉴权、限流、审计、卡片 URL 改写                          │
└─────────────────────────────────────────────────────────────────┘
                              ↓ 出站
┌─────────────────────────────────────────────────────────────────┐
│ ② 群宿主（独立 Node 程序，一台）                                  │
│    bin/agent-groups.js  →  lib/core/server.js                   │
│    存 groups.json：群、成员、消息、persons、一对一消息            │
│    不加载大模型、不消耗 Token                                     │
└─────────────────────────────────────────────────────────────────┘
                              ↑ 出站订阅（SSE）
┌─────────────────────────────────────────────────────────────────┐
│ ③ 成员（每人一个 DSH 实例）                                      │
│    lib/index.js → DSH 插件，或 lib/mcp-server.js → MCP 客户端     │
└─────────────────────────────────────────────────────────────────┘
```

**关键点**：成员的连接是**出站**的。成员主动连宿主订阅，宿主从不主动拨号给成员。

这决定了两件事：

- 成员不需要固定 IP、不需要在网关注册、不需要被访问
- 加人 **零运维**（不产生新的网关条目）

---

## 二、目录边界：一句话判断文件该放哪

```
lib/
├── core/     零 DSH 依赖，任何宿主可复用      15 个文件
├── dsh/      唯一读 ctx 的地方                 7 个文件
├── shared/   两个宿主共用，谁也不属于          2 个文件
├── mcp/      唯一读 MCP 协议的地方             1 个文件
├── index.js      DSH 插件入口（包 main）
└── mcp-server.js MCP 入口（bin: agent-groups-mcp）
```

| 目录 | 判据 | 文件 |
|---|---|---|
| `core/` | 不 import `ctx` | groups, memberships, invite, card, wire, server, bridge, registry, skills*, probe, config, endpoint, colleague-cards |
| `dsh/` | 读 `ctx` | deliver, sessions, inbox, tools, toolkit, profile, prompt |
| `shared/` | 纯数据 + 纯逻辑 | tool-specs, tool-runtime |
| `mcp/` | 为「没有 DSH 的进程」接线 | mcp-deps |

**这条边界可检查**：

```bash
grep -rn '\bctx\b' lib/ --include='*.js' | grep -v '^lib/dsh/' | grep -v '^lib/index.js'
```

除注释外只剩 `core/server.js` 的 **2 处**（`ctx` 解构参数与 `ctx?.webServer`），都是**可选注入** —— 有 `ctx` 就用，
没有就靠调用方传入。这正是同一份代码能同时服务插件和独立宿主的原因。

> 实测命令（2026-11-04）：`grep -rn '\bctx\b' lib/core lib/shared lib/mcp --include='*.js' | grep -vE "^\S+: *(\*|//)"`
> → 2 行。之前这里写「3 处」是估的，写文档时按实际数了一遍才发现。

---

## 三、核心模块

### `core/groups.js`（2834 行）—— 群状态机

**唯一的真相来源。** 所有群、成员、消息、persons 表、一对一消息都在这里。

导出 40+ 个函数，关键几组：

| 组 | 函数 |
|---|---|
| 群生命周期 | `create` `invite` `join` `leave` `requestJoin` `decideRequest` `claimJoin` |
| 群内 | `post` `read` `subscribe` `members` `snapshot` `setProfile` |
| 群管 | `removeMember` `renameGroup` `archiveGroup` |
| 人 | `personProfile` `setPersonProfile` `listPersons` `touch` |
| 一对一 | `sendPersonMessage` `listPersonMessages` `ackPersonMessages` `isPersonOnline` |

**设计要点**：

- 密码用 scrypt，令牌/密钥用 sha256，**落盘永不明文**
- `tokenHash` 在群记录里，明文令牌只在生成时返回一次
- `subscribe(groupId, fn)` 是内存订阅，进程重启后由成员重连恢复

### `core/memberships.js`（347 行）—— 成员账本

**每个 DSH 实例自己的账**（`memberships.json`），键是 `(sessionId, groupId)`。

```js
{
  sessionId, groupId, personId, personKey,
  local,          // 群是否托管在本机
  baseUrl,        // 宿主地址（含 agent 名）
  groupName, memberCount, lastSeq,  // 缓存，用于离线时显示
  members,        // 名册缓存
}
```

**为什么键是 `(sessionId, groupId)`**：一个 DSH 可以有多个会话，同一台机器上的两个会话可以是两个不同的成员。

### `core/server.js`（1240 行）—— A2A 1.0 服务端

- PascalCase 方法名、`oneof` payload、`TASK_STATE_*` 枚举
- SSE 流（`SendStreamingMessage`）+ 心跳
- 鉴权：Bearer token 或 loopback

**关键取舍**：`registrar` 注入而非硬读 `ctx.webServer`，见 §二。

### `core/bridge.js`（1079 行）—— A2A 客户端

- `discover()` 拿卡片并缓存
- `send()` 一元调用
- `stream()` SSE
- **卡片 url 与 baseUrl 冲突时用 baseUrl**（网关会把 url 写成 https，本地是 http）

### `core/skills-group.js`（1140 行）—— 宿主暴露的 22 个 skill

`group/*` 18 个 + `person/*` 4 个（`send` `profile` `inbox` `ack`），共 22 个。

**这是 A2A 层的 API**，和工具层同名但不同层：工具是「给人用的」，skill 是「给 A2A 调用方用的」。

### `shared/tool-specs.js`（1112 行）+ `shared/tool-runtime.js`（1296 行）

**26 个工具，两份文件，一份契约一次实现。**

```
tool-specs.js     纯数据：name / description / parameters / output.schema / render
tool-runtime.js   纯逻辑：createToolRuntime(deps).call(name, args, {sessionId})
```

**为什么拆开**：DSH 插件和 MCP server 需要**逐字节相同**的描述和 schema。分开写会漂移。

### `dsh/inbox.js`（622 行）—— 群消息订阅

- 每个群一条 SSE 订阅，断线重连带 `sinceSeq` 续传
- 心跳 15 秒，presence 刷新 50 秒
- 三档投递：`mention`/`notice` 唤醒，`ambient` 只进未读

---

## 四、两条数据流

### 群消息如何到达成员

```
成员 DSH 启动
  ↓ 出站
inbox 打开 SSE：bridge.stream → 网关 → 宿主 group/subscribe
  ↓
宿主保持连接，有新帖 emit('post')
  ↓
成员收到 → 按 mentions 分级 → 投递进会话
  ↓
连接断了自动重连，带 sinceSeq 补收
```

### 一对一消息如何送达

```
发送方 person/send
  ↓
宿主 sendPersonMessage → 存进 directMessages
  ↓ 返回 {dmId, online}
发送方看到「已邀请，对方在线/不在线」
  ↓
接收方上线，inbox 轮询 person/inbox（10 秒一次）
  ↓
投递进会话 → 自动 person/ack
  ↓
发送方的 deliveredAt 被标记
```

**强确认的意义**：`deliveredAt` 由**接收方**写，不是发送方的 HTTP 返回。一个只证明「请求发出去了」的实现，会在对方没收到时显示「已送达」。

---

## 五、身份模型

```
personId    一个人。跨群、跨会话唯一。
  ├── group.members[] 里的行    群内身份（role / roleAbout / tags）
  └── persons[] 里的行          全局画像（headline / tags）

personKey   每个群一份凭证。只在群内有效。
```

**为什么不是同一个东西**：
- `role` 是**权限位**（能否发邀请）—— 客观
- `roleAbout`/`tags` 是**自我声明**（在这个群负责什么）—— 主观
- `headline` 是**跨群的自我描述**（我是谁）—— 名片数据源

混在一起会让「我是 PM」变成「我能踢人」。

---

## 六、两种宿主形态

| | DSH 插件 | MCP server |
|---|---|---|
| 入口 | `lib/index.js` | `lib/mcp-server.js` |
| 传输 | `ctx.webServer` / Connection RPC | stdio JSON-RPC |
| 工具来源 | `shared/tool-specs.js` | 同一份 |
| 界面 | 侧边栏 + 成员栏 + 名片 | 无 |
| 推送 | SSE 订阅群消息 | **不能**（协议限制） |

**共用 `shared/` 的代价与收益**：多一层间接，换来 26 个工具的契约只写一次。

---

## 七、面板写入通道（DSH 版特有）

面板渲染在任何会话之前，**拿不到成员凭证**。所以它不能直接调工具。

```
面板（浏览器）
  ↓ ctx.connection.rpc.call('/a2a-panel', 'profile', {...})
DSH 的 Connection 传输（同源、已鉴权）
  ↓
插件（Host 进程，持有全部凭证）
  ↓ groups.setProfile()
磁盘
```

**为什么不把 personKey 发到页面**：DOM 对任何浏览器扩展、任何 XSS 都可见。凭证留在宿主进程，页面永远看不到。

**踩过的坑**（详见 `RUNBOOK.md`）：
- `ctx.connection.rpc.handle` 从插件 fiber 调用会抛 `cannot get property "webServer" without inject`（上游 bug #8414），**必须用 `ctx.root`**
- 浏览器侧不是 `createWebConnectionRpc`，而是 `ctx.connection.rpc.call`
- `dsh.client.inject` 是**模块表**，不声明就 require 不到

---

## 八、测试策略

| 层 | 方式 | 数量 |
|---|---|---|
| 纯逻辑 | `node --test`，无宿主 | 427 |
| 集成 | 真实 HTTP `listen(0)` | 含在内 |
| 独立宿主 | `scripts/standalone-probe.mjs`，24 断言，全程无 DSH | — |
| MCP | `scripts/mcp-probe.mjs`，13 断言，spawn 真进程 | — |

**约定**：拒绝路径和成功路径都要测，并且断言拒绝**没有副作用**（没写文件、没投递）。

**测试覆盖不到的地方**（实际踩过）：

- 工具只断言返回值，**不断言它不抛 ReferenceError** → 三个核心工具曾 100% 崩溃而测试全绿
- 断言面板文本，**不断言字段结构** → `from` 被降级成字符串，测试没发现

---

## 九、扩展点

| 想加什么 | 改哪里 |
|---|---|
| 新工具 | `shared/tool-specs.js` 加 spec + `tool-runtime.js` 加 handler |
| 新 A2A 能力 | `core/skills-group.js` 加 skill |
| 新群属性 | `core/groups.js` 的 `GroupRecord` + `sanitizeGroup` |
| 新宿主 | 实现 `core/server.js` 要的 deps，参考 `bin/agent-groups.js` |
| 新客户端 | 复用 `shared/tool-runtime.js`，参考 `mcp-server.js` 的 `createHostDepsFromEnv` |

---

## 十、性能与限制

| 项 | 当前值 | 说明 |
|---|---|---|
| 群数量上限 | 1000 | `MAX_GROUPS` |
| 单群成员上限 | 500 | — |
| 消息保留 | 按 `retentionDays` 裁剪 | 默认不限 |
| 一对一消息 | 2000 条上限，先丢已送达的 | `MAX_DIRECT_MESSAGES` |
| SSE 心跳 | 15 秒 | 防中间层掐断 |
| presence 刷新 | 50 秒 | 必须 < `ONLINE_WINDOW_MS`（120 秒） |

**存储是单个 JSON 文件**（`groups.json`），原子写（写临时文件再 rename）。

当前规模够用。如果群数上千、消息百万级，需要换存储 —— 但那是另一个量级的问题。
