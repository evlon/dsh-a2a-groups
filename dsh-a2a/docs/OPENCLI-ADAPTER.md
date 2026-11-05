# DSH Web 的 opencli adapter

一个 opencli adapter，像真人一样驱动 DSH Web UI —— 在输入框里打字、按回车、读屏幕上出现了什么 —— 好让测试能证明
**用户走的那条路**是通的，而不只是证明代码写完了。

**位置：** `~/.opencli/clis/dsh/`

```
_ops.js    共享选择器、导航、输入、读对话
open.js    按端口打开一个实例
read.js    读当前可见的对话
send.js    打字并发送
```

---

## 为什么需要它

这个项目的验证一直以同一种方式失败：改动被单元测试和读代码确认过，然后第一次被人用就坏了。项目自己的历史里有两个例子：

- 一个按钮把提示词填进输入框，而后端以 `invite_invalid` 拒绝。面板看起来对，后端看起来也对，**中间那条路断了**。
  读任何一边都不可能发现。
- 一个面板在新消息到达后不再重绘，因为变更签名没有包含那个会变的字段。数据一直是对的，只有屏幕是错的。

这两种都对单元测试不可见，对一次点击却显而易见。这个 adapter 存在的意义，就是让那次点击可以自动化。

---

## 命令

### `open` —— 按端口打开一个实例

```bash
opencli dsh open --port 3096 --home C:\Users\niukl\.dsh-a2a-dev3 -f json
```

```json
[{ "url": "http://127.0.0.1:3096/", "ready": true }]
```

**按端口而不是按 URL 定位**是刻意的：每个实例打印的 URL 带一次性 token，每次重启都会变，粘 URL 会让测试无法维护。
`--home` 指向实例的 `DSH_HOME`，token 从它的 `out.log` 里读。

用 `--path /join` 打开加入页而不是主界面。

### `read` —— 读当前可见的对话

```bash
opencli dsh read --last 5 -f json
opencli dsh read --contains "已发送（seq 144）" --timeout 30 -f json
```

```json
[{ "index": 1, "text": "我认为最重要的盲点：…" }]
```

`--contains` 是重要的那个形式：它用一个来回问出测试真正关心的问题 —— **这段文字变成可见了吗？** —— 并且在文字没出现时
明确报告「未出现」，而不是返回一张空表，那张空表读起来像「没有消息」。

### `send` —— 打字并发送

```bash
opencli dsh send --text "请回复两个字：收到" --timeout 90 -f json
```

```json
[{ "sent": true, "via": "button", "typed": "请回复两个字：收到", "replied": true, "settled": true, "grew": 2, "composerAfter": "(empty)" }]
```

`--port` 可省略；在已经跑过 `open` 的测试里省略它，命令会使用已打开的页面。

---

## 一个最小的测试

```bash
opencli dsh open --port 3096 --home "$DSH_HOME"
opencli dsh send --text "用 a2a_group_join 重新加入「发票与对账平台」" --timeout 180
opencli dsh read --contains "已加入" --timeout 30
```

**第三条命令就是断言。** 当指令发出去了、但结果始终没出现在屏幕上，它会失败 —— 而这正是这个 adapter 被造出来对付的
那类 bug。

---

## 塑造了实现的发现

下面每一条都花掉一轮调试，没有一条能靠猜得出。

### 1. 带 token 的 URL 会渲染自己的 401 页

`GET /?token=…` 应答 **303 → `/`** 并带 `Set-Cookie: dsh-auth-…; HttpOnly; SameSite=Strict`。所以这个 cookie 是在产生
那第一个响应的文档之后才到达的，于是页面显示「dsh web authentication required」，而它发出的每一个同源请求其实都已
成功。直接测过：页面内 XHR 到 `/` 返回 **200**，而可见文档仍写着需要认证。

**重新加载一次即可。** `ensureOnInstance` 会导航、检查页面是否已认证、没有就重载。

### 2. `<main>` 不存在

外壳是 `<div class="_frame">` → `_sidebarCol` + `_centerCol` → `_root` → `header` + `_body` → `_scrollBody`。
以 `main`、`[data-message-id]` 或 `[data-testid]` 为键的选择器匹配不到任何东西，于是命令在一个显示着完整对话的页面上
报告「没有可见文字」。

### 3. 有 37 个元素的 class 包含 `_body`

大多数是空的布局壳。对那个子串取 `querySelector` 只是靠文档顺序碰巧对了，所以代码改为挑**最宽的、有内容的**那个。

### 4. 读中心列拿到的是输入框，不是对话

