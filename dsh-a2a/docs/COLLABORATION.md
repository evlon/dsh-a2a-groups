# 协作模式对照：DSH 内置团队 vs 协作群

> 结论先行：我们现在是**聊天室**，DSH 内置团队是**任务协作系统**。
>
> 三个人在群里「看好像在聊天」，是因为**没有任务板、没有状态机、没有唤醒契约**——每个人只能靠发消息表达进展，
> 于是消息量爆炸而信息密度极低。

---

## 一、DSH 内置团队的约定义

来源：`@deepseek-ai/dsh-experimental-agent-team`（6.2MB）、`dsh-experimental-tool-agent-team`。

### 1.1 角色

```ts
interface TeamMembership {
  root: Agent;
  id: TeamId;
  role: 'lead' | 'teammate';   // ← 只有两种，Lead 是唯一的
  name: string;
}
```

**Lead 只有一个，其余都是 teammate。** 不是"平级聊天"，是有明确指挥链的两层结构。

### 1.2 成员状态

```ts
status: 'running' | 'inactive' | 'provisioning' | 'failed'
```

**关键是 `inactive` 的定义**（来自工具描述原文）：

> inactive means no turn is executing; it does not describe task completion, success, failure, or waiting for other agents.

**`inactive` 不是「空着」，是「没有 turn 在执行」** —— 它刻意不承载「做完没」的语义。

### 1.3 共享任务板

```ts
interface TeamTaskSnapshot {
  id: TeamTaskId;
  revision: number;        // ← CAS 乐观锁
  subject: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'deleted';
  ownerId?: SessionId;
  blockedBy: TeamTaskId[]; // ← 依赖 DAG
  writeScopes: string[];   // ← 写下哪些文件的约定
}
```

**每个变更 `revision + 1`，用 CAS 更新。** 两个人同时改同一个任务，只有一个成功，另一个拿到新 revision 重试。

### 1.4 唤醒契约（最关键）

```
wait_agent  ← 等待「下一个变化」，不是轮询
send_message ← 消息到达时「启动或恢复」目标
```

工具描述的原文（这段是整个设计的核心）：

> Wait for the next teammate status, message, or shared-task change after this call starts.
> This never wakes inactive members and returns noProgress immediately when no other member is running or provisioning.
> **Re-list after wakeup or timeout instead of polling.**

**三件事：**

| 机制 | 作用 |
|---|---|
| `wait_agent` | 阻塞等下一个事件，**不消耗 token 轮询** |
| `send_message` | 消息不排队等人查，**直接启动对方** |
| `Re-list after wakeup` | 醒来第一件事是重新读状态，**不相信缓存的视图** |

### 1.5 明确写下的失败模式

> A successful send does not mean the recipient has processed it.

**这条单独写在工具描述里**，因为它是最常见的误判。

---

## 二、我们的协作群现状

### 2.1 角色

```
group.ownerPersonId  +  member.role: 'owner' | 'member'
```

有群主，但**群主只是权限概念**（谁能删人、改名），不是**指挥角色**。

### 2.2 成员状态

```
online: at - lastSeenAt <= 120_000    （刚改成派生值）
```

只有在线/离线，**没有「正在做什么」**。

### 2.3 没有任务板

群消息就是唯一的工作记录。想表达「我在做 X」只能发一条消息。

### 2.4 消息投递

```
group/subscribe  → SSE 长连接 + 50 秒心跳
```

**消息到达时，对方在做别的事就只是排进队列**，等他下次 turn。

### 2.5 为什么「看好像在聊天」

因为**缺少中间层**：

```
有任务板：  A 做完了 → 更新任务状态 → 触发 B 的开始条件
          （一条状态变更，零条消息）

没有任务板：A 做完了 → 发消息「我好了」→ B 回「收到，我来」→ B 做完了 → 发消息
          （每个交接 3-4 条消息）
```

三个人各做各的，每个交接 3-4 条消息，**信息全是「我开始了/我做完了/收到」**，没有任何决策内容。

---

## 三、差距清单

| 维度 | DSH 团队 | 协作群 | 影响 |
|---|---|---|---|
| **等待机制** | `wait_agent` 事件等待 | SSE + 心跳轮询 | 消息延迟 + 无效唤醒 |
| **消息→启动** | `send_message` 直接 resume | 排队等下次 turn | **对方不响应** |
| **任务板** | 有（含 DAG、CAS） | 无 | **消息量爆炸** |
| **写入域** | `writeScopes` 声明 | 无 | **改同一文件互相覆盖** |
| **状态语义** | running/inactive/provisioning/failed | online/offline | 无法表达「在做」 |
| **送达确认** | 「成功发送不代表已处理」 | 无此约定 | 误判对方已收到 |
| **唤醒后动作** | Re-list，不信缓存 | 无约定 | **基于旧状态决策** |

---

## 四、按成本排序的改进

### P0：改一行就能做的（半天）

**1. 消息正文自动带上发送者状态**

每条群消息的 `from` 加一个字段：

```json
{ "personId": "p-2", "displayName": "李四", "activity": "working | idle | blocked" }
```

发送者自己在调 `a2a_group_post` 时声明。成本极低，但**让「他在做什么」可表达**。

**2. 投递时明确「已送达 ≠ 已处理」**

现在我们返回 `{seq: 120}` 就完了。要改成：

```
已送达序号 120。注意：这表示消息进入了群记录，
不表示对方已读——他下次检查时才会看到。
```

**这条直接来自 DSH 团队的写法**，也是我们最容易误判的地方。

### P1：需要设计但不难（2-3 天）

**3. 群任务板**

最小版本：

```js
a2a_group_task_create({ groupId, subject, description, blockedBy: [] })
a2a_group_task_list({ groupId })
a2a_group_task_update({ groupId, taskId, action, expectedRevision })
```

**关键**：带 `expectedRevision` 做 CAS。两个人同时接同一任务，只有一个成功。

**效果**：交接不需要发消息。A 完成任务 → B 的 `blockedBy` 空了 → B 自己发现可以做。

**4. 唤醒：订阅时带 `sinceSeq`，服务端只推增量**

现在我们的 subscribe 是全量推送？查一下。

### P2：架构级（1 周+）

**5. 把「群主」升级为「Lead」**

- 群主可以 `assign`（派人做事）
- 群成员可以向群主 `report`（不是发群消息）
- 明确两层：群主 ↔ 成员，而不是人人平等

**6. 写入域**

`a2a_group_post` 时声明「我这次改了哪些文件」，冲突时警告。

---

## 五、我建议先做什么

**先做 P0 的两条**，因为它们：

1. 成本极低（改描述 + 加一个字段）
2. **直接减少消息量**（「他在做什么」不用发消息问）
3. 修正一个**已经存在的误判**（以为发了就是送到了）

**任务板（P1）是真正的解法**，但需要设计。我建议**先做 P0 观察效果**——可能 P0 之后消息量就降下来了，任务板的需求会变小。

---

## 六、一个判断

你说「好像大家在群聊，我怀疑，但没有证据」。

**证据在这里**：看 feed 的 seq 增量。

```
seq 106 → 113  七轮讨论
其中真正的「决策」只有 3 条
其余 4 条是「我接受你的更正」「我撤回」「同意停」
```

**这是没有任务板的必然结果**：没有共享状态，「共识」只能靠对话建立，而对话每轮都要重复上轮内容。

要我现在做 P0，还是直接设计任务板？
