# DSH × A2A × AISIX 落地工作计划（v4 — 架构定稿，执行中）

> 目标：把「DSH 内部会话协作」→「跨平台 A2A 互通（dsh-a2a）」→「企业治理（AISIX 网关）」拼成一条能真正跑起来、能交给同事用的链路，并在其中加入**群协作**。
>
> **v4 变更（重要）**：架构定稿，三层职责重新划清。核心修正是**群宿主不需要模型**，且**群消息不是调度器**。
> 决策与依据见 [`dsh-a2a/docs/DESIGN.md`](dsh-a2a/docs/DESIGN.md)。
>
> **已完成**：`dsh-a2a` 插件 264 测试（263 pass / 0 fail / 1 skip）；整链经 AISIX 验证通过；已装进 3091 隔离实例并真实挂载。
> **进行中**：建纯群宿主 + 双实例入群验证 + 层 A/B 身份。

---

## 0. 一句话结论（v4 修正）

三层各管一件事，**没有跨层调度**：

- **第 3 层 · 持续推动**：`goal` + `round-driver`（DSH 原生）。**不依赖 dsh-a2a**，单机也能自己推进。
- **第 2 层 · 协作**：`dsh-a2a` 群消息/点对点。**宿主是纯信息交换程序，无模型、无 key、无定时。**
- **第 1 层 · 治理**：AISIX 鉴权/ACL/限流/审计。**它从不调度任何人，只放行或拒绝。**

群协作不新增中心智能：**群宿主就是一台轻量程序**，注册成 AISIX 后面的 A2A agent，群成员通过 A2A 加入/发言/订阅。

### 三条硬约束（已实测，非选择）

1. **定时任务不能跨会话**（DSH 官方限制：`delivery outside the original Session ... not supported`）。想用定时推动团队，路径只能是：我的定时 → 唤醒**我自己**的会话 → 我发群消息 → 别人被唤醒。**群是唯一能跨机器唤醒别人的通道。**
2. **群宿主不需要模型**（实测：建群 105ms，`skills-group.js` 零模型依赖，`skills.session:false` 可关掉唯一模型入口）。
3. **唤醒只对活着的进程有意义**。成员关机时消息留存 feed，开机 `sinceSeq` 补拉——这比"网关调度"更健壮，因为调度要求目标在线。

---

## 1. 现状盘点（已实测确认，不是推测）