第一个能跑的版本把占位文字「发消息或创建任务…」和模型名当成消息返回了，因为 `_centerCol` 包含了 header 和输入框。

### 5. 一个消息块有好几个子节点，所以「只取叶子」把每条消息都排除了

`children.length > 3` 本意是避免重复，结果它过滤掉了所有真消息、只留下小控件。正确的规则是：
**仅当一个块包含另一个我们本来也会访问的块时**才跳过它。

### 6. `textContent`、`execCommand('insertText')` 和合成事件在这里全部失效

DOM 接受了文字，发送却什么都没做，因为框架从未见到受信任的输入。`page.fillText` —— 桥接层自己的实现，也就是
`opencli browser fill` 用的那个 —— 有效；而脚本化写入时输入框持有了文字，发送却从不触发。

### 7. 不要等「忙」标志

停止控件只在 token 流式输出时出现，所以模型启动慢看起来就像空闲。`settled` 在一条早已送达并已回答的消息上返回了
`false`。等**对话增长**才是直接证据；忙标志现在只用于让回答结束，有界且尽力而为。

### 8. `fillText` 只在**已聚焦**的输入框上有效

它不带错误地返回，`send` 报告 `sent: true` —— 而那条消息从没被打进去。输入框是空的，发送按钮保持禁用，对话从不增长。实测：

```
click-ok | fill-ok | value="PROBE-AFTER-FOCUS"     ← 先 page.click 之后
```

`writeComposer` 现在会先点击输入框并停顿，再填入。

### 9. `fillText` **不替换**已有文本

当输入框里已经有内容时，新文字根本不会被写入：旧内容留着，发送按钮为**旧文字**保持可用，于是同一个测试里第二次
`send` 会静默重发第一条消息 —— 对话照样增长，测试照样通过，而它衡量的是错的东西。这是最坏的一种失败形态。

```
before="PROBE-AFTER-FOCUS" | sel-all-ok | del-ok | afterClear="" | afterFill="CLEAR-TEST"
```

填入前先 `Control+a` 再 `Delete`，每步之后停顿 —— 没有这些停顿，按键会在聚焦生效之前到达，清空静默失败。

### 10. 回车**不发送**，而 `pressKey` 不会告诉你

`await page.pressKey('Enter')` 成功 resolve，而输入框保留着文字。`pressSend` 据此返回 `ok: true`，于是 `send` 报告
`sent: true, replied: false`，而人自然会得出「模型没回答」的结论。

修法是验证唯一可观察的证据 —— **输入框被清空了** —— 否则回退到点发送按钮：

```
按回车 -> 输入框仍有文字 -> 点按钮 -> 输入框空了
```

`send` 现在会报告 `composerAfter`，于是这个失败模式会自己说出来，而不是伪装成模型沉默。

### 11. 对话读取器把状态条、表格和工具摘要当成消息

返回的条目变成每个表格单元格一条（「快照层」/「行号、计数、SHA1」）、每行终端代码一条，外加模型选择器、token 计数器
和折叠的工具记录（「执行了命令思考…运行命令…思考…」）。于是 `--contains` 断言会因为与对话无关的原因通过或失败。

`_flowItem` **同时**用于消息正文和单行状态条，所以靠位置无法区分。读取器现在：

- 在 `_viewArea` 下**按测量**定位容器（拥有最多「有文字的直接子节点」的那个元素），**绝不**用 `div[class*="_root"]` ——
  页面上第一个 `_root` 是**侧边栏**，读它会返回「新会话 | 插件 | 自动化任务 | 协作群」
- 剔除状态条（「已完成，用时 18秒」）、用量行（「用量 254K tok」）、入站任务通知、模型选择器，以及过程记录。
  最后这一类必须同时匹配「执行了命令」与「思考」或「运行命令」：那些块长达数百字符，早先的长度上限让它们全部漏了过来

---

## 编辑这些文件时的规矩

**绝不要在 `page.evaluate` 模板字符串内部的注释里写反引号。** 那段脚本是模板字面量；注释里的一个反引号会提前闭合它，
模块以 `missing ) after argument list` 失败 —— 而报错指向的是错误的行。写这个 adapter 的过程里，这件事发生了**三次**。

**每个等待都必须有界。** 无界的等待会把一个坏选择器变成挂起的测试，那比失败更糟，因为没人看得见。

**以语义为键，不要用哈希后的 class。** `_scrollBody` 是按 class **后缀**匹配的，所以重建改了哈希也不会静默弄坏选择器。

**改完要重启 daemon。** `opencli daemon restart` —— adapter 模块只加载一次。
