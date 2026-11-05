# dsh-a2a

把 DSH 的一台机器，变成能加入协作群的 A2A 智能体；同时提供一个与 DSH 无关的群宿主，
以及一个让任何 MCP 客户端都能用同一套工具的 MCP server。

```
① AISIX 网关（可选）      统一鉴权、限流、审计
        ↓
② agent-group-host 宿主  独立 Node 程序，存群、存消息，零依赖
        ↓
③ 成员                    DSH 插件 / MCP 客户端 / 任何 A2A 智能体
```

## 三种用法，一套代码

| 你想做什么 | 怎么用 | 需要 DSH |
|---|---|---|
| 在自己的 DSH 会话里加入协作群 | 装这个插件 | 是 |
| 在服务器上跑群宿主 | `npx dsh-a2a-groups agent-groups` | **否**（只要 Node 20+） |
| 在 CodeBuddy / Claude Code 里用群工具 | `npx dsh-a2a-groups agent-groups-mcp`（MCP stdio） | **否** |

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
│   ├── tool-specs.js    26 个工具的 name/description/schema/render（纯数据）
│   └── tool-runtime.js  26 个工具的执行（接收 { sessionId }）
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

## 安装

```bash
npm install -g dsh-a2a-groups     # 可选：需要 agent-groups / agent-groups-mcp 两个命令时
```

也可以完全不装，用 `npx dsh-a2a-groups <command>`。**Node 20+**，零依赖（不拉数据库、不拉模型）。

### 三个入口，装一次全都有

| 命令 / 入口 | 干什么 | 需要 DSH 吗 |
|---|---|---|
| `agent-groups` | 跑群宿主（独立 Node 进程，存群和消息） | 否 |
| `agent-groups-mcp` | MCP server，给 CodeBuddy / Claude Code / Cursor 用 | 否 |
| DSH 插件 | 侧边栏面板、成员栏、同事名片 | **是** |

**注意**：`npm install` 只是把代码装到磁盘。要在 DSH 里看到「协作群」按钮，还得在 profile 里启用插件 ——
见下面的「在 DSH 里加入群」。

### 装完先自检

```bash
# 宿主能起来吗
agent-groups --port 3095 --data /tmp/ag &
curl -s http://127.0.0.1:3095/a2a/.well-known/agent-card.json | head -3

# MCP 能应答吗（应打印 serverInfo）
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
  | agent-groups-mcp 2>/dev/null | head -1
```

---

## 快速开始

### 在服务器上跑群宿主

```bash
AGENT_GROUPS_TOKEN=<随机串> \
AGENT_GROUPS_GATEWAY=http://gw:3000/a2a \
npx dsh-a2a-groups agent-groups --port 3095 --data /var/lib/agent-groups
```

零依赖，不需要数据库、不需要模型。[部署文档](docs/DEPLOY.md)

### 在 DSH 里启用（两步，第二步容易漏）

```bash
# 1. 装包
dsh plugin --profile web add dsh-a2a-groups@latest

# 2. 让 profile 挂载它 —— 漏了这步，UI 里什么都不会出现，也不报错
#    编辑 <$DSH_HOME>/profiles/web/package.json，把包名加进 dsh.profile.bundles
```

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-a2a-groups"
      ]
    }
  }
}
```

然后重启 DSH，左上角会出现「协作群」。

> **为什么这步不会自动做**：`dsh plugin` 只是把参数转发给 pnpm，它负责「装包」，不负责「启用」。
> 一个包装进 `node_modules` 和 profile 是否挂载它，是两件事。**实测：只做第 1 步，UI 里完全看不到，
> `err.log` 也不会有任何提示** —— 所以这一步单独写出来。

### 配置（可选，不配也能开面板）

不配置时插件能启动、面板能开，只是没有群可看。要真正连上协作群，在同一个 profile 的
`cordis.patch.yml` 里加：

```yaml
- id: a2a
  name: dsh-a2a-groups
  config:
    groups:
      enabled: true
      gatewayBase: http://your-gateway:3000/a2a
      agentName: agent-person-you
    client:
      enabled: true
      apiKey: <网关调用方密钥>
      gatewayBase: http://your-gateway:3000/a2a
    tools: true
```

`agentName` 是你自己在网关注册的名字。[部署文档](docs/DEPLOY.md) 有完整说明。

### 在 DSH 里加入群

插件设置里填三项：

```
groups.gatewayBase = http://gw:3000/a2a
groups.agentName   = agent-person-<你的名字>
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
        "AGENT_GROUPS_AGENT": "agent-group-host",
        "AGENT_GROUPS_TOKEN": "<令牌>"
      }
    }
  }
}
```

**MCP 版没有界面**——协议里只有 tools/resources/prompts。[MCP 文档](docs/MCP.md)

## 26 个工具

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
| [PRODUCT.md](docs/PRODUCT.md) | **产品说明**：解决什么问题、三个场景、不做什么 |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | **架构**：目录边界、核心模块、两条数据流 |
| [DESIGN.md](docs/DESIGN.md) | 设计决策与依据 |
| [CONTRACT.md](docs/CONTRACT.md) | 模块职责、协议、目录边界 |
| [RUNBOOK.md](docs/RUNBOOK.md) | **运行手册**：新同事照着做就能跑起来 |
| [SANDBOX.md](docs/SANDBOX.md) | **测试隔离**：为什么群实例不该落在默认工作区 |
| [DEPLOY.md](docs/DEPLOY.md) | 生产部署 |
| [MCP.md](docs/MCP.md) | MCP 接入 |
| [BACKLOG.md](docs/BACKLOG.md) | 需求池：想过但暂不做的事 |
| [FAQ.md](docs/FAQ.md) | **常见问题**：数据不一致时先看这里，按谁能修分类 |
| [STATE.md](docs/STATE.md) | **成员状态机**：六种状态、收敛规则、为什么 3b 不可恢复 |
| [HUMAN-AI-COLLABORATION.md](docs/HUMAN-AI-COLLABORATION.md) | **人机协同复盘**：AI 的六个盲区、人的不可替代作用、FDE 操作清单 |
| [OPENCLI-ADAPTER.md](docs/OPENCLI-ADAPTER.md) | **UI 测试适配器**：opencli 命令驱动 DSH Web，模拟真人点击并读屏校验 |
| [CHANGELOG.md](CHANGELOG.md) | 变更记录：修过什么、为什么、踩过哪些坑 |

## 验证

```bash
node --test test/*.test.mjs      # 321 tests，320 pass，1 skip（Windows 无 POSIX mode）
node scripts/mcp-probe.mjs       # MCP stdio 端到端
node scripts/standalone-probe.mjs --port 3095 --token <token>   # 独立宿主，全程无 DSH
```

## License

MIT