| 项 | 结论 | 证据 |
|---|---|---|
| AISIX 是否支持 A2A | 支持，`/a2a/:agent` 反向代理，透传 JSON-RPC + SSE | `D:\repos\aisix\crates\aisix-proxy\src\a2a.rs`、`crates\aisix-a2a\src\bridge.rs` |
| Agent Card 路径 | `/a2a/<agent>/.well-known/agent-card.json`（旧 `agent.json` 也认），URL 被改写回网关 | `a2a.rs:5`、`bridge.rs:57` |
| 上游寻址 | 先按注册 URL 的**路径**拼 well-known，再按 **origin** 拼 | `bridge.rs:308-339` |
| 协议版本 | `protocol_version: "1.0"`（默认，PascalCase 方法）/ `"0.3"`（`kind` 判别，小写方法），通过 `A2A-Version` 头下发 | `models/a2a_agent.rs:103-123`、`bridge.rs:51` |
| 方法集 | `message/send`、`message/stream`、`tasks/get`、`tasks/cancel`、`tasks/resubscribe`、`tasks/pushNotificationConfig/*`（1.0 另有 `ListTasks`） | `telemetry.rs:42-90` |
| 流式 | `message/stream`、`tasks/resubscribe` 走 SSE 实时中继，且**不设上游超时** | `a2a.rs:22-29` |
| 鉴权 | 调用方必须带 AISIX API Key（401），再按 `api_keys.allowed_agents` 做 per-agent ACL（403），上游凭证由网关持有 | `a2a.rs:123-211`、`schemas/resources/api_key.schema.json:186` |
| 限额 | 复用 LLM 的 quota 管线；A2A 的 token 只**报告不计费**（估算值不当预算） | `a2a.rs:268-291` |
| 上游凭证 | `auth_type: none/bearer/api_key` + `secret`，网关注入 `Authorization` 或 `x-api-key` | `models/a2a_agent.rs:125-140` |
| **卡片 URL 的 scheme** | **默认 `https`，除非请求带 `X-Forwarded-Proto`**（网关无法知道自己前面有没有 TLS 终结器）——本地 http 联调必须显式带这个头 | 实测：同一请求带/不带该头，`url` 分别为 `http://` / `https://` |
| 卡片 URL 重写范围 | 顶层 `url` + `supportedInterfaces[]`/`additionalInterfaces[].url` 全部改写成网关地址，上游地址不外泄 | `a2a.rs:589-613`，实测上游 `127.0.0.1:3092` 不出现在卡片里 |
| DSH 侧可挂 HTTP 路由 | 有 `webServer` 服务：`register({kind:'exact'|'prefix', path, handler})`，handler 自己拥有完整响应生命周期（可长连 SSE） | `@deepseek-ai/dsh-host-webserver` 类型定义 |
| DSH 侧可注入会话 | `sessionController.prompt()` / `agent.followup|steer|inject`，与 session-bus 用的同一条路 | `dsh-session-bus/lib/bus.js:1584-1671` |
| WSL 里的 aisix 镜像 | 已有 `ghcr.io/api7/aisix:latest`（4 天前，152 MB） | `wsl podman images` |
| WSL 网络限制 | 之前实测 WSL 内核 `CONFIG_NFT_FIB=m` → netavark bridge 不可用，容器统一 `--network host`（本次要复验） | 长期记忆 2026-09-04 |
| 端口红线 | **3080 是用户自己的开发实例，绝不 touch/kill** | 长期记忆 |

---

## 2. 总体架构

```
 同事 A 的 DSH（会话 + dsh-a2a 插件）                同事 B 的 DSH（会话 + dsh-a2a 插件）
   ┌────────────────────────────┐                    ┌────────────────────────────┐
   │ 会话  ←→  dsh-a2a tools    │                    │ 会话  ←→  dsh-a2a tools    │
   │            ↕ A2A 客户端     │                    │            ↕ A2A 客户端     │
   │ 本地投递层（followup/steer）│                    │ 本地投递层（followup/steer）│
   └──────────┬─────────────────┘                    └──────────┬─────────────────┘
              │  POST /a2a/<agent>  (JSON-RPC, x-api-key)        │
              │  SSE  ← message/stream, tasks/resubscribe        │
              ▼                                                  ▼
   ┌──────────────────────────────────────────────────────────────────────┐
   │  AISIX 网关  /a2a/:agent                                              │
   │  · API Key 鉴权  · allowed_agents ACL  · 限流/并发  · 用量&审计       │
   │  · Agent Card 代理（URL 改写成网关）  · SSE 原样中继                  │
   └──────────┬────────────────────────────────────────┬──────────────────┘
              │ 上游凭证由网关持有（x-api-key）          │
              ▼                                        ▼
   ┌────────────────────────┐              ┌────────────────────────┐
   │ DSH「群宿主」实例       │              │ 任意其他 A2A Agent      │
   │  dsh-a2a Server        │              │ (ADK / 其他框架)        │
   │  /a2a  + 群状态 + feed │              └────────────────────────┘
   └────────────────────────┘
```

**数据流（一次群消息）**

1. 同事 A 在自己的会话里说"把这个方案发给群里"，Agent 调 `a2a_group_post`；
2. 插件对群宿主的 `/a2a/<group-agent>` 发 `message/send`（skill=`group/post`），走 AISIX；
3. 群宿主校验成员凭证 → 追加到 feed（带 `seq`）→ 唤醒自己绑定的会话；
4. 其他成员的插件各自持有到群宿主的 `message/stream`（skill=`group/subscribe`，带 `sinceSeq`）长连；
5. 新事件到达 → 成员插件把它当"外部消息"投递进本地会话（`agent-message` 卡片）→ 会话被唤醒开始干活；
6. 会话的回复由 Agent 调 `a2a_group_post` 发回群里，形成闭环。

