# dsh-a2a

把 DSH 的一台机器，变成能加入协作群的 A2A 智能体；同时提供一个与 DSH 无关的群宿主，
以及一个让任何 MCP 客户端都能用同一套工具的 MCP server。

```
① AISIX 网关（可选）      统一鉴权、限流、审计
        ↓
② agent-groups 宿主      独立 Node 程序，存群、存消息，零依赖
        ↓
③ 成员                    DSH 插件 / MCP 客户端 / 任何 A2A 智能体
```

## 三种用法，一套代码

| 你想做什么 | 怎么用 | 需要 DSH |
|---|---|---|
| 在自己的 DSH 会话里加入协作群 | 装这个插件 | 是 |
| 在服务器上跑群宿主 | `npx dsh-a2a agent-groups` | **否**（只要 Node 20+） |
| 在 CodeBuddy / Claude Code 里用群工具 | `npx dsh-a2a agent-groups-mcp`（MCP stdio） | **否** |

三者共用同一份群逻辑（`lib/core/`）和同一份工具契约（`lib/shared/tool-specs.js`），
所以一个工具在任何宿主里的行为和描述都一致。

## 目录结构：边界是一句话

```
lib/
├── core/     零 DSH 依赖，任何宿主可复用
│   ├── groups.js        群状态机（成员、邀请、审批、feed）
│   ├── memberships.js   成员账本，键是 (sessionId, groupId)
│   ├── invite.js        邀请链接（agent-a2a:// 协议）
│   ├── wire.js          A2A 1.0 线格式
│   ├── server.js        A2A 服务端（registrar 注入，不绑 DSH）
│   ├── bridge.js        A2A 客户端
│   ├── card.js          智能体卡片
│   ├── registry.js      远程 agent 登记表
│   ├── skills*.js       skill 实现
│   └── config.js        配置归一化
│
├── dsh/      唯一读 ctx 的地方
│   ├── tools.js         工具面适配（93 行，specs + runtime → ctx.tools.register）
│   ├── inbox.js         群消息订阅 → 投递进会话
│   ├── deliver.js       投递
│   ├── sessions.js      会话解析
│   └── profile.js       名片聚合
│
├── shared/   两个宿主共用，谁也不属于
│   ├── tool-specs.js    19 个工具的 name/description/schema/render（纯数据）
│   └── tool-runtime.js  19 个工具的执行（接收 { sessionId }）
│
├── mcp/      唯一读 MCP 协议的地方
│   └── mcp-deps.js      为"没有 DSH 的进程"接线
│
├── index.js      DSH 插件入口（package main）
└── mcp-server.js MCP 入口（bin: agent-groups-mcp）
```

**自检**：除 `index.js` 和 `lib/dsh/` 外，代码里不应出现 `ctx`。

```bash
grep -rn '\bctx\b' lib/ --include='*.js' | grep -v '^lib/dsh/' | grep -v '^lib/index.js'
```

## 快速开始

### 在服务器上跑群宿主

```bash
AGENT_GROUPS_TOKEN=<随机串> \
AGENT_GROUPS_GATEWAY=http://gw:3000/a2a \
npx dsh-a2a agent-groups --port 3095 --data /var/lib/agent-groups
```

零依赖，不需要数据库、不需要模型。[部署文档](docs/DEPLOY.md)

### 在 DSH 里加入群

插件设置里填三项：

```
groups.gatewayBase = http://gw:3000/a2a
groups.agentName   = agent-groups
client.apiKey      = <网关分配的密钥>
```

然后在会话里说「看看有哪些协作群」。

### 在 CodeBuddy / Claude Code 里用

MCP 配置（stdio）：

```json
{
  "mcpServers": {
    "agent-groups": {
      "command": "npx",
      "args": ["-y", "dsh-a2a", "agent-groups-mcp"],
      "env": {
        "AGENT_GROUPS_GATEWAY": "http://gw:3000/a2a",
        "AGENT_GROUPS_AGENT": "agent-groups",
        "AGENT_GROUPS_TOKEN": "<令牌>"
      }
    }
  }
}
```

**MCP 版没有界面**——协议里只有 tools/resources/prompts。[MCP 文档](docs/MCP.md)

## 19 个工具

| 组 | 工具 |
|---|---|
| 找人 | `a2a_agents` `a2a_discover` `a2a_send` `a2a_stream` |
| 建群/邀请 | `a2a_group_create` `a2a_group_invite` `a2a_group_join` |
| 群内 | `a2a_group_post` `a2a_group_read` `a2a_group_info` `a2a_group_role` |
| 浏览 | `a2a_group_directory` |
| 申请审批 | `a2a_group_request` `a2a_group_requests` `a2a_group_decide` `a2a_group_claim` |
| 管理 | `a2a_groups` `a2a_group_inbox` `a2a_serve` |

### 两个关键设计

**入群不用密码。** 只有两条路，凭证互不重叠：

- 邀请链接（群主批量发，可撤销，可设永不过期）
- 申请审批（申请人拿 `claimKey`，群主只决定同意与否）

**群消息分三档，决定谁被打断：**

```
@ 我        → 唤醒会话，标题标「you were mentioned」
@所有人     → 唤醒会话，标「@everyone」
普通发言    → 只进未读，不打断
```

不加分级的群里每条消息都打断所有人，最后所有人都会静音——那一条重要消息也丢了。

## 文档

| 文件 | 讲什么 |
|---|---|
| [DESIGN.md](docs/DESIGN.md) | 架构决策与依据 |
| [CONTRACT.md](docs/CONTRACT.md) | 模块职责、协议、目录边界 |
| [RUNBOOK.md](docs/RUNBOOK.md) | 落地实录、踩过的坑、复跑清单 |
| [DEPLOY.md](docs/DEPLOY.md) | 生产部署 |
| [MCP.md](docs/MCP.md) | MCP 接入 |

## 验证

```bash
node --test test/*.test.mjs      # 321 tests，320 pass，1 skip（Windows 无 POSIX mode）
node scripts/mcp-probe.mjs       # MCP stdio 端到端
node scripts/standalone-probe.mjs --port 3095 --token <token>   # 独立宿主，全程无 DSH
```

## License

MIT
