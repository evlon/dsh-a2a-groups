# dsh-a2a-bus

DSH 协作群的开发仓库。核心包在 [`dsh-a2a/`](dsh-a2a/) —— 把一台 DSH 机器变成能加入协作群的 A2A 智能体，
同时提供独立群宿主和 MCP server。

## 分支

| 分支 | 用途 | 状态 |
|---|---|---|
| `v0.1.x` | 生产维护线：只修已发布的 0.1.x bug | **当前生产版本 0.1.24** |
| `master` | 主开发线（向前到 0.2.x） | 日常开发 |
| `v0.2.x` | 0.2.0 重构 + 新功能 | **⚠️ 尚未开工，请勿用于生产** |

> **`v0.2.x` 是占位分支**：0.2.0 重构尚未开工，当前内容与 v0.1.x 代码一致（仅版本号与文档同步）。请勿 checkout 它来构建或部署。

## 包里有什么

```
dsh-a2a/            主包 dsh-a2a-groups（一个包，三种用法）
  ├── lib/core/      零 DSH 依赖的群状态机，任何宿主可复用
  ├── lib/shared/    工具契约（DSH 插件与 MCP 共用同一份 spec + runtime）
  ├── lib/dsh/       DSH 插件适配层（面板、工具、人工确认）
  ├── lib/mcp-server.js  MCP stdio server
  ├── bin/agent-groups.js  独立群宿主（零依赖 Node 程序）
  ├── client.js       浏览器面板 bundle
  └── docs/           契约 / 部署 / 排错

dsh-session-bus/    旁置的另一个独立仓库（不在本仓库 tracked 内，见 .gitignore）
scripts/             探针 / 联调脚本
verification/        验证证据（报告进 git，截图归 .shots/）
```

## 三种用法

| 想做什么 | 命令 | 需要 DSH |
|---|---|---|
| 在 DSH 会话里加入协作群 | 装 `dsh-a2a-groups` 插件 | 是 |
| 在服务器上跑群宿主 | `npx dsh-a2a-groups agent-groups` | 否（Node ≥ 20） |
| 在 CodeBuddy / Claude Code 里用群工具 | `npx dsh-a2a-groups agent-groups-mcp` | 否 |

## 开发

```powershell
cd dsh-a2a
node node_modules/vitest/vitest.mjs run --no-file-parallelism   # 全量测试
node --test test/*.test.mjs                                     # 快速单测
```

详见 [`dsh-a2a/README.md`](dsh-a2a/README.md) 和 [`dsh-a2a/docs/`](dsh-a2a/docs/)。