> 分层含义：**A2A 是跨机器的传输协议，session-bus 的投递/唤醒语义是本地"最后一公里"，AISIX 是门禁。** 三者职责不重叠。

---

## 3. 关键设计决策（想请你先拍板的部分）

### 3.1 A2A 线格式：选 `0.3`

- 理由：`kind` 判别的 JSON 最直白、生态实现最多（a2a-js / ADK）、aisix 两版都支持；1.0 的 protobuf-JSON + PascalCase 方法对我们只是翻译层，前期没必要。
- 做法：AISIX 里显式 `protocol_version: "0.3"`，插件只实现 0.3；1.0 作为后续兼容（识别 `A2A-Version: 1.0` 就返回明确的 `-32004 unsupported version`）。

### 3.2 群 = 一个 A2A Agent（不新增中心服务）

- 群的宿主是**某个 DSH 实例**（一般是在线时间最长的那个，或专门开一个"群主机"实例）。
- 群宿主的 `dsh-a2a` 同时干两件事：对外是 A2A Server（群的门面），对内是会话投递器（把群消息变成宿主会话的回合）。
- 好处：不引入新后端、复用 AISIX 的鉴权/限流/审计、数据留在自己的 DSH 里（企业内更易过审）。
- 代价：宿主离线 = 群不可用。缓解：① 文档里建议用常开实例当群主；② 群状态可导出/导入，便于迁移。

### 3.3 认证是两段式（这是"群有密码"的落点）

| 阶段 | 凭证 | 谁持有 | 作用 |
|---|---|---|---|
| 网关门禁 | AISIX API Key | 每个同事各自一份，由管理员下发，存本地插件设置 | 证明"你有权用这个网关、有权访问这个 agent"（`allowed_agents` 精确到 `group-xxx`） |
| 入群门禁 | 邀请令牌 `t` + 群密码 | 令牌在邀请链接里，密码由 IM 另行告知 | 证明"你被邀请且知道口令"；防止链接被转发泄露 |

- 兑换成功后下发**成员凭证 `memberKey`**（32 字节随机），之后发帖/订阅只带它，密码不再上链路。
- 密码只存 `scrypt` 哈希；令牌只存哈希 + 过期时间 + 可用次数（默认 7 天 / 5 次），可撤销、可轮换。

### 3.4 唤醒复用 session-bus 的通道语义

- 不复制 session-bus 的整套代码，只复用**它对 Host 的用法**：`agent.followup()` / `agent.inject()` / `agent.steer()` + `source.kind='agent-message'`（左侧"收到任务消息"卡片，而不是伪装成本人输入）。
- 同时保留 session-bus 的两个硬约束：**幂等**（同 `messageId` 不重复投递）与**环路预算**（跨 agent 的往来也计 hop，避免两个 Agent 互相刷）。
- 如果 session-bus 在场，插件**优先**通过它投递（拿到线程/租约/审计的既有能力），否则走内置的等价实现。

---

## 4. `dsh-a2a` 插件设计

### 4.1 目录结构

