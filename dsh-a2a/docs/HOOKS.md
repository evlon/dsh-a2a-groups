# 消息生命周期 Hook 机制设计

> 状态：设计定稿（待评审）
> 提出：2026-11-07
> 目标版本：0.1.x（维护线新增能力）

## 一、要解决什么问题

现在的「人工确认」只有**一个写死的点**：在 `a2a_group_post` / `a2a_send` 执行前拦一次，问「要不要发这条回复」，选项固定为 允许 / 稍后处理 / 拒绝。

真实团队里，人需要在**更多时机**做决定，而且拒绝时要能**说清为什么**：

| 场景 | 现有能力 | 需要的能力 |
|---|---|---|
| 收到同事消息，还没开始干活 | ❌ 无 | 收到消息时先问「要不要接」 |
| 执行某个动作之前 | ✅ 有（但只限 post/send） | 通用化，覆盖所有动作 |
| 执行之后 | ❌ 无 | 执行后检查结果，可阻断/改写 |
| 发送之前 | 部分（就是执行前那个） | 独立语义，覆盖「发群消息」 |
| 发送之后 | ❌ 无 | 发送后观察/通知 |
| 拒绝时给理由 | ❌ 固定文案 | 用户手写理由（如「现在是下班时间」） |

## 二、核心结论：底层原语 DSH 全都有，我们做薄封装

调研（feedback-watcher，带文件路径行号）确认：**DSH 运行时已有成熟的拦截/否决/等待确认机制**，不需要从零实现：

| 需求 | DSH 现成原语 | 位置 |
|---|---|---|
| 工具执行前拦截 | `tools/pre-execute`（waterfall）返回 allow/deny/cancel/ask，deny 带 reason | `@deepseek-ai/dsh-tools` |
| 工具执行后拦截 | `tools/post-execute`（waterfall）accept/block（block 带 feedback） | 同上 |
| 工具执行中拦截 | `tools/execute`（waterfall） | 同上 |
| 进入 step 前 veto | `agent/pre-step`（waterfall）返回 {kind:'reject'} | `@deepseek-ai/dsh-agent-loop` |
| 停下来等人确认 | `ctx.approval.request()`（允许/拒绝/取消，带 reason） | `@deepseek-ai/dsh-user-approval` |
| 停下等人选/写 | `ctx.userQuestions.ask()`（选择题 + 自由文字） | `@deepseek-ai/dsh-user-questions` |

**唯一需要自建的**：
1. **「发送前 veto」没有独立挂载点** —— 投递是 durable SessionEvent（提交后才观察，无法 veto）。需要在我们自己的 `a2a_group_post` 工具层（async，调 `store.post` 之前）自建。
2. **「用户手写拒绝理由」** —— `approval` 的 reason 是 asker 填的、outcome 是枚举；要「用户输入任意文字」，需要 `approval` + `userQuestions.ask`（自由文字）组合。
3. **统一 hook 门面** —— DSH 事件分散在 session/agent/tools 三个服务、前缀不同，没有统一的「消息生命周期」接口。

## 三、设计：五个生命周期阶段 + 一个统一门面

### 3.1 阶段定义

| 阶段 id | 含义 | 挂载点（复用） | 是否 async 可阻塞 |
|---|---|---|---|
| `receive` | 收到同事消息、即将唤醒 Session | `inbox.js:466 deliverPost` / `deliver.js:206 deliver` | 是（需改 `void` → `await`） |
| `before-exec` | 执行某个动作之前 | `tools/pre-execute`（或现有 gate） | 是 |
| `after-exec` | 执行之后 | `tools/post-execute` | 是 |
| `before-send` | 发群消息/点对点之前 | `tool-runtime.js:1089 a2a_group_post` 调 store.post 之前 | 是 |
| `after-send` | 发送之后 | 同上，store.flush/bridge.send 之后 | 是 |

### 3.2 统一 API

一个 `hooks` 注册表，业务方注册 handler，按序执行：

```js
// 注册
hooks.register('before-send', async (ctx) => verdict);
hooks.register('receive', async (ctx) => verdict);

// verdict 三种
{ proceed: true }                          // 放行
{ proceed: false, reason: '...', notify?: string }  // 拒绝（reason 告知发送方，notify 可选回帖文案）
{ modify: { ... } }                        // 改写（如改写消息内容）
```

- `ctx` 携带阶段上下文：`{ phase, toolName, args, exec, groupId, sender, ... }`。
- handler 按注册顺序 waterfall 执行：任一返回 `proceed:false` 即终止后续 handler，整个动作被否决。
- 每个阶段独立开关（配置化），默认全关（向后兼容 0.1.x 现有行为）。

### 3.3 「拒绝带理由」的实现

这是「自由文字理由」的透传链（调研确认，用户文本其实**已经在** `decideFromAnswer` 的 `custom` 字段里，只是没透传）：

```
用户点「拒绝」→ userQuestions 返回 custom 文本（如「现在是下班时间」）
  → decideFromAnswer 提取 item.custom 为 reason 字段（改，4 处透传）
  → noticeFor({ kind:'refuse', reason }) 把理由拼进回帖文案（改）
  → a2a_group_post 把「我拒绝，理由：现在是下班时间」发到群里
```

改动点 4 处（调研已定位，全是 `lib/dsh/human-confirm.js` + `lib/dsh/tools.js` 的透传，无新收集逻辑）。

