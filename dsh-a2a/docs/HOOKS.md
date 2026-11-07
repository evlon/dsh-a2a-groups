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

// verdict 四种（每种意图一个独立形状）
{ proceed: true }                          // 放行给当前 session
{ proceed: false, reason: '...', notify?: string }  // 拒绝（reason 告知发送方，notify 可选回帖文案）
{ modify: { ... } }                        // 改写（如改写消息内容）
{ forward: { toSessionId: string, note?: string } } // 转发给指定 session（D-02 预留，MVP 未实现）
```

- `ctx` 携带阶段上下文：`{ phase, toolName, args, exec, groupId, sender, ... }`。
- handler 按注册顺序 waterfall 执行：任一返回 `proceed:false` 即终止后续 handler，整个动作被否决。
- 每个阶段独立开关（配置化），默认全关（向后兼容 0.1.x 现有行为）。

**`forward` 第四态（D-02 留接口，MVP 不实现）**：

- 前三种（`proceed:true` / `proceed:false` / `modify`）各自一个独立字段，`forward` 也应有自己的字段——「每种意图一个独立形状」是这个结构已有的组织方式。
- **不能**复用 `proceed:true + forward`（会变成「一值两义」，和 `streaming` 的 `!== false` 同源），也不能用 `proceed:false + reason:'forwarded'`（拒绝和转发是相反意图）。
- **MVP 行为：handler 返回 `forward` 时抛错「该 verdict 类型尚未实现」**，不是静默降级成放行。理由：「留了接口但静默降级」比「没留接口」危险——将来注册 handler 的人会以为转发生效，实际消息还是给了本人（和 `loaded:0` 混淆、`inviteId` 恒空同一族：看起来支持，实际没生效）。

### 3.3 「拒绝带理由」的实现

这是「自由文字理由」的透传链（调研确认，用户文本其实**已经在** `decideFromAnswer` 的 `custom` 字段里，只是没透传）：

```
用户点「拒绝」→ userQuestions 返回 custom 文本（如「现在是下班时间」）
  → decideFromAnswer 提取 item.custom 为 reason 字段（改，4 处透传）
  → reason 只写进审计（§3.3b），不进群回帖
