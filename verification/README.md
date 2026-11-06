# verification/ — 开发期验证证据

这个目录存放**开发期的验证记录**：UI 截图对照、功能确认报告、交接文档。它们是**证据**，
不是产品源码，也不进 npm 包。

## 存放约定

| 放这里 | 不放这里 |
|---|---|
| 功能验证报告（CONFIRM-*、PROBE-*） | 产品文档（去 `dsh-a2a/docs/`） |
| 交接文档（HANDOFF） | 变更记录（去 `dsh-a2a/docs/CHANGELOG.md`） |
| 验证用的结构化输出（probe-exec-*.json） | 运行时状态/日志（去 `.shots/` 或 `%TEMP%`） |

## 截图归 `.shots/`

**截图（png）不放这里，放 `.shots/`**——那个目录已经 gitignore，不进仓库。原因是：

- 截图是一次性 UI 证据，体积大、会随每次验收累积；
- 它们没有「被追溯」的价值（改了 client.js 旧截图就失效了）；
- 保留在 `.shots/` 本地可查，但不污染 git 历史。

## 规则

1. **报告文档（md）进 git**（tracked），截图不进 git（.shots/）。
2. 一份功能验证结束，报告留在这里；等它被固化进 `docs/CHANGELOG.md` 后，这里的报告就可以删。
3. 不要在这里放一次性探针脚本（去 `scripts/` 或 `%TEMP%`）。
