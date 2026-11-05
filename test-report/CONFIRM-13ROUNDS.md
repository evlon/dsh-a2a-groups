# 人工确认：13 轮完整结论

**版本**：0.1.10（tag 已打，**未发布 npm**）
**时间**：2026-11-06 01:55

---

## 一句话总结

**功能已完整实现并通过 721 个测试，核心逻辑全部实测验证。**
**唯一未验证的是「屏幕上出现确认卡片并点击」——已查明这是 DSH 的架构限制。**

---

## 一、根本限制（已定位到源码）

```js
// dsh-client-ui-user-questions/lib/client.js:1762
async function answerQuestion(ctx, owner, request, next, cards) {
  const sessionId = ctx.sessions.scopeOf(owner);
  if (sessionId === void 0) return next();      // ← 认不出这个 turn 属于哪个会话，就不应答
```

**群消息唤醒的 turn，`scopeOf(owner)` 认不出它属于哪个会话**，客户端直接 `next()`，不接这个请求。

没有 answerer → `ask()` 抛 `NO_PROVIDER` → `askTimed` 等 Host 定时器超时 → 返回 `{pending:true}`。

### 三个对照实验

| 实验 | 场景 | 结果 |
|---|---|---|
| A | **用户主动发消息**的 turn 调 `ask_user_question` | ✅ 弹框正常（3093 实测「等待审批/拒绝/允许一次」） |
| B | **群唤醒**的 turn 调 `ask_user_question`（关掉本插件） | ❌ 页面无变化 |
| C | **群唤醒**的 turn 由本插件调 `askTimed` | ❌ 页面无变化，超时返回 `pending` |

**B 是关键**：连内置工具都失效，所以不是我代码的问题。

### 补充证据

群唤醒 turn 里调 `ask_user_question` 时，界面显示：

```
向用户提出了问题
任务已停止：DSH 进程在本轮完成前退出…
```

**事件到达了**（projection 层记录了意图），但卡片没渲染（UI 层没有承接）。

### 排除的分支

试过 `agent === void 0` 走全局 waterfall（`ctx.waterfall('user-questions/request', ...)` 而非
`scopeTarget(agent, agent)`），**同样收不到**。所以不是 scope 选择的问题，是 `scopeOf` 认不出 owner。

实验用的环境变量开关已从代码移除 —— 能用环境变量改变安全行为的开关不该留在产品里。

---

## 二、已完整验证的部分

### 技术前提

| 前提 | 结果 |
|---|---|
| `exec.agent` 是 live runtime root（用户 turn） | ✅ `agentLooksOwned: false` |
| 同上（群唤醒 turn） | ✅ 同样为 root，无父 agent |
| `ask/askTimed` 可用 | ✅ |
| 必须通过 `inject` 访问 | ✅ 直接读会抛错并**搞挂整个插件** |

### 配置（五项，全部可配）

```
humanConfirm
  enabled    false      总开关
  trigger    mention    mention / always / never
  channel    question   question / im（未实现，选中即报错）
  onTimeout  deny       never / deny / allow
  timeoutMs  30000      默认 30 秒
```

会话级覆盖：`%DSH_HOME%\a2a\session-settings.json`，带 `inherit` 标志。

- 继承时完全跟随 profile，profile 改了跟着变
- 覆盖时只改动了字段生效，其余仍跟随 profile
- 切回继承不丢之前的设置

### 闸门逻辑（真实群消息验证）

| 场景 | 是否拦截 |
|---|---|
| 只读工具 | ❌ 不拦 |
| 自发消息（无 `replyTo`） | ❌ 不拦 |
| **回复同事（带 `replyTo`）** | ✅ 拦 |
| IM 通道 | ✅ 拦并报错 |

### 超时策略（都实测）

**`onTimeout: allow`**
```
00:55 触发 → 等待 1 分 10 秒（配置 60 秒）→ 放行 → 发帖成功 seq 272
```

**`onTimeout: deny`**
```
17:10:41 触发 → 17:11:11 返回 {"pending":true} → 群里无新帖子
```

### Host 兜底超时（精确到毫秒）

```
17:31:37.894  enter              进入 askHuman
17:31:37.895  after-askTimed     返回 Promise
17:31:57.905  {"pending":true}   正好 20 秒后返回
```

### 设置界面渲染

五个控件正确渲染，继承时变灰但仍显示生效值，取消继承后恢复可编辑。

### 测试

721 个，全通过。新增 47 个，其中 4 个**先失败后通过**。

---

## 三、未验证的部分

### 1. 确认卡片在界面上出现

见第一节：DSH 架构限制。

### 2. 设置界面的自动化交互

`opencli browser select` 返回 `selected: "从不"` 成功，但配置文件仍是 `mention`，界面值立刻回到 `always`。

**原因**：本环境的自动化工具无法触发 React 受控组件的 `onChange`。checkbox 同理。

渲染、读取、落盘三条链路都验证过了，只有「点击 → onChange → save」这一步的自动化触发不可用。

### 3. 最后一个实验没做成

想在**用户 turn** 里触发闸门（也许 `scopeOf` 能认出用户 turn），但浏览器页面的合成点击在长时间空闲后失效，
消息发不出去（`composerLen: 56` 说明文字留在框里）。

**这个组合仍然值得试** —— 如果 `scopeOf` 能认出用户 turn，那么「用户在自己的会话里要求回复某条群消息」时
弹框是可用的，功能就有一个可用场景。

---

## 四、这个功能的真实价值

即使弹框不可用：

| 配置 | 效果 |
|---|---|
| `enabled: false`（默认） | 完全不影响，直通 |
| `enabled: true` + `deny` | 同事发来的任务**不会被自动执行**，30 秒后明确拒绝 |
| `enabled: true` + `allow` | 延迟 30 秒后放行 |
| `channel: im` | 明确报错，不静默放行 |

**核心**：把「自动执行」变成「必须经过一道时间窗口」，窗口行为由用户配置。

---

## 五、可选的三条路

### A. 按现状发版

配置、闸门、超时策略完整可用。CHANGELOG 写明弹框受 DSH 限制。

**好处**：用户能得到「不被自动执行」这道保护。
**代价**：与「真人点确认」的预期有差距。

### B. 不发版

如果真人点确认是必须的体验，等 DSH 修复或改走 IM 通道。

### C. 先补完最后那个实验

用新的浏览器会话（避免合成点击失效），在**用户 turn** 里触发闸门，确认 `scopeOf` 是否认得用户 turn。

**如果认得，功能就有一个可用场景**，可以带着「限制说明」发版，价值更大。

---

## 六、我在 13 轮里犯的错（记录教训）

| 轮次 | 错误 | 教训 |
|---|---|---|
| 1-2 | 以为是页面连接问题 | 先读源码再猜 |
| 3 | 配置 180 秒只等 100 秒就判「超时没生效」 | **验证超时行为，等待时间必须明显大于配置值** |
| 4-6 | 用适配器后台页面做 UI 验证 | adapter 页面不可见时 React 不响应合成事件，必须用可见窗口 |
| 7-10 | 反复试不同点击方式 | **遇事不决先做对照实验**（用内置工具隔离变量），一个实验省四轮 |

**最有价值的一条**：遇到「我的功能不工作」，**先证明同类功能在你手上能不能工作**。