### 3.3b 拒绝理由的留痕（可审计，采纳评审意见）

拒绝理由**必须落盘留痕**，否则「谁在什么时候拒了什么」事后无法复盘。设计：

- 落盘**只存元数据**：`{ personId, at, phase, targetSeq, fromPersonId, decision, reason }`，**不存完整消息内容**（避免 feed 变成敏感信息仓库）。
- 在 feed 里写一条 system 记录，并打 `hook_audit` 标记：
  - 人读文案：`<person> 在 receive 阶段拒绝了 <from> 的消息 #<seq>，理由：<用户输入>`
  - 程序读字段：`{ hookPhase, decision, reason }`
- `group/read` **默认过滤** `hook_audit` 记录，避免群消息被系统记录刷屏；提供 `includeSystem` 参数可显式取回，满足「想查却查得到」。

### 3.4 与现有 human-confirm 的关系

- **hook 机制是框架**，`human-confirm` 是框架上的**第一个内置 handler**（挂在 `before-exec` + `before-send` 上）。
- 现有 `humanConfirm` 配置（enabled/trigger/channel/onTimeout）继续作为这个内置 handler 的配置，不破坏 0.1.x 现有行为。
- 新增的 `receive` / `after-exec` / `after-send` 阶段，MVP 先做空钩子（注册表存在、可注册、无默认 handler），让「框架」先立起来，后续按需加 handler。

## 四、MVP 范围（定稿，含评审调整）

**这一版必做**：
1. `hooks` 注册表 + 5 个阶段定义（`lib/core/hooks.js`，零 DSH 依赖，可单测）。
2. 把现有 human-confirm 迁移为 `before-exec`/`before-send` 上的内置 handler（行为不变）。
3. **`before-send` 的拒绝理由透传**（评审定调：现有唯一在用的确认点，改完立竿见影）——透传 custom → noticeFor 文案（4 处小改）。
4. **全局开关**：`hooks.enabled`（总开关，出问题一键关掉）+ `hooks.phases`（只开需要的阶段）。生产出异常时，改配置关掉比回滚版本快。
5. **确认超时降级**：默认超时（如 5 分钟），超时后**降级为「稍后处理」而不是「拒绝」**——「人不在」和「人拒绝」是两件事，不能因为超时就当成拒绝把消息丢了。
6. `receive` 阶段空钩子（默认关）+ `deliverPost` 的 `void` → `await` 改造（让 receive 将来能阻塞）。

**这一版不做**（进 BACKLOG）：
- `receive` 的实际 handler（默认关闭，做空钩子即可——一旦启用意味着每条消息都要人工确认，群里人一多就是灾难；等有「防打扰」等实际需求再开）。
- `after-exec` / `after-send` 的实际 handler（框架有，handler 暂无；after-send 发送后无法撤回，只能做事后记录，价值低于前几个，留空钩子）。
- `modify` 改写的实际用例（框架支持，暂无业务用到）。
- IM 通道（现有 human-confirm 的 `channel: 'im'` 仍未实现，保持拒绝）。

## 五、关键工程约束（来自调研，写实现时必守）

1. **`store.post`（groups.js:844）是同步的**，「发送前停下问」的 async hook 必须挂在 `a2a_group_post`（async）层，不能进 store.post 内部。
2. **`deliverPost` 是 fire-and-forget**（inbox.js:296 `void deliverPost(...)`），要让 `receive` 阻塞，需把 `void` 改成 `await`（并确认 fire-and-forget 语义是否被别处依赖）。
3. **异步 handler 的调用方必须 await**，否则「停下问」会变成「悄悄放行」，这正是现有 `channel-unimplemented` 拒绝要防的事。
4. 所有新增阶段默认关，`hooks.register` 不改变任何现有行为——这是 0.1.x 维护线的红线。

## 六、已定决策（含苏虎虎评审意见）

| 问题 | 决策 | 依据 |
|---|---|---|
| `receive` 阶段的确认通道 | **userQuestions（两选项 + custom 输入）**，不用纯 approval | 纯 approval 是二态，拒绝后没地方写理由，会丢掉「拒绝带理由」能力；userQuestions 统一「拒绝必带理由」语义 |
| 拒绝理由是否留痕 | **必须留痕**，只存元数据 + `hook_audit` 标可过滤 | 审计/调试/对发送方透明；`group/read` 默认过滤，`includeSystem` 显式取回 |
| MVP 边界 | before-send 拒绝理由透传**必含**；receive 默认关空钩子；after-send 排除 | before-send 是现有唯一在用的点；receive 默认开会导致「每条消息弹一次」的灾难 |
| 全局开关 | `hooks.enabled` + `hooks.phases` | 生产出异常时改配置关掉比回滚快 |
| 确认超时 | 默认超时（5 分钟），超时**降级为「稍后处理」**（非拒绝） | 「人不在」≠「人拒绝」，不能因超时丢消息 |

## 七、剩余待定（留到实现时再定）

1. **handler 的优先级/顺序**：是否需要「内置 handler 先跑还是用户注册的先跑」的编排规则。倾向「注册顺序即执行顺序，内置 handler 默认最后」，避免用户 handler 被内置的拦在前面。
2. **确认超时的具体默认值**：5 分钟是初值，实现时可根据实际体验调整。