```

**关键约束（评审否决的既成设计）**：拒绝理由**只进审计（仅 owner 可读），绝不拼进群回帖，也绝不进工具返回值**。群回帖只说「已拒绝」（或中性固定文案「对方暂时无法接收」），不带理由。

> 【已否决 2026-11-07】~~`noticeFor({ kind:'refuse', reason })` 把理由拼进回帖文案~~ —— 理由：回帖是 feed 永久消息、全员可见，与「reason 仅 owner 可读」冲突，等于「一条上锁一条敞着，上锁那条是装饰」。完整 reason 只进审计（石磊 #122）。

> **【现存泄漏 2026-11-07，必须修复】** `lib/dsh/tools.js:217-223` 的拒绝返回值现在**已经带着 `reason: decision.reason`**（用户手写理由）——它会进入 agent 上下文，最终被远端 A2A 调用方看到。这条**今天就在泄漏**，不经过 feed、不经过审计权限、不受 `includeAudit` 限制。修复：拒绝结果**去掉 `reason` 字段**，只留 `refused: true` + `message`（「不要再重试」）。断言：`拒绝结果不含 reason 字段`（石磊 #148，E1 级，带源码行号）。

### 3.3b 拒绝理由的留痕（可审计，采纳评审意见）

拒绝理由**必须落盘留痕**，否则「谁在什么时候拒了什么」事后无法复盘。设计：

- 落盘**只存元数据**：`{ decisionId, decidedByPersonId, senderPersonId, groupId, at, phase, targetSeq, decision, reason }`，**不存完整消息内容**（避免变成敏感信息仓库）。字段命名与 §8.2 的 decision/outcome 两行结构一致（`decidedByPersonId` = 做决定的人，`senderPersonId` = 发消息的人）。

- **审计独立存储，不混入 feed**（评审关键修正）：
  - 审计记录是**独立的 `hook-audit` 存储**，不是 feed 里的条目。理由：feed 受 `retentionDays` 清理，审计的证据价值恰恰在「事后追查」，而事后往往已过保留期——把审计放进 feed 等于「证据按设计被删掉」。
  - 审计**不占 seq**、**不受 retention 清理**、**不影响 `group/read` 的 limit 分页**。这三条是「审计独立存储」的必然推论，避免三类 bug：审计挤掉正常消息（过滤在 limit 之后）、审计占 seq 破坏 sinceSeq 轮询、审计被 retention 静默删除。
  - 审计记录的 kind 是 `hook_audit`（独立类型，不复用 `system`），`group/read` **默认不返回审计**；提供 `includeAudit` 参数显式取回。

- **`includeAudit` 权限**：拒绝理由是敏感信息（谁拒了谁、为什么、多频繁），**仅 owner 可拉**。非 owner 调用 `includeAudit` 返回不含审计（或明确拒绝），纳入权限 deny 矩阵。

### 3.4 与现有 human-confirm 的关系

- **hook 机制是框架**，`human-confirm` 是框架上的**第一个内置 handler**（挂在 `before-exec` + `before-send` 上）。
- 现有 `humanConfirm` 配置（enabled/trigger/channel/onTimeout）继续作为这个内置 handler 的配置，不破坏 0.1.x 现有行为。
- 新增的 `receive` / `after-exec` / `after-send` 阶段，MVP 先做空钩子（注册表存在、可注册、无默认 handler），让「框架」先立起来，后续按需加 handler。

## 四、MVP 范围（定稿，含评审调整）

**这一版必做**：
1. `hooks` 注册表 + 5 个阶段定义（`lib/core/hooks.js`，零 DSH 依赖，可单测）。
2. 把现有 human-confirm 迁移为 `before-exec`/`before-send` 上的内置 handler（行为不变）。
3. **`before-send` 的拒绝理由透传**（评审定调：现有唯一在用的确认点，改完立竿见影）——透传 custom → **只写审计**，不进回帖（4 处小改）。
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

## 七、配置解析的严格语义（含 DSH-RD-Test 评审意见）

这些是「测试全绿但线上行为反了」形状的坑，必须在定稿时就钉死。

### 7.1 配置解析抽成可单测的纯函数

```
config.resolveHooksConfig(raw) → { enabled: boolean, phases: string[], source }
```

**表驱动单测**覆盖所有值类型（尤其环境变量灌进来的字符串）：

| 输入 | 必须是 |
|---|---|
| 缺省 / `undefined` / `null` | 关 |
| `false` / `"false"` / `0` / `"0"` / `""` | 关 |
| `true` | 开（且 phases 非空） |
| **`"true"`（字符串，env var 典型产物）** | 显式转换或校验期报错，**绝不落进 fallback** |
| `1` / `"1"` / `"yes"` | 显式拒绝或接受，同样不落 fallback |
| `[]` / `"[]"`（YAML 里写成字符串） | 关 |

> 现有 `bool()` helper 用 `typeof value === 'boolean'`，字符串 `"true"` 会直接落到 fallback —— 用户在 env 写 `HOOKS_ENABLED=true` 会**静默无效**。这是真实翻车点，必须显式处理。

### 7.2 phases 的三态语义（不是二态）

「未配」和「配了空」必须区分，不能 `?? []` 抹平：

| profile | 宿主 | 生效 |
|---|---|---|
| 未配 | 未配 | 全关（缺省安全） |
| 配了 | 未配 | 按 profile |
| 未配 | 配了 | 按宿主 |
| 配了 | 配了 | 交集 |
| 任一侧配了 `[]` | — | 空 = 全关，优先于交集 |

> 反例：profile 配 `['before-send']`、宿主没配，直接求交集得 `∅ = 全关` —— 用户配了却一个没开。「未配」是缺省值，`[]` 是显式否决，两者不能塌成一个 `[]`。

**可观测性**：`status` 必须同时报「两侧原始配置 + 生效结果 + **loaded 计数**」四样，否则「我配了怎么没生效」每次都要人肉猜交集。`loaded: N` 是关键一样——它让两种「看着都像关了」的状态可区分：

| status 组合 | 含义 |
|---|---|
| `loaded: 0, enabled: true` | **事故**（钩子没加载成功），必须告警 |
| `loaded: 3, phases: []` | **正常关闭**（钩子加载了，但显式全关） |

### 7.3 未知阶段名校验期报错（不是静默忽略）

```
phases: ['before_send']   ← 下划线，正确名 'before-send'
```

拼错一个阶段名，如果实现是「按名字过滤、匹配不上就不装」，会**静默关掉整个阶段的保护**，而配置看起来完全正常（enabled=true、phases 非空）。定死：

1. 未知阶段名必须在配置校验期报错，不能静默忽略。
2. `true/[]` = 全关要写进文档显眼处（反直觉语义：大部分人读成「不限阶段=全开」）。
3. 新增阶段（如 0.2.1 加 after-execute）时，老配置里显式列了阶段列表的，新阶段**默认关**（fail-closed），且**必须有测试锁定**，防未来「好心」改成默认开。

### 7.4 审计独立存储的向前兼容（可回滚）

审计**独立存储**（不混入 feed）后，向前兼容反而更简单了：

- **0.1.24 读 0.2.0 的群数据**：审计不在 feed 里，0.1.24 完全读不到它，**不会报错、不会渲染、不会误当普通消息**——天然兼容。
- **0.1.24 写、0.2.0 读**：审计存储是 0.2.0 新增的独立文件/表，0.1.24 不碰它，所以 0.1.24 写群数据后，0.2.0 的审计存储**不受影响、不丢**。
- **审计存储本身的格式**：新增字段一律可选，旧审计记录（如果将来有）读时补默认值。

> 这正是「审计独立存储」优于「混入 feed」的第四个理由：它天然解决了向前兼容——如果审计混在 feed 里，0.1.24 读到未知 kind 就要处理「隐藏 + 不洗掉」两件事；独立存储后这两件事都不存在了。

**kind 仍是开放字符串的隐患**（如果未来审计之外还要在 feed 里加新消息类型）：所有 `kind === '...'` 判断点，必须 ① 用常量（`KIND.SYSTEM` / `KIND.HOOK_AUDIT`），② 加穷举测试断言「未知 kind 走 default 分支，不被误当普通消息渲染」。

### 7.5 审计独立存储自动消解的两个隐患（评审 A/B 条）

评审提出的两条「混入 feed 会踩的坑」，在「审计独立存储」后**自动消失**，无需额外实现：

| 隐患（混入 feed 时） | 独立存储后 |
|---|---|
| **A. 过滤 vs limit 顺序**：审计挤掉正常消息，用户「数据在但看不见」 | 审计不在 feed，`group/read` 的 limit 只作用于正常消息，无此问题 |
| **B. 审计占 seq 破坏轮询**：sinceSeq 长轮询漏/重/反复唤醒 | 审计不占 seq，lastSeq 推进语义不变，无此问题 |

这两条**不需要写测试用例来防**（因为实现上就不可能发生），但设计评审时要确认「审计确实没混进 feed」——这是唯一的防线。

## 八、审计存储的实现约束（评审定稿，实现时必守）

这些是实现级约束（评审 DSH-RD-Test 提出），记录在案，等评审通过、主人拍板后才进实现。

### 8.1 `includeAudit` 返回独立字段，绝不合并进 messages

```json
{ "messages": [ ... ], "audit": [ ... ] }
```

审计没有 seq（按 `at`）、消息按 seq，两套排序混一个列表顺序不可定义；分页语义（`limit`/`sinceSeq` vs 游标）无法统一；合并会原样复活「审计挤占 limit」的 bug。**两个生命周期不同的东西，不共用一套分页语义。**

### 8.2 审计记录是「decision + outcome」两行结构（不是一行）

append-only + write-ahead + 记录最终效果，三者不能同时成立：
- write-ahead 要求审计行在「决定」时写
- 记录完整效果要求写「最终到底拦住没有」
- append-only 要求已写的行不能改

一行记录无法同时满足。解法：**一条决定，两条记录**：

```jsonl
{"decisionId":"d-7f3a","type":"decision","at":…,"phase":…,"decision":"deny","reason":…,"decidedByPersonId":…,"senderPersonId":…,"targetHash":…,"targetAt":…}
{"decisionId":"d-7f3a","type":"outcome","at":…,"effect":"blocked"}    // 或 delivered / unknown
```

配套三条规则：

1. **读者必须处理「有 decision 无 outcome」** —— 这个状态精确标识「写前记录之后崩溃」，正是要检测的不一致。不留这个洞，不一致永远查不出来（单条自洽的记录看起来永远对）。
2. **`outcome` 缺失的条目可查询**（`group/audit?incomplete=true`），它就是要人看的那一小撮。
3. **`decisionId` 宿主生成**，客户端不能指定（防伪造配对）。

> 价值：审计从「一份记录」变成「一份可自证完整性的记录链」——不需要相信每条都写了结果，只需相信「少了 outcome 的那几条一定出过事」。

### 8.3 JSONL 崩溃一致性断言（含 fsync 时序）

审计存储用 JSONL（append-only + fsync）。崩溃一致性断言：

1. **尾部残行**：崩溃留下半行（无换行符），读取端跳过该行并读出前面所有行，下次 append 前截断/隔离残行。
2. **并发写交错**：并发写 N 条，每行合法 JSON 且条数正确。超 PIPE_BUF 时 `O_APPEND` 不保证行级原子。
3. **轮转**：`auditRetentionDays` 清理用「rename 旧文件 + 新建」，不原地重写。

**fsync 时序（批量优化的边界，否则 write-ahead 被悄悄吃掉）**：

```
错误：决定拒绝 → 缓冲审计 → 返回拒绝给发送方 → （100ms后）fsync
      → 崩溃时：对方已收到"被拒"，但审计没落盘 = 无记录的拒绝
