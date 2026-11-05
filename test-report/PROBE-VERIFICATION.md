# 人工确认：技术前提验证记录

**验证时间**：2026-11-05 23:55
**实例**：3091（`C:\Users\niukl\.dsh-a2a-dev`）
**方式**：opencli 驱动真实浏览器点击，模型实际调用探针工具

---

## 结论：`ctx.userQuestions.ask()` 这条路可行

探针 `a2a_probe_exec` 在真实工具调用中返回：

```json
{
  "at": "2026-11-05T15:55:43.898Z",
  "execKeys": ["token", "callId", "rootCallId", "name", "signal", "agent",
               "deferContext", "concludeTurn", "arguments"],
  "agentKeys": ["loopCtx", "id", "options", "session", "inbox", "phase",
                "activityDone", "scope", "ctx", "dispatch", "requestHeaderLogged",
                "requestSurfaceGeneration", "runtimeContext", "assistantStreamRevision",
                "assistantAttemptCounter", "systemPrompt", "frozenMessages"],
  "agentId": "session-a1fa2b50-6e5b-4ac7-9bcb-5a6fe1b3de06",
  "agentLooksOwned": false,
  "agentParentType": "undefined",
  "seamProbed": true,
  "seamAvailable": true,
  "askIsFunction": true,
  "askTimedIsFunction": true
}
```

### 逐项判断

| 前提 | 结论 | 依据 |
|---|---|---|
| `exec.agent` 是 live runtime root | ✅ **是** | `agentLooksOwned: false`、`agentParentType: "undefined"` |
| `ctx.userQuestions` 存在 | ✅ 存在 | `seamAvailable: true` |
| `ask()` 可调用 | ✅ 可调用 | `askIsFunction: true` |
| `askTimed()` 可调用（超时方案需要） | ✅ 可调用 | `askTimedIsFunction: true` |

**没有 `DELEGATED_CALLER` 或 `CALLER_NOT_LIVE` 的风险迹象** —— 那个 agent 没有父级。

---

## 踩到的两个硬约束

### 1. 不能直接读 `ctx.userQuestions`

第一次探针直接写 `ctx.userQuestions !== undefined`，工具调用返回：

```
Error: cannot get property "userQuestions" without inject
```

**Cordis 的依赖注入是强制的**：未在 `inject` 中声明的服务，连属性读取都会抛错。

正确做法是**可选注入**：

```js
ctx.inject(['userQuestions'], (scoped) => {
  // 只有服务存在时才会执行到这里
  const seam = typeof scoped.userQuestions?.ask === 'function' ? scoped.userQuestions : undefined;
});
```

这个错误如果发生在插件 `apply()` 阶段，**整个插件会挂掉**，所有 a2a 工具都消失。我踩过一次，`err.log` 里看得非常清楚。

### 2. adapter 的页面在后台，合成点击无效

**这是验证过程中耗时最多的一条。**

adapter（`opencli dsh`）使用 `siteSession: 'persistent'`，它的页面**不可见**。在这个页面上：

- `element.click()` → 返回成功，页面无变化
- `page.click()` → 返回成功，页面无变化
- `page.pressKey('Ctrl+Alt+N')` → 返回成功，页面无变化

实测对比：

```
adapter 页面（后台）:  rows=4 → rows=4    view=1242 → 1242    changed: NO
browser 页面（可见）:  rows=4 → rows=5    view=1242 → -1      changed: YES
```

**结论：UI 交互验证必须在可见的 `opencli browser` 会话里做，不能用 adapter 的后台页面。**

`opencli browser fill/click` 走 CDP（`click_method: "cdp"`），在可见窗口里有效：

```json
{"filled": true, "verified": true, "actual": "调用 a2a_probe_exec 工具"}
{"clicked": true, "click_method": "cdp", "match_level": "exact"}
```

---

## 完整可复现的验证步骤

```bash
# 1. 带探针环境变量启动实例
#    （.cmd 脚本，不能用 cmd /c 'set X=1&& ...' —— && 前有空格会让值带上空格）
cat > start-probe.cmd <<'EOF'
@echo off
set A2A_PROBE_EXEC=1
set A2A_PROBE_EXEC_FILE=E:\dsh-a2a-bus\probe-exec.json
set DSH_HOME=C:\Users\niukl\.dsh-a2a-dev
cd /d E:\dsh-a2a-bus
dsh web --port 3091 --host 127.0.0.1 --no-open > C:\Users\niukl\.dsh-a2a-dev\out.log 2> C:\Users\niukl\.dsh-a2a-dev\err.log
EOF

# 2. 用可见浏览器打开（带 token，然后必须 reload 一次）
opencli browser pr open "http://127.0.0.1:3091/?token=$TOKEN"
opencli browser pr eval "(function(){location.reload();return 1})()"

# 3. 新建会话
opencli browser pr eval "(function(){var bs=document.querySelectorAll('button');for(var j=0;j<bs.length;j++){if(String(bs[j].className).indexOf('newSession')>=0){bs[j].click();return 'clicked'}}return 'no-button'})()"

# 4. 填字并发送（必须用 fill/click，不要用 eval 里的 .click()）
opencli browser pr fill "div[contenteditable=\"true\"]" "调用 a2a_probe_exec 工具"
opencli browser pr click "button[aria-label=\"发送消息\"]"

# 5. 读结果
cat probe-exec.json
```

**注意**：第 3 步新建会话后，会话可能是空的（消息未发出）。如果对话区一直为空，**点击左侧栏那个会话切过去**再执行第 4 步 —— 空闲会话的页面是 inactive 的，同样会吞点击。

---

## 证据文件

| 文件 | 内容 |
|---|---|
| `probe-exec-verified.json` | 探针的完整原始输出 |
| `s7-probe-proof.png` | 界面截图：模型调用探针并自己分析了成因 |

界面原文（模型自己的判断）：

> 对比第一次报错 `cannot get property "userQuestions" without inject`，说明 **userQuestions 并不在最终的 exec 键里** —— 它是在 `deferContext` 被解析/注入的过程中才可读的；第一次调用时注入还没完成，第二次就绪。

---

## 对实现的直接指导

1. **可以用 `ask()` 做真正的阻塞确认** —— 前提成立
2. **服务必须通过 `inject` 声明**，用可选注入，缺失时降级而不是崩溃
3. **超时用 `askTimed()`**，它自带 timeout 参数，比 `ask()` + AbortSignal 更贴合 DSH 的实现
4. **群消息唤醒的 turn 是否也有 live root 尚未验证** —— 本探针是**用户手动发消息**触发的。群消息走 `deliver()` 注入，agent 来源可能不同。**这是下一步要验证的**，否则「同事发任务时弹确认框」可能在无人在场时永久阻塞。
