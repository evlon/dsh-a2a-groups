# 变更记录

> 记录**修了什么、为什么**，以及踩过的坑。运行指导在 [docs/RUNBOOK.md](docs/RUNBOOK.md)。
>
> 这份文件的价值在于：当你遇到一个「明明该工作却不工作」的现象时，先在这里搜一下。

格式按[语义化版本](https://semver.org/lang/zh-CN/)。

---

## [未发布]

### 文档

- **`RUNBOOK.md` 重写为纯操作手册**：只留「怎么跑起来、怎么用」，历史与踩坑移到这里。新同事不需要知道我们修过什么 bug。

---

## [0.1.3] — 2026-11-04

### 修复

- **远程群的保存会在成功之后报失败**
  `setPanelProfile` 把 `const saved` 声明在 `if (record.local === true)` 分支内，而 `return` 在分支外读
  `saved?.changed`。结果：本地群正常，**远程群抛 `saved is not defined` —— 而写入其实已经到达宿主并成功了**。

  用户看到「保存失败」，数据却是对的。这是最误导人的失败形态：会让人重复保存，或来报一个「功能坏了」的
  假 bug。

  新增 3 个测试守**声明顺序**（不执行 handler 也能看出问题），并验证过还原成 bug 版本时会立刻失败。

- **面板写入失败不留痕迹**
  之前只返回 `write_failed`，`err.log` 全空。用户报告无法复现，只能写探针脚本才查出来。
  现在 catch 里打真实原因：`[a2a-panel] write failed for g-xxx: <原因>`。

### 文档

- **安装是两步，第二步是静默的**
  实测：`dsh plugin --profile web add dsh-a2a-groups@latest` 只把包装进 `node_modules`，**不加入
  `dsh.profile.bundles`**。漏了这步重启后 UI 里什么都没有，`err.log` 也不报错 —— 用户没有任何线索可搜。

  `dsh plugin` 只是 pnpm 的转发器，负责装包；是否挂载是另一件事。这属于正常路径而非故障，所以写进 README
  的编号步骤，不是排错章节。

---

## [0.1.2] — 2026-11-04

### 变更

- **包名 `dsh-a2a` → `dsh-a2a-groups`**
  `dsh-a2a` 在 npm 上已被占用。改名后仓库、包名、插件 id 统一。

  **改名要动四处，改一处就坏，且三处无报错**：

  | # | 位置 | 不改的后果 |
  |---|---|---|
  | 1 | `package.json` 的 `name` | 包身份不对 |
  | 2 | 包内 `cordis.patch.yml` 的 `name:` | `cannot resolve profile bundle` |
  | 3 | profile 的 `dsh.profile.bundles` | 不挂载，**UI 无按钮且 err.log 干净** |
  | 4 | `client.js` 的 `__ModuleLoader__.load({ id })` | `loaded without registering "<新名>"` |

  第 4 处最阴：模块**加载是成功的**，只是注册到旧名下，加载器认为这个包没提供它要的东西。

  `bundle registers under the package name` 这个测试已改为从 `package.json` 读期望值，并比对
  `cordis.patch.yml`。写死字面量的版本改名后只会报「期望 dsh-a2a」，读起来像测试过时而非代码错了。

### 新增

- 完整的中文文档六件套：`PRODUCT.md`（产品）、`ARCHITECTURE.md`（架构）、`DESIGN.md`（设计）、
  `DEPLOY.md`（部署）、`MCP.md`（MCP 接入）、`RUNBOOK.md`（运行手册）。

### 安全

- **移除 17 处硬编码的开发密钥**
  `sk-dev-niukl-2026`、`agent-groups-host-token-2026`、`dsh-a2a-dev-token-*` 及其 sha256。
  虽然只是本地 dev 环境的值，但公开仓库是永久的，而这些值暴露了内部网络的机器名、端口分配、密钥命名。

  现在全部从环境变量读，缺省值用明显是假的值（`dev-caller-key-not-a-secret`），脚本仍能对本地 mock 运行。

  > **注意**：仓库里的 `scripts/aisix-dev/resources.yaml` 是**模板**。网关容器实际跑的是
  > `~/aisix-dev/data/resources.yaml`（挂载到 `/etc/aisix`）。改模板不影响运行中的网关 —— 反过来，
  > 网关突然对所有请求返 401 时，先查容器里那份。

- **面板不再携带消息正文**：快照注入到页面 HTML，含正文会随缓存、截图、代理泄露。

---

## [0.1.1] — 2026-11-04

### 新增

- **`a2a_pending`**：一次调用回答「有什么在等我」。返回未读群消息 + 一对一邀请，一对一在前（邀请会阻塞进度）。

  设计成可以频繁调用：不抛异常、不编造未读数（远程群未读取时报「未知」而非 0）。

  配套重写了 MCP 的 `instructions`，教模型**什么时候该查**。但**实测无效** —— 见下方「已知限制」。

- **个人介绍（`headline`）与群内介绍（`about`）分离**
  两个字段作用域不同：`about` 是「我在这个群负责什么」，换群就变；`headline` 是「我是谁」，跟着人去所有群。

  新增 `person/profile` skill（原来只有 `group/role`，管不了跨群属性）。

  同时给 `a2a_group_role` 加了 `headline` 参数 —— 在这之前，**工具面没有设置个人介绍的入口**，模型不能改，
  只能通过面板 UI。两个字段走同一个工具是因为都是从「我是谁」这一行出发的自述，另开一个只有一个字段的工具
  只会让模型纠结该用哪个。

  互不干扰：只传 `about` 不会清掉 `headline`，反之亦然；空字符串才清空。

- **邀请结果三态反馈**：「正在发送」/「已邀请，对方在线」/「已邀请，对方当前离线」/「发送失败：原因」。

  「已发出」和「对方现在能看到」是两个不同的承诺，合并成一个勾会让人在对方没立刻回复时以为功能坏了。

- 发送时禁用列表：每次邀请签发**一次性链接**，双击会产生两个有效链接而只有一个会被用掉。

### 修复

- **MCP 建的群邀请不了任何人**
  `a2a_group_create` 支持在远程宿主上建群（这是常态），但 `a2a_group_invite` 强制 `local === true`。

  **只有 MCP 场景必然暴露** —— MCP 客户端没有任何本地托管的群，所有操作都走远程。单测覆盖的是本地场景。

  修复：加 bridge 分支，由持有令牌表的宿主签发。

- **`group/read` 把 `from` 降级成了字符串**
  ```js
  from: entry.from.displayName,   // ← 丢掉了字段名
  personId: entry.from.personId,  // ← 提到了平级
  ```
  但 `publicEntry` 约定是 `from: { personId, displayName }`。所有读 `from.displayName` 的消费者拿到
  `undefined`。

  测试断言了 `from.personId` 和面板文本，**没断言结构**，所以一直绿的。

  这只有跑真实的四进程走查才会暴露。

- **相同值保存也广播**
  角色保存无条件写系统条目，导致「X 更新了本群角色」刷屏。成员观察到间隔从两小时缩到 100 秒，合理怀疑
  「有客户端在循环调用」。

  修复：比较前后值（tags 两边排序后比较），无变化返回 `changed: false`，**且不更新 `profileUpdatedAt`**
  —— 那个字段的含义是「最后修改时间」，空存一次就刷新等于说谎。

- **入群通知从未发送**
  `person/send` 支持 `join-notice` 和 `welcome` 两种类型，但代码里**从来没有人调用它们**。邀请是单向的：
  群主推链接，然后什么都不知道。

  现在双向发，且：欢迎语不能由被欢迎者签名（`sendPersonMessage` 拒绝自发消息）；两条消息都不带邀请令牌
  （否则令牌进群主收件箱，正是转发截图的来源）；通知失败不影响入群（成员已经落盘了）。

### 修复（UI）

- **「我」徽章在深色主题下白底白字**
  ```js
  background: "currentColor",
  color: "#fff",
  ```
  `currentColor` 继承父元素文字色，只翻转**一个**元素。浅色主题是深底白字（正常），深色主题是
  **近白底 + 白字**（不可见）。

  CSS 无法表达「文字色的相反色」。改用 `light-dark()` 显式指定两套值。

  同一错误出现三处：成员行徽章、名片徽章、筛选标签选中态。只修用户报的那处会漏两个。

- **对话框深底深字**
  用了五个**不存在**的 `--dsh-color-*` 变量，`var(..., fallback)` 全部落到深色 fallback。DSH 的官方 token
  是 `--dsw-alias-*`。

### 新增（UI）

- **面板能直接写宿主，不需要拉人进会话**
  之前点「编辑介绍」是往输入框填一段指令，用户还得按回车 —— 在协作群场景里，用户看的是花名册，不是跟助手
  说话。

  现在用 DSH 官方的 Connection RPC：`ctx.connection.rpc.handle()`（宿主）+ `ctx.connection.rpc.call()`（浏览器）。

  实现细节与三个坑见下方「实现备忘」。

- 邀请改成对话框（1000 个同事时列表放不下）。
- 未绑定的会话有独立面板，含使用提示和邀请入口。

---

## 实现备忘

这些不是变更，是**下次改这块代码前该知道的事**。

### 面板写入通道的四个坑

1. **`ctx.connection.rpc.handle()` 从插件自己的 fiber 调用会抛**
   `cannot get property "webServer" without inject` —— 上游 bug（#8414）。**必须用 `ctx.root`**。

2. **浏览器侧不是 `createWebConnectionRpc`**
   那个名字是内部的。模块真实导出是 `{ RpcId, apply, inject, installConnection, transportError }` ——
   它是插件，发布的是 `connection` 服务。调用方式：
   ```js
   ctx.connection.rpc.call(channel, endpoint, payload)
   ```
   与宿主的 `handle` 完全对称。

3. **`dsh.client.inject` 是模块表，不是服务列表**
   包里只能 `require` 在这里声明过的模块。只写 `slots` 时，`require('@dsh-client-connection')` 会抛，
   面板报「module 未能加载」—— 但其实模块从未被提供。

4. **裸 POST 会 405**
   传输层带的是 `ClientRequest` 信封（`{ type, rpcId, method, payload }`），不是裸 body。

### 为什么写操作在宿主执行

凭证不出宿主、不需要第二套鉴权、Connection 已做认证。

**面板带 personKey 的话，DOM 里能读到** —— 等于把每个群的凭证交给任何能读页面的人。

### 测试的两个盲区

- **断言返回值，不断言「不抛 ReferenceError」**：三个核心工具曾 100% 崩溃（缺 import），测试全绿。
- **断言渲染文本，不断言字段结构**：`from` 被降级成字符串，测试没发现。

### MCP 推送：协议支持，生态不消费

MCP 有 `notifications/message` 和 `notifications/resources/updated`，传输层也支持 SSE。**但没有任何主流
客户端把通知变成一轮对话** —— 通知到达的是客户端程序，不是模型。

实测三条路都不通：

| 机制 | 结果 |
|---|---|
| `instructions` | CodeBuddy **完全丢弃**（直接问它那句话在不在，答「没有」） |
| `prompts/list` | 只作为 slash command 暴露，要用户手动敲 `/` |
| `tools` | 进 `<available_deferred_tools>`，**只给名字**，无描述无 schema |

所以实际用法是**在提示词里明确要求模型去查**：

```bash
codebuddy -p "先调用 a2a_pending 看有没有协作群消息，有未读先处理。然后：<任务>"
```

要真正的推送，只能让宿主主动调客户端的非交互模式（`codebuddy -p`、`claude -p`、`opencode`），代价是每次
唤醒冷启动一个进程。**当前没做。**
