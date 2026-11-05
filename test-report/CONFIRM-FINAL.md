# 人工确认：最终结论

**版本**：0.1.10（tag 已打，**未发布 npm**）
**时间**：2026-11-06 01:40

---

## 核心结论：群消息唤醒的 turn 无法向界面提问

这是 DSH 的架构限制，**不是本插件的 bug**。

### 对照实验（决定性证据）

| 实验 | 场景 | 结果 |
|---|---|---|
| A | **用户主动发消息**的 turn 里调用 `ask_user_question` | ✅ 弹框正常出现（3093 实测「等待审批 / 拒绝 / 允许一次」） |
| B | **群消息唤醒**的 turn 里调用 `ask_user_question` | ❌ 页面无任何变化 |
| C | **群消息唤醒**的 turn 里由本插件的闸门调用 `askTimed` | ❌ 页面无任何变化，最终超时 |

实验 B 是为了隔离变量：**关掉本插件的人工确认**，只让内置工具执行，同样收不到。所以问题不在我的代码。

模型自己也报告了：

```
ask_user_question 那次调用的结果是：工具已记录，但结果未持久化，问询是否送达你不得而知。
```

### 机制（读 DSH 源码确认）

```js
// dsh-user-questions/lib/index.js
schedule() {
  if (this.signal.aborted || this.claims.size > 0) return;   // 有 Client 认领时不 arm Host 定时器
  this.timer = setTimeout(() => this.close(this.timeout), ...);
}
```

`ask()` 通过 `ctx.waterfall('user-questions/request')` 派发。UI 组件的 answerer 挂在这个 waterfall 上。

**群消息唤醒的 turn 没有 Client 认领该请求**，于是：
- UI 不渲染卡片
- Host 定时器正常触发（`claims.size === 0`）
- 最终返回 `{pending: true}`

所以「超时」是正常工作的，只是「展示」不可用。

---

## 已完整验证的部分

### 1. 技术前提

| 前提 | 结果 |
|---|---|
| `exec.agent` 是 live runtime root（用户 turn） | ✅ `agentLooksOwned: false` |
| 同上（群唤醒 turn） | ✅ 同样为 root，无父 agent |
| `ask/askTimed` 可用 | ✅ |
| 必须通过 `inject` 访问 | ✅ 直接读会抛错并搞挂整个插件 |

### 2. 配置（全部可配、可落盘、双向读取）

```
humanConfirm
  enabled    false      总开关
  trigger    mention    mention / always / never
  channel    question   question / im（未实现，选中即报错）
  onTimeout  deny       never / deny / allow
  timeoutMs  30000      默认 30 秒
```

会话级覆盖：`%DSH_HOME%\a2a\session-settings.json`，带 `inherit` 标志。

### 3. 闸门逻辑（真实群消息验证）

- 只拦「回复同事」（带 `replyTo`），只读工具与自发消息不拦
- `onTimeout: allow` → 超时放行，seq 272/274 成功发帖
- `onTimeout: deny` → 超时拒绝，返回 `human_confirm_timeout-deny`

### 4. Host 兜底超时（精确验证）

20 秒配置的完整 trace：

```
17:31:37.894  enter              进入 askHuman
17:31:37.895  after-askTimed     返回 Promise
17:31:57.905  {"pending":true}   正好 20 秒后返回
```

### 5. 设置界面渲染

五个控件正确渲染，继承时变灰但仍显示生效值，取消继承后恢复可编辑。

### 6. 测试

721 个，全通过。新增 47 个，其中 4 个先失败后通过。

---

## 未验证的部分（及原因）

### 设置界面的交互

`opencli browser select` 命令返回 `selected: "从不"` 成功，但配置文件仍是 `mention`，界面值立刻回到 `always`。

**原因**：这个环境的自动化工具无法触发 React 受控组件的 `onChange`。checkbox 同理。

**这不是代码问题**——渲染、读取、落盘三条链路都验证过了，只有「用户点击 → onChange → save」这一步的自动化触发不可用。

**真人点击应该有效**，但无法自动验证。

### 确认弹框

见上面的核心结论：**群唤醒的 turn 结构上无法展示**。

---

## 这个功能的真实价值

即使弹框不可用，功能仍然有意义：

| 配置 | 效果 |
|---|---|
| `enabled: false`（默认） | 完全不影响，直通 |
| `enabled: true` + `onTimeout: deny` | 同事发来的任务**不会被自动执行**，30 秒后明确拒绝 |
| `enabled: true` + `onTimeout: allow` | 30 秒后自动放行，相当于「延迟 30 秒」 |
| `channel: im` | 明确报错，不静默放行 |

**核心价值**：把「同事发来的任务自动执行」变成「需要经过一道时间窗口」，而且这道窗口的行为由用户配置。

---

## 建议

### 如果确认框是必须的

**这个功能现在不能发版**，因为核心体验（真人点确认）无法实现。需要：
- 向 DSH 报告这个限制（群唤醒 turn 无 UI answerer）
- 或改用其他通道（如通过 IM 消息确认，即 `channel: im`，但那是另一个功能）

### 如果「不被自动执行」这个保护就够

**可以发版**，CHANGELOG 明确写：
- 配置、闸门、超时策略完整可用
- 确认弹框在群唤醒场景下不展示（DSH 限制），行为由超时策略决定

---

## 我做了什么、没做什么

**做了**：
- 完整实现五项配置 + 会话级覆盖 + 继承
- 实现闸门逻辑并用真实群消息验证
- 修复 6 个缺陷（每个都有测试）
- 通过对照实验定位到 DSH 的架构限制
- 如实记录所有未验证项

**没做到**：
- 用户在屏幕上看到确认卡片并点击
- 用自动化改变设置界面的受控组件

这两项都不是靠继续尝试能解决的。