```
E:\dsh-a2a-bus\dsh-a2a\
├─ package.json            # 零外部依赖（同 session-bus 的自包含约束）
├─ cordis.patch.yml        # bundle patch，insert id: a2a
├─ README.md
├─ lib/
│  ├─ index.js             # apply(ctx, config)：注册 webServer 路由 + tools + prompt section
│  ├─ config.js            # 配置归一化（server/client/groups/limits）
│  ├─ rpc.js               # JSON-RPC 2.0 封装、错误码、SSE writer、请求体读取
│  ├─ card.js              # Agent Card 生成（skills 列表由已启用能力推导）
│  ├─ server.js            # /a2a 与 /a2a/.well-known/agent-card.json 路由
│  ├─ tasks.js             # Task 存储（内存 + 落盘 + TTL + 变更事件）
│  ├─ skills/
│  │  ├─ session-ask.js    # session/ask：把消息投进本机会话并等它答完
│  │  ├─ group-*.js        # group/create|join|invite|post|read|subscribe|members|leave|cancel
│  │  └─ ping.js           # 健康自检
│  ├─ bridge.js            # A2A 客户端：卡片缓存、send、stream(SSE)、重连
│  ├─ registry.js          # 已登记的对端 agent（本地 a2a_agents 表）
│  ├─ groups.js            # 群状态机 + 加密 + 成员表 + feed + 邀请
│  ├─ inbox.js             # 已加入群的订阅器：SSE → 会话投递（幂等 + hop）
│  ├─ deliver.js           # 本地投递适配（session-bus 优先，否则内置）
│  ├─ tools.js             # 面给模型的工具
│  └─ prompt.js            # 系统提示词段（群礼仪 / 何时该发群 / 不要刷屏）
├─ scripts/install.ps1
└─ test/                   # node --test，纯本地、不依赖网关
```

### 4.2 Server 端（对外是标准 A2A Agent）

| 路由 | 说明 |
|---|---|
| `GET /a2a/.well-known/agent-card.json` | Agent Card（`name`/`description`/`url`/`version`/`capabilities`/`skills`/`securitySchemes`） |
| `GET /a2a/.well-known/agent.json` | 旧路径别名（兼容） |
| `POST /a2a` | JSON-RPC 入口，`message/send` / `tasks/get` / `tasks/cancel` |
| `POST /a2a` + `message/stream` | SSE：先发 `submitted` → 干活过程中的 `status-update`（`working`）→ 结果 `artifact-update` → `completed`（`final:true`） |

- **鉴权**：`server.token`（Bearer 或 `x-api-key`），网关用它作为 `a2a_agents[].secret` 反向注入；本机直连时也用它。
- **绑定会话**：`server.bindSession`，创建时自动写成"当前会话"。收到 `session/ask` 就把文本投进该会话，等这一回合 `turn/end`，取最后一条助手消息作为 artifact。
- **超时与取消**：默认 10 分钟上限（可配），`tasks/cancel` → 中断该回合。

### 4.3 Client 端（面给模型的工具）

| 工具 | 作用 |
|---|---|
| `a2a_discover` | 拉对端 Agent Card（支持 `gw://<name>` 或直连 URL），返回技能清单 |
| `a2a_send` | 向对端发消息并等待结果（内部 `message/send`），支持 `skill` + `data` |
| `a2a_stream` | `message/stream`，把事件推进本地会话（长任务的进度可见） |
| `a2a_read` | `tasks/get` 取任务当前状态/历史 |
| `a2a_cancel` | `tasks/cancel` |
| `a2a_agents` | 本地登记簿：增删查对端（`name → {url|gateway, agent, apiKeyRef}`） |

### 4.4 群相关工具（用户视角就是"会话里建群"）

| 工具 | 作用 |
|---|---|
| `a2a_group_create` | 建群：`name` / `topic` / `password`（不给则生成强口令）/ `joinPolicy`；返回群 id |
| `a2a_group_invite` | 生成**邀请链接 + 可直接粘贴到 IM 的提示词**（含口令占位、过期时间、可用次数） |
| `a2a_group_join` | 用邀请链接 + 口令入群（内部走上文握手），成功后自动开启订阅器 |
| `a2a_group_post` | 往群里发消息（可带 `payload`/附件路径） |
| `a2a_group_read` | 读群 feed（`sinceSeq` 增量） |
| `a2a_group_members` | 成员与在线状态 |
| `a2a_group_leave` / `_revoke` | 退出 / 撤销邀请 / 移出成员 |
| `a2a_group_inbox` | 订阅器开关与自检（`on/off/status`） |

---

## 5. 群协议细节（这是本方案的核心新增）

### 5.1 数据模型（宿主侧持久化 `<DSH_HOME>/a2a/groups.json`）

