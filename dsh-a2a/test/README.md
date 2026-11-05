# 测试说明

> 50 个文件，674 个测试。分两层：**快层 0.8 秒**，全量 **3.2 秒**。
>
> **改 UI 相关代码时，光跑这些测试不够** —— 见「一·五、UI 相关改动：必须用浏览器实操验证」。

---

## 一、怎么跑

| 命令 | 跑什么 | 耗时 | 什么时候用 |
|---|---|---|---|
| `npm test` | 快层（20 文件 / 243 测试） | **0.8s** | 每次保存后 |
| `npm run test:all` | 全量（48 文件 / 637 测试） | **3.6s** | 提交前 |
| `npm run test:watch` | 快层，监视模式 | — | 开发中 |
| `npm run test:coverage` | 全量 + 覆盖率门槛 | ~20s | 发版前 |

**CI 跑的是 `test:all`。** 只跑快层会让慢层的回归漏到 tag 上。

---

## 一·五、UI 相关改动：必须用浏览器实操验证

**单元测试和集成测试看不到「用户点了之后会发生什么」。** 这不是补充手段，是**唯一能发现某类 bug 的方法**。

### 为什么必须这样

本项目真实发生过的例子：

| 现象 | 测试状态 | 真正的原因 |
|---|---|---|
| 接手按钮填了提示词，执行失败 | 全部绿 | 填的句子后端不接受（缺 token），**没人执行过它** |
| 点两次按钮，输入框里两句话 | 全部绿 | `fillDraft` 是插入不是替换，**没人点过两次** |
| 面板永远不刷新 | 全部绿 | 轮询返回 `ok:true` 但数据不是数组，**没人看过轮询的返回体** |
| 面板空白 | 650 个测试全绿 | `versionMismatch` 用在了声明之前，**只有打开页面才会崩** |

**共同点**：每一层都「对」，中间那条路是断的。读代码、跑测试都发现不了。

### 怎么做

用 **opencli** 驱动真实浏览器，像真人一样点击，同时观察网络与页面状态。

```bash
# 1. 绑定/打开目标实例（一个会话只开一个，用完关掉，别留空白页）
opencli browser <session> open http://127.0.0.1:3096/

# 2. 先看有哪些可点的东西——不要猜选择器
opencli browser <session> state
opencli browser <session> extract        # 页面文本，用来抓基线

# 3. 点击
opencli browser <session> eval "<单行表达式>"
#    或  opencli browser <session> click <index>

# 4. 立刻读回结果，做前后对比
opencli browser <session> extract
opencli browser <session> network        # 网络请求
opencli browser <session> console        # 控制台错误
opencli browser <session> screenshot out.png
```

### 三条硬性要求

**1. 点击前先抓基线**

```bash
opencli browser <s> extract > before.txt      # 页面文本
opencli browser <s> eval "JSON.stringify(window.__myState)"   # 内部状态
```

点击后再抓一次，**对比差异**。没有基线就无法判断「变了没有」。

**2. 埋点，不要猜**

当页面行为不符合预期时，**在客户端代码里写一行可观测的值**，而不是分析代码：

```js
// 例：确认轮询真的在跑、返回体到底是什么形状
const trace = window.__pollTrace = window.__pollTrace ?? { calls: 0 };
trace.calls += 1;
trace.groupsIsArray = Array.isArray(result?.value?.groups);
trace.groupsType = typeof result?.value?.groups;
```

然后从页面读回来：

```bash
opencli browser <s> eval "JSON.stringify(window.__pollTrace)"
# → {"calls":30,"lastOk":true,"groupsIsArray":false}     ← 一句话说明全部
```

**这个 bug 靠读代码查了三轮都没找到，埋点一次就定位了。**

埋点用完**必须删掉**再提交。

**3. 不要反复刷新页面**

- 刷新会丢掉用户准备好的状态，也丢掉你刚建立的基线
- 需要干净页面时，**先在对话里说明再开**
- 一个测试会话用一个浏览器 session，用完 `close`

### 什么时候必须做浏览器验证

| 判定 | 例子 |
|---|---|
| 改了 `client.js` 的任何渲染逻辑 | 面板、按钮、标签 |
| 改了面板 ↔ Host 的 RPC 端点 | 返回值形状、错误处理 |
| 加了新的用户可见交互 | 按钮、对话框、跳转 |
| 修的是「用户报的界面问题」 | **无条件**——用户看到的现象就是唯一判据 |

**不需要**的场合：纯 core 逻辑（用慢层测试更快更可靠）。

---

## 二、两层怎么分

看**文件后缀**，不看目录：

```
*.test.mjs         快   纯内存：不监听端口、不写磁盘、不起子进程
*.test.slow.mjs    慢   真实 HTTP 监听 / 真实文件写入 / 子进程
```

### 为什么按速度分，而不按模块分

因为**速度和模块层级不相关**：

| 文件 | 看起来像 | 实际耗时 | 原因 |
|---|---|---|---|
| `memberships-ledger` | 单元测试 | **2.7s** | 每个测试写真实文件 |
| `client-syntax` | 集成测试 | **几毫秒** | 只读源码文本 |