正确：决定拒绝 → 缓冲审计 → fsync（可能等 100ms）→ 返回拒绝
      → 崩溃时：审计已落盘但对方没收到拒绝 = 多发一条审计，可接受
```

> **fsync 必须在「拒绝」对外可见之前完成；批量只影响延迟（约 100ms 可接受），不影响「先落盘再告知」。** 否则批量优化会在「高峰期才出现、平时测不出」的方式下悄悄吃掉 write-ahead 保证。

### 8.4 写序按决定类型分开

| 决定 | 写序 | 崩溃后果 |
|---|---|---|
| **allow（放行）** | 先落消息、后写审计 | 丢审计可接受（消息还在） |
| **deny（拒绝）** | **先写审计 + fsync、再应用拒绝** | 不能「被拒了却无任何记录」 |

「无记录的拒绝」意味着当事人无法申诉、无法追责，比「多一条审计但消息发出去了」（可检测的不一致）严重得多。

### 8.5 清理可观测 + 单副本约束

- **清理必须留痕**：删审计这件事本身要记录（删多少条、时间范围、触发原因），否则「证据被删」在更高一层重演。
- **审计存储要求单副本**：宿主现在单副本 + PVC，进程内定时清理是安全的；若扩容 2 副本，两个定时器会同时删、两个进程同时 append 同一文件。约束现在写明，别等扩容才发现。

### 8.6 回滚三断言

```
① 0.1.24 启动时，数据目录存在 audit.jsonl → 必须正常启动
② 0.1.24 运行期间 → 不得删除/截断/重命名 audit.jsonl（"不认识就清掉"是最危险的默认行为）
③ 回滚后再升 0.2.0 → 必须继续追加到同一文件，不新建（否则审计历史被切成两段）
```

### 8.7 owner 转让即继承 + 无 owner 兜底

- **owner 转让 = 审计可见权转让**：新 owner 看到前任 owner 时期的全部拒绝记录。明写「审计是群级资产，转让即继承」，别让人误以为权限漏洞。
- **无 owner 兜底**：群主退群/被移除后，谁能读审计必须有定义（如全员不可读 / 归档后不可读），不能落进某个 `if` 的 else 分支变成默认放行。

### 8.8 clockSkew 是标记不是判决

时钟偏移（`clientAt` 与 `at` 偏差超阈值）打 `clockSkew` 标记，但：

1. **打标记不等于否定这次拒绝** —— 时钟偏 5 分钟的人也可能正当拒绝。标记是给人看的，不是给逻辑分支用的（否则「谁的机器时间不准，谁的话不算数」）。
2. **记录偏差量 `skewMs`**，不只记布尔（「偏 3 分钟」和「偏 3 天」是两回事）。
3. **宿主时钟要自证**：审计文件里 `at` 不应回退，回退说明时钟被调整过（单调性检查）。

### 8.9 fixture 两种都要（跨名字 + 同名不同 personId）

审计 fixture 必须覆盖两种：

1. **跨名字**：`decidedByPersonId: m-aaaa1111 (张三)` / `senderPersonId: m-bbbb2222 (李四)` —— 抓「字段写反」。
2. **同名不同 personId**（这次真实发生的状态）：两者 displayName 都是「张三」，只有 personId 不同 —— 断言审计记录的是 personId 指向正确，且人读文案里两个「张三」可区分（只写 displayName 的文案本身就是歧义源）。

> 后一条更值钱：我们刚在真实世界里制造出这个状态，且产生重复身份的机制还没修掉。

### 8.10 元审计不变式：「记录可以死，记录的死亡记录不死」

「审计的删除」被永久记录，但「永久记录」本身如果也要清理，就无限后退。解法是把不变式写死：

| 数据 | 保留策略 |
|---|---|
| 普通审计 | 180 天，可清理 |
| **元审计（谁删了什么）** | **永久**（量极小：一次清理一行，一年几行） |

> 「记录可以死，但记录的死亡记录不死」——这个不对称是刻意的，让「删除」永远可查，同时不引入无限链。

### 8.11 拒绝理由（reason）字段的长度与截断规则

`reason` 字段（用户手写的拒绝理由）也有长度上限，且涉及 emoji 截断的孤立代理项问题：

| 场景 | 规则 |
|---|---|
| 判定超限 | 用 `text.length`（UTF-16 code unit），与现有 `maxPostChars` 一致，**不加新行为** |
| **截断** | **按 code point 截断**，且截断点校验不落在代理对中间（或直接拒绝，不截断） |
| 落盘前校验 | 拒绝写孤立代理项（`/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/` 检查） |

> 背景：`'👨‍👩‍👧‍👦'.slice(0, 1)` 会切出孤立高代理项 `\ud83d`。JSON 序列化会把它转义成 `\ud83d` 写进 JSONL（JSON 层面合法），但任何按 UTF-8 处理它的地方都会坏（日志、导出、检索）。所以截断必须按 code point 且校验边界。

### 8.12 确认超时的实现层（宿主，不是客户端）

5 分钟超时**必须在宿主实现**，不能在客户端实现：

- 客户端实现则**断网即失效**——「人不在」时超时降级「稍后处理」这个保证，在断网时被静默跳过。
- 宿主实现则要处理「重连后补投」，但至少保证「超时一定会发生」。

**宿主实现 = deadline 必须落盘**（不是纯内存 setTimeout）：

- 消息里存 `confirmByAt`（deadline 时间戳），超时判定是「扫描 / 启动时补偿」，不是内存定时器。
- 否则宿主重启丢内存定时器 → 「待确认」消息**永不超时**，永久挂在「待确认」状态（比超时降级更糟，是无声卡死）。
- 三个必须定死的点：
  1. **超时后的消息落在哪**：发回求助者「稍后处理」，还是留队列？谁能看到？
  2. **宿主重启期间的「待确认」消息**：重启后补一次超时判定，间隔多久？
  3. **挂起状态是否可见**：发送方看到「已发送」还是「等待确认」？不可见会导致用户重发、造成重复。

## 九、剩余待定（留到实现时再定）

1. **handler 的优先级/顺序**：是否需要「内置 handler 先跑还是用户注册的先跑」的编排规则。倾向「注册顺序即执行顺序，内置 handler 默认最后」，避免用户 handler 被内置的拦在前面。
2. **确认超时的具体默认值**：5 分钟是初值，实现时可根据实际体验调整。