```jsonc
{
  "groups": [{
    "id": "g-7f3a1c",
    "name": "发票重构攻坚",
    "topic": "把 invoice 服务拆干净",
    "createdAt": "2026-11-03T09:00:00Z",
    "owner": { "memberId": "m-owner", "displayName": "牛昆仑" },
    "passwordHash": "scrypt$...",           // 只存哈希
    "joins": [{                              // 邀请令牌（只存哈希）
      "tokenHash": "...", "label": "给张工",
      "expiresAt": "...", "maxUses": 5, "uses": 2, "revoked": false
    }],
    "members": [{
      "memberId": "m-3b2e", "displayName": "张工",
      "role": "member",                       // owner | member
      "keyHash": "sha256(...)",               // 成员凭证只存哈希
      "joinedAt": "...", "lastSeenAt": "...",
      "endpoint": "gw://dsh-zhang"            // 可选，用于反向上报
    }],
    "feed": [{                                // 追加写，按 seq 单调
      "seq": 12, "at": "...", "msgId": "uuid",
      "from": { "memberId": "m-3b2e", "displayName": "张工" },
      "kind": "message",                      // message | system
      "text": "……", "payload": { }
    }],
    "settings": { "wakeMembers": true, "retentionDays": 30, "maxPostChars": 32000 }
  }],
  "nextSeq": 42
}
```

### 5.2 邀请链接格式

```
dsh-a2a://group?v=1&url=<群宿主A2A端点直连>&gw=<网关基址>&agent=<AISIX 中的 agent 名>
                 &g=<groupId>&t=<邀请令牌>&n=<群名>&e=<过期时间>
```

- `gw`+`agent` 与 `url` 二者取一（企业走网关，本地联调直连）。
- **链接里没有密码**：口令由群里口头/另信告知（这是"群有密码"的第二因子）。
- 令牌一次性短时有效，`a2a_group_invite` 每调一次生成一个，便于"发给谁、用了几次、可撤销"。

### 5.3 生成的提示词（IM 里粘贴给同事，模型可直接执行）

```
我在 DSH 里建了个协作群「{群名}」，邀请你加入。

把下面这一行贴到你的 DSH 会话里直接发送即可：
/a2a-join dsh-a2a://group?v=1&gw=https://gw.ict.cmcc&agent=group-7f3a1c&g=g-7f3a1c&t=tok_xxx&n=发票重构攻坚

如果你更愿意用自然语言：
  用 a2a_group_join 加入这个群：<同一链接>，群密码：{password}

入群后：群里有人 @ 你或发任务时会自动出现在你会话里（左侧"收到任务消息"卡片），
直接回复就是在群里回话。想退出用 a2a_group_leave；想静音用 a2a_group_inbox off。
（此邀请 {expiresAt} 前有效，最多可用 {maxUses} 次。）
```

> 后续可选：把这段文本用 `de_channel_send` / Matrix 直接推到 IM，省掉手工复制（本期先只生成文本，避免耦合 IM 凭据）。

### 5.4 加入握手（全部走 A2A 标准方法，不发明私有 HTTP 端点）

```
同事插件                                 AISIX                         群宿主插件
  │  message/send {skill:"group/join",      │                               │
  │   data:{groupId, token, password,       │──鉴权+ACL+限流──────────────▶│ 校验令牌/密码
  │        member:{displayName, endpoint}}} │                               │ 生成 memberId/memberKey
  │◀──────────── artifact: {memberId, memberKey, group:{...}, feedTail:[...]} ┘
  │                                                                           │
  │  message/stream {skill:"group/subscribe", data:{memberId, memberKey, sinceSeq}}
  │◀════════ SSE: 每条新帖 → status-update（final:false），心跳 15s ═══════════╡
  │  → 本地投递给会话（幂等：按 msgId 去重；hop：每次投递 +1）
  │                                                                           │
  │  message/send {skill:"group/post", data:{memberId, memberKey, text}}  ────▶ feed += 1
  │                                                      → 推给所有订阅者 + 唤醒宿主会话
```