按 `lib/` 的目录结构分，这两个会分错层，快层就失去意义了。

**另一个理由**：这些测试**本来就跨模块**。

```
reply-to.test.mjs   →  store + skill + tool-runtime + tool-specs   四个模块
leave.test.mjs      →  tool-runtime + memberships + config
```

放进 `test/core/` 会暗示「这是 groups.js 的单元测试」，而它不是。

---

## 三、回归测试

### 什么是回归测试

**每个 bug 修复后补的测试**，目的是「这个问题不能再回来」。

行业约定（Google Testing Blog / Kent Beck）：

| 约定 | 说明 |
|---|---|
| **永不删除** | 即使功能重构了，测试也要活下来 |
| **注释写根因** | 不是「测试 X」，而是「X 曾经坏了，因为 Y」 |
| **变红要优先处理** | 它红了 = 老问题回来了，不是「测试过时了」 |

### 我们的回归测试清单

| 文件 | 防的是什么 |
|---|---|
| `presence-ownership.test.slow.mjs` | 在线状态 2 分钟后错误显示离线（心跳绑在订阅上） |
| `presence.test.slow.mjs` | 缓存里存 `online` 布尔值，导致 3 个人看到 3 种结果 |
| `inbox-membership.test.slow.mjs` | 收件箱只读第一个群，另一个群的邀请永远看不到 |
| `read-from-shape.test.slow.mjs` | 远程群读历史全部失败（`from` 是对象不是字符串） |
| `groups-member-count.test.mjs` | 远程群显示「0 人」 |
| `panel-write.test.mjs` | 保存失败但数据已写入（`saved is not defined`） |
| `panel-health-flags.test.mjs` | 两个警告字段被 mapper 丢弃，永远不显示 |
| `wake-policy.test.slow.mjs` | 群聊风暴（没 @ 任何人的消息也唤醒所有人） |
| `feed-field-parity.test.mjs` | 字段被白名单 mapper 丢弃（**出现 5 次**） |
| `reaping.test.slow.mjs` | 一次误判就永久删除成员凭证 |
| `reply-to.test.slow.mjs` | 回复没有 @ 原提问者，对方永远不知道 |
| `panel-refresh.test.mjs` | **轮询每次「成功」却什么都没写**（端点返回整个快照而非数组，客户端拒绝后静默返回） |
| `identity-adoption.test.slow.mjs` | 接手时 skill 层丢掉 `personKey`；旧会话记录不清理，导致每个会话都显示已加入 |

### 新增回归测试的写法

```js
/**
 * REGRESSION: <现象，一句话>
 *
 * ROOT CAUSE: <为什么会坏>
 *
 * FIXED IN: <commit 或版本>
 */
test('...', () => { ... });
```

**为什么要写根因**：三个月后看到这个测试，只知道「它在测某功能」是没用的。写清「它曾经怎么坏」，才能判断重构后它还该不该通过。

---

## 四、一个反复出现的 bug 模式

`feed-field-parity.test.mjs` 值得单独说，因为**同一个 bug 出现了 5 次**：

```
字段写入了记录 → 经过 publicEntry → 经过 skill 层 → 经过 tool-runtime → 经过面板
                  ↑ 每次都是白名单重建，新字段没加进列表
结果：值为 undefined，读起来像「不适用」
```

**行为测试抓不到这类 bug**——它必须知道该查哪个字段，而问题恰恰是**没人记得住要加字段**。

所以 `feed-field-parity` 是**结构性测试**：它从 `publicEntry` 推导出字段集合，断言每个 mapper 都转发了全部字段。

> **需要加字段时，这个测试会直接变红，告诉你漏了哪一层。**

---

## 五、覆盖率门槛

`npm run test:coverage` 分两级：

| 级别 | 行 | 分支 |
|---|---|---|
| **核心不变量**（groups/bridge/invite/memberships/wire/server） | 85% | 75% |
| **其余** | 80% | 60% |

### 为什么分级

整体数字被 `tool-runtime.js`（27 个工具 × 约 8 个分支）主导。追平全局 75% 分支意味着测「tags 传字符串会怎样」这类**几乎不保护任何东西**的分支。

真正需要分支覆盖的是**持有不变量的模块**——那里漏一个分支，就是一条规则没被守住。

### 两个文件不计入覆盖率

| 文件 | 原因 |
|---|---|
| `lib/index.js` | 插件装配。测试它等于断言「代码是按现在这样写的」 |
| `lib/shared/tool-specs.js` | 声明表。正确性已由「每个名字都有 handler」直接断言 |

**排除项明确写在 `scripts/coverage.mjs` 里**，不是悄悄缩小 glob。

---

## 六、在 VS Code 里

已配置 `.vscode/settings.json`，装 **Vitest** 扩展（`vitest.explorer`）后：

- 左侧烧杯图标 → 48 个文件、637 个测试
- 每个测试可单独跑 / 调试
- 失败的测试会标红并显示断言差异

**快慢两层都会显示**，靠文件名区分。
