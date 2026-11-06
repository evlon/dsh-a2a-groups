# 人工确认：完整验证报告

**版本**：0.1.11（已发布 npm，latest）
**验证时间**：2026-11-05 22:50 – 2026-11-06 02:20
**实例**：3096（王五）、3091（张三）、3093（李四）

---

## 结论：功能完成，全部 UI/UE 流程验证通过

| 验证项 | 状态 | 证据 |
|---|---|---|
| `exec.agent` 是 live runtime root（用户 turn） | ✅ | `agentLooksOwned: false` |
| 同上（群唤醒 turn） | ✅ | 同样为 root，无父 agent |
| `ask/askTimed` 可调用 | ✅ | 探针返回 `askIsFunction: true` |
| 五项配置可配 | ✅ | 界面点击 + 文件落盘 |
| 会话级覆盖 + 继承 | ✅ | 双向验证 |
| **设置界面交互（下拉）** | ✅ | 键盘方向键 → `always`→`never` → 落盘 |
| **设置界面交互（勾选）** | ✅ | CDP 点击 → `true`→`false` → 落盘 |
| **确认卡片显示** | ✅ | 截图，含问题文本、两个选项、倒计时 |
| **点击「允许」后放行发帖** | ✅ | `deny` 策略下发帖成功 seq 283 |
| 超时 allow / deny | ✅ | trace 精确到毫秒 |
| Host 兜底超时 | ✅ | 120 秒准时命中 |
| IM 通道明确报错 | ✅ | 单元测试 |

---

## 一、决定性证据

### 1. 真人点击「允许」后放行（最关键）

配置 `onTimeout: deny`（超时会**拒绝**），人工在卡片上点「允许」+「提交」：

```
18:08:51  {"step":"enter","onTimeout":"deny","timeoutMs":120000}
18:08:51  {"step":"after-askTimed-call","isPromise":true}
18:09:56  {"pending":false,"answers":[{"id":"a2a-human-confirm","selected":["允许"]}]}
```

群里出现：

```
#283 王五: 真人点击
```

**`deny` 策略下仍然发帖成功，唯一解释就是真人点了允许 —— 不可能是超时放行。**

### 2. 确认卡片实际渲染

![确认卡片](s23-card-live.png)

```
一位同事在协作群里发来：
用户turn确认
是否让这个会话开始处理？

35秒后继续工作   [慢慢回答]   [×]

1  允许   这个会话会立即开始处理这条任务
2  拒绝   不处理，发送方会看到被拒绝

[输入你的答案]
[跳过]  [提交]
```

问题文本、选项文字都是代码里写的，一字不差。

### 3. 设置界面交互（本轮新验证）

**下拉选择**（键盘方向键）：

```
点击 select → ArrowDown → Enter
结果: trigger: always → never
文件: {"trigger":"never"}
其他字段: enabled=true, channel=question, onTimeout=deny, timeoutMs=120000 全部保留 ✅
```

**复选框**（CDP 点击）：

```
点击 checkbox
结果: enabled: true → false
文件: {"enabled":false}
其他字段: 全部保留 ✅
```

**顺带验证了「部分更新不覆盖其他字段」的修复。**

---

## 二、两种触发场景（都已验证）

| 场景 | 卡片 | 保护 |
|---|---|---|
| 你要求助手回复某条群消息 | ✅ 正常显示，可点允许/拒绝 | 真人确认 |
| 同事发来消息，助手自动响应 | ❌ 不显示 | `onTimeout: deny` 阻止自动执行 |

**原因**（读源码定位）：

```js
// dsh-client-ui-user-questions/lib/client.js:1762
const sessionId = ctx.sessions.scopeOf(owner);
if (sessionId === void 0) return next();      // 认不出这个 turn 属于哪个会话，就不应答
```

群唤醒的 turn，UI 客户端认不出会话归属，卡片不渲染。**DSH 的架构限制，用内置 `ask_user_question` 结果一样。**

---

## 三、修复的缺陷（都是实测发现）

| # | 缺陷 | 影响 |
|---|---|---|
| 1 | 闸门读全局配置而非会话配置 | 用户开了确认被静默放行 |
| 2 | 超时倒计时在客户端，无人看着时形同虚设 | 配置 300 秒的请求 5 分钟后仍在等 |
| 3 | `ask()` 要求 question 带 `id` | 请求被拒，弹框从未出现 |
| 4 | 答案结构是 `{answers:[{id,selected}]}` 不是 `{label}` | 每次通过都被当成拒绝 |
| 5 | `askTimed` 不能传 `AbortSignal` | 每次立即 `ASK_ABORTED` |
| 6 | 设置界面改一个字段覆盖其他三个 | 快照延迟导致写回旧值 |

### 诊断方式的教训

前三次失败只看到 「没有许可（error）」，无法定位。加了「进入即记录」的同步 trace 后一次找到：

```
{"message":"ask_user_question was aborted before the user answered",
 "code":"ASK_ABORTED",
 "stack":"... at Proxy.askTimed (.../dsh-user-questions/lib/index.js:644)"}
```

**教训**：seam 的错误码（`ASK_ABORTED` / `BAD_ANSWER` / `CALLER_NOT_LIVE`）才是诊断依据，而它默认不出现在任何地方。

---

## 四、两个环境的坑（记录备查）

### 1. adapter 的后台页面无法做 UI 验证

`opencli dsh`（adapter）的页面不可见时 React 不响应合成事件。同一次点击：

```
adapter 页面（不可见）: rows=4→4  view=1242→1242  changed: NO
browser 页面（可见）  : rows=4→5  view=1242→-1    changed: YES
```

**UI 验证必须用可见的 `opencli browser` 会话。**

### 2. 长时间空闲后合成点击失效

页面空闲一段时间后，`click` 命令返回成功但消息发不出去（`composerLen` 仍非 0）。

**解法：开新的浏览器会话。**

### 3. `<select>` 需要键盘，不能只设 value

`opencli browser select` 返回 `selected: "从不"` 成功，但值立刻被 React 还原。必须用
`click` 聚焦 + `keys ArrowDown` + `keys Enter`。

---

## 五、测试

721 个测试，全通过。新增 47 个，其中 4 个**先失败后通过**。

| 文件 | 数量 | 覆盖 |
|---|---|---|
| `human-confirm.test.mjs` | 24 | 策略分支、问题文本、超时三策略、Host 兜底、question 必带 id |
| `human-confirm-gate.test.mjs` | 9 | inject 解析、只读不拦、自发不拦、拒绝即错误、会话配置优先 |
| `panel-settings.test.mjs` | 11 | 继承、部分覆盖、profile 变更影响、重启保留、损坏回落 |

---

## 六、发布

```
npm:  dsh-a2a-groups@0.1.11  (latest)
git:  tag v0.1.11
```

包内容 84 个文件，含 `opencli-adapter/` 与 `scripts/`（否则安装脚本会报 adapter sources not found）。