- **断线重连**：客户端记 `lastSeq`，重连时用 `sinceSeq` 增量补；服务端保留 feed 至少 `retentionDays`。
- **不能长连时**（某些代理会掐 SSE）：降级为 `group/read` 轮询（默认 20s，可配）。
- **成员身份**：`memberKey` 是唯一凭证；改显示名/撤销成员只需服务端删哈希。

### 5.5 权限与反滥用

| 风险 | 措施 |
|---|---|
| 链接被转发 | 令牌哈希 + 过期 + 次数上限 + 可撤销；仍需密码 |
| 成员刷屏 / 环路 | 每成员令牌桶（默认 20 条/分钟）；跨 agent hop 计数，超 16 拒绝并提示收线（复用 session-bus 的措辞） |
| 大消息 | `maxPostChars`（默认 32k），超长提示改用附件路径 |
| 凭证泄漏 | `groups.json` 只存哈希；日志脱敏 `token`/`password`/`memberKey`；文件权限 600 |
| 冒充 | AISIX 侧 `allowed_agents` 精确到群 agent；宿主侧校验 `memberId+memberKey` 双因子 |

---

## 6. AISIX 侧配置（开发 + 生产同一套形状）

```yaml
# resources.yaml
a2a_agents:
  - name: "group-7f3a1c"          # 群的对外名字（也是 /a2a/<name> 的路径段）
    url: "http://192.168.3.7:3091/a2a"
    protocol_version: "1.0"       # 决策：统一 1.0（PascalCase 方法 + oneof payload）
    auth_type: api_key            # 网关注入 x-api-key，值是 dsh-a2a 的 server.token
    secret: "<dsh-a2a server.token>"
    timeout_ms: 600000            # 长任务；流式调用不受此限制
    enabled: true

api_keys:
  - display_name: "niukl"
    allowed_models: ["*"]
    allowed_agents: ["group-*"]   # 只给他能进的群；也可逐个写死
    key_hash: "<sha256(明文key)>"

rate_limit_policies:
  - name: "a2a-rl"
    # 具体字段按 schema 填：每 key 每秒/每分钟请求数 + 并发上限
```

- **一人一把网关 Key**：管理员分发，同事填进插件设置 `client.apiKey`。
- **卡片取用必须带 `X-Forwarded-Proto`**（本地 http 联调）或让网关前置真实 TLS 终结器；否则卡片里的 `url` 会是 `https://`，客户端连错端口会超时。插件侧兜底：把 `A2A-Version` 与 `X-Forwarded-Proto` 一起发，并在卡片 URL 与所配端口不一致时按配置直连。
- 观测：`/metrics` 上按 agent 维度的 `a2a` 计数器；用量看板的 token 数为"估算值、只报不计费"（AISIX 就这样设计）。

---

## 7. 开发环境（按你的要求：WSL + podman 起 AISIX）

### 7.1 拓扑

```
Windows                                          WSL (Ubuntu 24.04, podman 4.9.3)
┌────────────────────────────────────┐          ┌──────────────────────────────────┐
│ DSH 开发实例（3091，独立 DSH_HOME）│          │ issix 容器 --network host        │
│  dsh-a2a server → :3091/a2a        │◀─────────│  proxy   :3000                   │
│  （3080 不动）                     │          │  admin   :3001                  │
└────────────────────────────────────┘          │  metrics :9090                   │
                                                └──────────────────────────────────┘
```

### 7.2 为什么用独立 DSH 实例（3091）而不是 3080

- 插件装进 profile 必须重启进程才生效；**3080 是你的红线**，重启会打断你正在用的会话。
- 所以：`DSH_HOME=C:\Users\niukl\.dsh-a2a-dev`，`dsh web --port 3091`，插件用 `link:` 指向仓库源码，改完热重载/重启都在这个实例里。
- 联调通过后，再由你决定什么时候把它装进 3080 的 web profile。

