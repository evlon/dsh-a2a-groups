# 人工确认：当前状态与未解问题

**版本**：0.1.10（已打 tag，**未发布 npm**）
**时间**：2026-11-06 01:26

---

## 已完成并验证

### 1. 技术前提（全部实测）

| 前提 | 结果 |
|---|---|
| `exec.agent` 是 live runtime root（用户发起的 turn） | ✅ `agentLooksOwned: false` |
| **同上（群消息唤醒的 turn）** | ✅ 同样为 root，无父 agent |
| `ctx.userQuestions.ask/askTimed` 可用 | ✅ 两者都是 function |
| 必须通过 `inject` 访问 | ✅ 直接读会抛错并搞挂整个插件 |

### 2. 配置项（全部可配、已落盘、双向验证）

```
humanConfirm
  enabled    false      总开关
  trigger    mention    mention / always / never
  channel    question   question（已实现）/ im（未实现，选中即报错）
  onTimeout  deny       never / deny / allow
  timeoutMs  300000
```

会话级覆盖存在 `%DSH_HOME%\a2a\session-settings.json`，带 `inherit` 标志。

### 3. 设置界面（完整验证）

五个控件渲染正确，「沿用全局设置」勾选时变灰但仍显示生效值，取消后恢复可编辑，改动正确落盘。

### 4. 闸门逻辑（真实群消息验证）

- 只拦「回复同事」（带 `replyTo`）
- 只读工具、自发消息不拦
- `onTimeout: allow` → 超时放行，seq 272/274 成功发帖
- `onTimeout: deny` → 超时拒绝，错误码 `human_confirm_timeout-deny` 正确返回给模型

### 5. 测试

721 个，全通过。新增 47 个，其中 4 个是**先失败后通过**的（证明 bug 真实存在）。

---

## 两个未解问题

### 问题 1：`askTimed` 的确认卡片没有送达界面

**现象**

- `askTimed` 确实阻塞（诊断文件记录 `{"pending":true,"callId":"a2a-confirm-..."}`，模型界面显示
  「工具调用 · a2a_group_post」+「深度求索中用时 1 分 41 秒」）
- 但页面上**没有任何确认卡片**（`questionNodes: []`，按钮列表里没有确认按钮）

**已排除**

| 可能 | 证据 |
|---|---|
| UI 组件没装 | `userQuestionBundles: 1`，已加载 |
| UI 组件坏了 | DSH 自带的 `ask_user_question` 在同一页面**能弹出**带选项的卡片 |
| 页面在后台被节流 | 用 `--window foreground` 前台窗口，同样收不到 |
| 页面断连 | 前台窗口 `rc: false`（无「重新连接中」）时仍然收不到 |

**剩下的可能**

群消息通过 `deliver()` 注入产生的 turn，与 UI 订阅的 agent 实例不是同一个作用域。`askTimed` 校验的
是 `agent.id`（相同），而 UI 的 answerer 挂在 Agent 作用域的 waterfall 上（可能不同源）。

**结论**：这很可能是 DSH 的架构限制，不是本插件的 bug。但**无法从外部证实**。

### 问题 2：~~Host 侧兜底超时在实际运行中没有观察到~~（已排除，是我的误判）

**更正**：上一轮我判断「Host 兜底没生效」，那是**测错了**——配置了 180 秒，却只等了约 100 秒就去看结果。

加上「进入即记录」的同步 trace 后重测（20 秒配置），链路完全正确：

```
17:31:37.894  enter            进入 askHuman
17:31:37.894  before-askTimed  调用前
17:31:37.895  after-askTimed   isPromise: true
17:31:57.905  {"pending":true} 正好 20 秒后返回
```

群里结果：`#280` 只有张三的请求，**王五没有发帖** —— `deny` 生效。

**所以 `Promise.race` 兜底是work的。**

教训：**验证超时类行为，等待时间必须明显大于配置值**，否则会把「还在等」误判成「不会超时」。

顺带修了诊断本身的两个问题：

1. 原来用异步写入，连续三次调用（enter / before / after）会互相覆盖 —— 改成同步 append
2. 原来只在出错时写 —— 改成进入时就写，否则「没进函数」和「进了但挂住」无法区分

---

## 对功能的影响

### 能用的部分

| 场景 | 行为 |
|---|---|
| 配置关闭 | 完全不影响，直通 |
| `onTimeout: allow` + 短超时 | 超时后放行，**已验证成功发帖** |
| `onTimeout: deny` + 短超时 | 超时后拒绝，**已验证正确返回错误码** |
| `channel: im` | 明确报错，不静默放行 |

### 不能用的部分

**「弹出确认框，等用户点击允许/拒绝」这条完整路径，在当前 DSH 版本下不可用。**

用户不会看到弹框，只能依赖超时策略。

---

## 我的建议

### 选项 A：把默认值改成更保守的组合

```
enabled: false          默认关闭（已是）
trigger: mention        只拦被 @ 的
onTimeout: deny         超时拒绝
timeoutMs: 30           短超时，30 秒就放弃
```

**理由**：既然弹框收不到，长时间等待只会让会话卡住。30 秒超时至少让发送方快速得到「被拒绝」的反馈。

### 选项 B：先不发版，继续排查弹框送达问题

如果弹框是必须的体验，那这个功能现在不算完成。

### 选项 C：发版，但 CHANGELOG 明确写「确认弹框暂不可用，仅超时策略生效」

诚实告知用户，等 DSH 或插件后续修复。

---

**我倾向 A + C 组合**：改成短超时（30 秒）让功能至少可用，同时在 CHANGELOG 里说明弹框的现状。

但这需要你决定——因为「确认弹框不出现」和你原本的预期差距很大。