### 7.3 具体步骤 —— **已实测通过，脚本已固化**

一键脚本 `scripts/aisix-dev/aisix-dev.sh`（在 WSL 里跑）：

```sh
./aisix-dev.sh up       # 起网关 + mock 上游
./aisix-dev.sh smoke    # 22 条断言端到端验证
./aisix-dev.sh reload   # 改完 resources.yaml 后 SIGHUP 热载
./aisix-dev.sh status / down / logs
```

它做的事：把 `config.yaml` + `resources.yaml` 同步进 `~/aisix-dev/data`，用 `--network host` 起两个容器（网关 + mock 上游），等 `/livez`，然后逐条打真实 HTTP 请求。

### 7.4 实测结论（P0 证据，2026-11-03）

| 检查项 | 结果 |
|---|---|
| WSL podman 起 AISIX | 成功，`aisix 1.8.0`，镜像 152 MB，3 秒内 `/livez` |
| `aisix validate --resources` | `OK: loaded 3 resource(s)` |
| netavark bridge | 仍然不可用 → **一律 `--network host`**（与长期记忆一致） |
| 容器 ↔ Windows 主机 | `container → 192.168.3.7:3080` TCP 通；`container → 192.168.3.7:3092` 也通，但**实测网关抓卡片会卡住超时**（跨 WSL/Windows 边界 + reqwest 连接行为的组合问题） |
| **结论：mock 上游放进 WSL 容器** | 一切正常，`gateway=200 t=0.019s` |
| 卡片经网关取回 | `url` 与 `supportedInterfaces[].url` 均改写为 `http://127.0.0.1:3000/a2a/mock-a2a`，上游 `127.0.0.1:3092` 不外泄 |
| `SendMessage`（1.0 oneof） | 返回 `{"result":{"task":{…}}}`，`TASK_STATE_COMPLETED` |
| `SendStreamingMessage` | SSE 6 个事件逐个透传（submitted → 3×working → artifact → completed） |
| 上游收到的东西 | `a2a-version=1.0`、`api-key-present=true`（网关持有的密钥），**调用方 Key 未转发** |
| 鉴权/ACL | 无 Key→401、错 Key→401、未注册 agent→404 |
| 观测 | `/metrics` 有 `aisix_a2a_requests_total`、`aisix_a2a_stream_events_total`、`aisix_a2a_task_state_total` |

> **给 dsh-a2a 的直接结论**：DSH 在 Windows 上、网关在 WSL 里，这是可行的（`container → 192.168.3.7:3080` TCP 通）。但**mock 阶段发现跨边界抓卡片会超时**，所以 P1 的第一件事是用真实 DSH 复验「网关 → Windows DSH」的卡片抓取；若同样超时，退路是（a）把 DSH 也放进 WSL，或（b）让网关直连 `host.docker.internal` 等价地址，或（c）在生产里把 DSH 与网关放在同一台 Linux 上。**这一点必须在写插件前验掉，否则会误判成插件 bug。**

---

## 8. 分阶段计划

| 阶段 | 内容 | 交付物 | 验收标准 | 估时 |
|---|---|---|---|---|
| **P0 环境** | WSL podman 起 aisix；生成 key/token；写 `scripts/aisix-dev/*`（compose/run + resources.yaml 模板 + 冒烟脚本）；用 Node 写一个**假上游 A2A agent** 验证网关链路 | `scripts/aisix-dev/`、`test/mock-agent.mjs` | 卡片被正确改写；`message/send` 与 SSE 都能穿过网关；Windows↔WSL 双向通 | 0.5d |
| **P1 骨架** | dsh-a2a 插件骨架：config/rpc/card/server/tasks + `session/ask` 技能 + 绑定会话 | `dsh-a2a/lib/*`、单测 | 经网关 `session/ask` → 3091 实例被唤醒并回答，结果以 artifact 返回 | 1.5d |
| **P2 客户端** | `bridge.js`（卡片缓存 / send / SSE / 重连）、`a2a_*` 工具、`registry` | 工具集 | 会话里 `a2a_discover` 一个对端并 `a2a_send` 拿到答复；长任务能看进度 | 1d |
| **P3 群核心** | `groups.js`（状态/加密/邀请/成员/feed）、`group/*` 技能、`inbox.js`（订阅→唤醒）、群工具与提示词模板 | 群能力 | 两台 DSH（3091 + 另一起一个）互加群：建群→生成链接+提示词→另一台 `a2a_group_join`→A 发帖→B 会话被唤醒并自动回帖 | 2d |
| **P4 加固** | 幂等、hop 预算、令牌桶、脱敏、审计日志、`install.ps1`、README、单测补全 | 可交付包 | `node --test` 全绿；重复投递不重复进会话；刷屏被限；日志无明文密钥 | 1d |
| **P5 治理收尾** | AISIX 侧正式配置（一 key 一人、allowed_agents、限流策略、metrics 看板）、运维手册、演示脚本 | `docs/aisix-setup.md`、演示脚本 | 用真实 API Key 走网关完成一次跨人协作演示；`/metrics` 能看到按 agent 的调用与事件数 | 0.5d |

**合计约 6.5 天**（单线程；P1/P2 与 P3 的前置状态机部分可以并行）。

---

## 9. 风险与规避

| 风险 | 影响 | 规避 |
|---|---|---|
| A2A 版本不一致（网关默认 1.0） | 方法名/字段对不上，直接 400 | 显式 `protocol_version: "0.3"`；插件对 `A2A-Version` 做显式校验并返回可读错误 |
| 群宿主离线 | 群整体不可用 | 文档建议常开实例当群主；群状态可导出/导入迁移；客户端 `a2a_group_read` 重试 |
| SSE 被中间设备掐断 | 消息不实时 | `sinceSeq` 断点续传 + 轮询降级 + 心跳 |
| WSL 容器 ↔ Windows DSH 不通 | 联调阻塞 | P0 首项就验证；备选 `netsh portproxy` / 换绑定地址 |
| 插件装进 profile 需重启 | 打断 3080 会话 | 一律用 3091 独立实例开发，3080 只在用户同意时升级 |
| 两个 Agent 互相刷消息 | 烧 token | hop 预算（默认 16）+ 每成员令牌桶 + 明确"收线"语义 |
| 群消息含敏感内容 | 合规风险 | 数据只在成员自己的 DSH 落盘；AISIX 只做转发不存储；内容捕获默认关闭 |

---

## 10. 已拍板的 5 个选择（v2 确定，v3 已按此实现）

1. **A2A 线格式**：**1.0**（PascalCase 方法 + `oneof` payload）。实现时对 `final:true` 的语义做了严格化：它表示"流结束"，只允许出现在终止态。
2. **群宿主形态**：**专开一台常开实例当群主机**。群状态、feed、成员表都在宿主上，成员离线不影响群。
3. **网关 Key 粒度**：**一人一把**，`allowed_agents` 精确到群。
4. **本期 UI**：**做左侧群面板**。`client.js` 已挂在 `sidebar.panellist` 槽（id `a2a-groups`，与 `main` 槽同 id），23 个用例通过；数据源接 `remote.a2a` 是最后一步。
5. **IM 送达**：**只生成「邀请链接 + 提示词」文本，手动复制**。提示词里含 `dsh-a2a://group?...` 链接、密码提示、有效期、可用次数。

---

## 11. 开工前我先做的事（你点头后立刻执行）

1. 复验 WSL podman 网络模式与 Windows↔WSL 连通（P0 第一项，失败就当场给备选方案）；
2. 写 `scripts/aisix-dev` 一键起停 + `mock-agent.mjs`，把网关链路先跑通（**这一步不需要动 DSH**）；
3. 再起 3091 独立实例，装 dsh-a2a 骨架，做 `ping` + `session/ask` 冒烟；
4. 每完成一个阶段给你一份"实测证据"（命令 + 输出），不写没验证过的结论。
