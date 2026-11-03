# dsh-a2a 左侧「协作群」面板（浏览器半边）

`client.js` 是 `dsh-a2a` 的 **Web 客户端插件**产物（DSH GUI 的左侧栏入口 + 中央面板页）。首版 **只读**。

- 交付：`client.js`、`lib/types/client.d.ts`、`test/client-syntax.test.mjs`
- 契约来源：`docs/CONTRACT.md` §2.8
- 验收：`node --check client.js` 与 `node --test test/client-syntax.test.mjs`

---

## 1. 从已装插件产物里查到的三个硬事实（照抄这些才有用）

以下不是推测，是逐字节读 `@deepseek-ai/dsh` 发货产物得到的。三处证据都写明文件与位置，改动前先回去核对。

### 事实一：装载机制 = 「脚本先注册工厂，浏览器按需 materialize」

`node_modules/@deepseek-ai/dsh-client-ui-goal/lib/client.js` 第 1 行起：

```js
window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-client-ui-goal",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react_jsx_runtime = require("react/jsx-runtime");
    let react = require("react");
    let _dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
```

机制说明在 `@deepseek-ai/dsh-client-modules/lib/index.js` 的 `manifest.js` 段注释里，原文：

> Lazy CJS model: executing a plugin bundle only **REGISTERS** its factory (`window.__ModuleLoader__.load({id, factory})`); every module body side effect — including CSS injection — lives inside the factory closure and runs at **materialization**, not at script execution.

所以：

- **文件里不能有 `import` / `export`**——它是 `<script>` 语法的脚本，不是 ESM 模块。
- `id` 用包名（`@deepseek-ai/...`），对本插件就是 `dsh-a2a`（= `package.json` 的 `name`）。
- 工厂返回的是 `module.exports`，导出 `apply` + `inject`（Cordis 插件对象形状）。见 `dsh-cordis-client-runner/lib/client.js` 的 `guardedSurface()`：`typeof plugin === 'function'` 走函数形状，否则 `{ ...plugin, apply: (ctx, config) => plugin.apply(...) }`——**本项目用对象形状**，因为有 `inject` 声明。

### 事实二：可用共享模块只有 `OZ()` 那 11 个

`@deepseek-ai/dsh-web-frontend/dist/assets/index-BXV-oxvX.js`（约 941KB）里 `function OZ()` 返回的静态模块表就是全部：

```js
{ react, "react/jsx-runtime", "react-dom", "react-dom/client",
  "@deepseek-ai/cordis", zod, "@tanstack/react-virtual",
  "@deepseek-ai/dsh-client-store", "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-primitives", "@deepseek-ai/dsh-client-ui-dockkit" }
```

**没有 `@deepseek-ai/dsh-api-remotes`、没有 business service**。那些只能通过 `ctx.<service>` 拿（走 `inject`）。

⚠️ 有个反直觉的坑：`dsh-client-ui-primitives` 在磁盘上**没有** `lib/index.js`（只有 `dist` 内的打包形式被 `TU` 注入），所以本仓库**不能**在 Node 侧 `import` 它；浏览器侧 `require` 是安全的。

因为共享模块表可能随版本漂移，`client.js` 对 primitives 做了 `try/catch` + 逐项 feature-detect：拿不到就退回内联 SVG，**不会因为版本不一致白屏**。

### 事实三：左侧栏挂载点 = `sidebar.panellist`（不是自己画左侧栏）

`@deepseek-ai/dsh-client-ui-sidebar/lib/client.js` 里 `apply()` 结尾注册了 `sidebar` 槽并声明子槽：

```js
ctx.slots.register({ name: "sidebar", locale: NS, children: {
  "sidebar.brand.mark": { kind: "single", scope: "root" },
  "sidebar.panellist":  { kind: "list",   scope: "root" },   // ← 左侧栏入口列表
  "sidebar.panellist.actions": { kind: "list", scope: "root" },
  ...
}}, SidebarRoot)
```

`SidebarRoot` 渲染每个入口时调用 `renderSlot("sidebar.panellist", { size: wide ? 16 : 18, active }, { only: id })`——**只有 glyph**，宽度 16/18px。旁边那个 `label` 是标题文本，来自 `syncPanels()` 里 `resolveSlotLabel(options.label)`。

现成的「注册一个左侧栏页面」范本在 `@deepseek-ai/dsh-client-ui-schedule/lib/client.js`：

```js
const PANEL_ID = "schedules";
ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
  name: "sidebar.panellist", id: PANEL_ID, order: 10, locale: MANAGER_NS, label: () => t("panel")
}, TaskManagerIcon));
ctx.slots.inject("main", () => ctx.slots.register({
  name: "main", key: PANEL_ID, locale: MANAGER_NS, inject: () => ({...})
}, TaskManagerPage));
```

**`sidebar.panellist.id` 必须等于 `main.key`**：`dsh-client-ui-layout/lib/client.js` 的 `LayoutController.selectPanel()` 会校验

```js
selectPanel(panelId) {
  if (panelId !== null && !this.hasMainPanel(panelId))
    throw new Error(`layout.selectPanel: main panel "${panelId}" is not registered`);
  ...
}
```

`hasMainPanel` 查的是 `ctx.slots.entries("main")` 里的 `options.key`；`MainPanel` 渲染时用 `usePanelInfo(info => info.activePanelId) ?? "conversation"` 作为 `entryKey`。所以两个 id 对不上 = 点击左侧栏直接报错。

本插件取 `a2a-groups`，`order: 40`（schedule 占 10）。

---

## 2. 当前实现

| 项 | 值 |
|---|---|
| 注册的槽 | `sidebar.panellist`（glyph + 未读角标）、`main`（群面板页） |
| `inject` | `["slots"]`（唯一硬依赖） |
| 面板 id | `a2a-groups`（左侧栏 `id` 与 `main` `key` 相同） |
| 样式 | 全内联 `style` 对象，无 CSS 文件、无构建产物 |
| 数据 | 只读，见 §3 |
| 空数据 | 显示「还没有加入任何群」，不抛错 |

导出面（`exports`）：

```js
apply(ctx)                  // Cordis 客户端插件体
inject = ["slots"]
GroupsPanel                 // 中央面板页组件
GroupsSidebarIcon           // 左侧栏 glyph 组件
GroupCard / EmptyState      // 供测试与复用
setDataSource(source)       // ← Host 集成接缝（见 §4）
readSnapshot(raw)           // 任何脏数据 → 安全快照
currentSnapshot()           // 读当前 Host 数据并归一化
subscribeGroups(fn)         // 订阅推送，永远返回 disposer
formatTime(ms)              // 「刚刚 / 3 分钟前 / 昨天 14:05」
PANEL_ID / GLOBAL_KEY / CHANGE_EVENT
```

---

## 3. 数据形状（Host 必须注入的东西）

面板**从不**自己连 A2A、不发请求。它只读一个快照。所有字段都**宽松**：别名、数字字符串、秒级时间戳、ISO 字符串都会被接受；缺失/类型错误一律退化成空，不抛错。

> **已和 `lib/groups.js`（分支 C）对齐**：字段名直接认 `publicGroup()` / `snapshot()` / `publicEntry()` / `publicMember()` 的原样输出，**Host 不需要写转换层**。对应关系：`groupId → id`、`feedTail → feed`、`lastPost → lastMessage`、`lastPostAt → lastTime`、`from.displayName → senderName`、`msgId → id`、`at → time`、`displayName → name`。`test/client-syntax.test.mjs` 里有一条测试用**逐字段照抄 `groups.js` 的 fixture** 守着这个契约，分支 C 改形状会先在这里炸。

### 3.1 顶层

```js
// 三种容器都接受
[ group, group, ... ]                    // 裸数组（= groups.list() 的输出）
{ groups: [ ... ] }                      // 推荐
{ items: [ ... ] }                       // 别名
{ groups: [...], updatedAt: 1767000000000 }  // updatedAt 可选
```

### 3.2 群

```js
{
  id: "g-1",                  // 别名：groupId（groups.js）/ group
  name: "内网部署协作群",      // 别名：title / label
  topic: "证书轮换与灰度",     // 别名：description；作卡片 tooltip
  memberCount: 3,             // 别名：membersCount / memberTotal；缺省 = members.length
  unreadCount: 5,             // 别名：unread / unreadTotal
  muted: false,               // 可选，muted / mute
  lastMessage: { … },         // 别名：lastPost（groups.js）/ last；缺省 = feed 最后一条
  members: [ … ],             // 别名：memberList / roster
  feed: [ … ]                 // 别名：feedTail（groups.js）/ messages
}
```

### 3.3 成员

```js
{ id: "m-1", name: "我", role: "owner", online: true, self: true }
// id 别名：memberId（groups.js）/ sessionId / key
// name 别名：displayName（groups.js）/ title / label
// online：groups.js publicMember 的 online 字段，可选
// self 别名：isSelf；渲染成「名字（我）」
```

### 3.4 feed 条目（`lastMessage` 同构）

```js
{
  id: "e-2",                  // 别名：messageId / msgId；缺省按 seq 生成
  seq: 2,                     // 单调序号，用于同时刻排序
  text: "收到，我这边回归",     // 别名：body / summary / message / content / preview
  senderName: "小美",          // 别名：sender / from / author / name
  time: 1767000000000,        // 毫秒；也接受秒级数字、ISO 字符串、Date
  kind: "chat"                // 可选
}
```

归一化后的行为（`readSnapshot`）：

- `feed` 按 `time` 升序排序，**只保留最新 20 条**（正好等于 `groups.js` 的 `FEED_TAIL_LIMIT`）；
- 没有 `lastMessage` 时用 feed 最后一条；只有 `lastPostAt` 而没有 `lastPost` 时**不会**凭空造一条消息（`groups.js` 在无凭证时就是这样：有计数、无 feed）；
- `memberCount` 优先用宿主给的数（`publicGroup` 给的是权威值），没有再回退成 `members.length`；
- `unreadTotal` = 各群未读之和（左侧栏角标用它）；
- 任何异常 → 返回 `{ groups: [], updatedAt: 0, unreadTotal: 0, ok: false }`。

> ⚠️ `groups.js` 的 `snapshot()` **本身不带未读数**（未读是消费侧的游标概念）。Host 若要在面板上显示角标，需要在 `remote.a2a.groups()` 里按会话的 `lastReadSeq` 跟 `lastSeq` 算出 `unreadCount` 一起返回；不返回就是 0，面板只是不显示角标，不会报错。

### 3.5 快照里的时间语义

`time` / `updatedAt` / `lastTime` 一律 **epoch 毫秒**。传入秒级或 ISO 字符串会被转换；`0` 表示未知，此时界面不显示时间而不是显示 1970。

---

## 4. Host 怎么注入（三档，任选其一，优先级从高到低）

### 档位 A（推荐，真正的接法）：`setDataSource`

Host 侧拿到 `client.js` 导出的对象后调用：

```js
// 在 lib/index.js 里（浏览器侧那段装配代码）
client.setDataSource({
  read: () => ctx.remote.a2a.groups(sessionId),   // 返回上面 §3 的形状
  subscribe: (listener) => ctx.remote.$on("a2a/groups-changed", listener),
});
```

- `read()` 会在每次渲染与 2s 轮询时被调用，必须廉价、可重入、**不要抛**（抛了也只会 `console.warn` 一次然后走空态）。
- `subscribe` 可选；返回的 disposer 会在组件卸载时调用。
- 传 `null` 即断开，面板回到空态。

### 档位 B（零改动，Host 只注全局）：`window.__DSH_A2A_GROUPS__`

Host 把快照直接挂到全局，面板自己读：

```js
window.__DSH_A2A_GROUPS__ = { updatedAt: Date.now(), groups: [ … ] };
```

- 面板每 2 秒按「签名」比对一次，只在真的变化时重渲染；
- 想让界面**立刻**刷新，dispatch 一个事件即可：

```js
window.dispatchEvent(new Event("dsh-a2a:groups-changed"));
```

- 也支持 `window.__DSH_A2A_GROUPS__.subscribe(listener)`（返回 disposer），Host 若有推送通道可走这条，避免轮询。

### 档位 C：什么都不做

数据缺失 → 显示「还没有加入任何群」，控制台无报错。

> 三个字面量都以 `exports` 暴露（`GLOBAL_KEY` / `CHANGE_EVENT` / `PANEL_ID`），Host 请直接读导出值，**不要手抄字符串**——这份代码里出现过零宽字符污染字面量的坑，`test/client-syntax.test.mjs` 有专门断言守着。

---

## 5. 后续如何换成 `ctx.remote` 真实数据

首版是「全局/接缝注入」，第二步才是「面板自己订阅 Remote」。切换时**只动 `client.js` 的 `apply()` 和一个新 region**，组件层不用改：

1. **`inject` 加服务名**。Cordis 客户端插件用 `inject: [...names]` 声明，未声明的服务读取会被 `dsh-cordis-client-runner` 的 `dynamicCordisContext` 直接拒绝并报错（见其 `denyRead()`）。所以：

   ```js
   const inject = ["slots", "remote"];           // 需要哪就加哪
   ```

   注意：声明后若 Host 没提供该服务，fiber 会**停在等待态**，整个插件不激活。所以要么确定 Host 一定注册 `remote.a2a`，要么保持两段式（先 `["slots"]`，Host 就绪后再升级）。

2. **在 `apply()` 里把 Remote 包成档位 A 的 data source**：

   ```js
   function apply(ctx) {
     // …注册槽（不变）…
     if (typeof ctx.get === "function") {
       const remote = ctx.get("remote");         // 未声明时返回 undefined，安全
       const a2a = remote && remote.a2a;
       if (a2a && typeof a2a.groups === "function") {
         setDataSource({
           read: () => a2a.groups(sessionId),
           subscribe: (fn) => ctx.remote.$on("a2a/groups-changed", fn),
         });
       }
     }
   }
   ```

   `ctx.get(name)` 是**不需要 inject 声明**的探测路径（`dynamicCordisContext` 里 `prop === "get"` 走 `readService(name, false)`），适合「有就用、没有就降级」。

3. **Host 侧注册 Remote 只读视图**（`lib/index.js`，Lead 负责）：把 `groups.snapshot()` 之类的纯读操作暴露成 `remote.a2a`，**不要**暴露发帖。发帖继续走会话里的工具（`a2a_group_send`）。

4. 换完之后 §4 的档位 B 可以保留作为兜底，也可以删掉——两者互不冲突（A 优先，A 返回 `undefined` 时自动回落 B）。

---

## 6. 首版边界（明确不做的事）

- **只读**：不做发帖、加入、退群、静音。这些走会话内的模型工具（`a2a_group_send` / `a2a_group_join` / `a2a_group_leave`）。展开群卡片时会显示一行「只读视图：发消息请在会话里让助手用 `a2a_group_send`」。
- **不直连 A2A**：面板不发 HTTP、不读 token、不做流式。
- **不做未读已读回写**：`unreadCount` 只是展示，清未读要等 Host 给写接口。
- **不做本地化框架**：文案直接中文字面量，没接 `ctx.locale`（首版目标是把面板跑起来；后续接 locale 只需把字面量换成 `t()`）。
- **无 CSS 文件**：全部内联 style，避免多一个构建产物和一条 `/plugins/<id>/client.css` 路由。

---

## 7. 验收与自检

```bash
node --check client.js
node --test test/client-syntax.test.mjs
```

测试用 `node:vm` 造了假的 `window.__ModuleLoader__` 与假 `require`（只提供 `OZ()` 那 11 个模块里的两个），跑完 factory 后断言：

- 注册了 `id === 'dsh-a2a'`，且 `id` 是纯 ASCII 无零宽字符；
- **源码里没有 `import`/`export`/裸 `require`**；
- factory 只 require 种子表里的模块，且 specifier 无零宽字符；
- `apply()` 在 `undefined` / `null` / `{}` / `{slots:{}}` / register 抛错 / inject 抛错 六种情况下都不抛；
- 无数据渲染出「还没有加入任何群」，且挂载副作用（订阅 + 轮询）的 cleanup 可安全调用；
- 12 种脏数据（`null`、`"not json"`、`42`、`{groups:null}`、`[null,1,"x"]`…）都不抛、都退化成空；
- 真实数据能渲染出群名 / 成员数 / 未读角标 / 最近消息；
- 展开卡片能看到成员与 feed、`self` 标「（我）」、有只读提示；
- 数据源优先级：`setDataSource` > 全局 > 空态；`setDataSource(null)` 能恢复空态；
- `read()` 抛错时只 warn 不炸；`subscribe` 抛错时 disposer 仍可用；
- 别名/秒级时间戳/ISO 字符串归一化正确；feed 升序且截断到 20 条；
- **用逐字段照抄 `lib/groups.js` `snapshot()` 的 fixture 断言** `groupId`/`feedTail`/`lastPost`/`from.displayName`/`msgId`/`at`/`displayName` 都能被认出（分支 C 改形状会先在这里炸）；
- 「有计数无 feed」的摘要（`groups.js` 无凭证时的输出）不抛错、不显示假消息；
- 所有元素无 `className`（证明没用 CSS 文件）。

辅助脚本（不在验收路径里，改了 `client.js` 后可跑）：

```bash
node scripts/strip-invisible.mjs client.js        # 清零宽字符并打印关键字面量的码点
node scripts/sync-client-literals.mjs             # 把 client.d.ts 里的三个字面量对齐 client.js
```

---

## 8. 还差什么才能真的显示在 GUI 里（给 Lead 的集成清单）

`client.js` 本身已经能跑，但**现在装进 profile 也不会出现**，因为缺下面这些。按顺序做完即可：

1. **`package.json` 加客户端声明**（当前没有，Lead 的写域）：

   ```json
   "exports": { "./client": { "types": "./lib/types/client.d.ts", "default": "./client.js" } },
   "dsh": {
     "bundle": { "patch": "./cordis.patch.yml" },
     "client": { "platform": "web", "inject": ["slots"] }
   },
   "files": ["lib", "client.js", "cordis.patch.yml", "README.md", "README-ui.md"]
   ```

   字段校验在 `dsh-client-modules/lib/index.js` 的 `parseDshClient()`：`platform` 必填字符串，`inject`/`external` 必须是字符串数组，`immediately` 必须是布尔；`exports["./client"]` 必须是字符串或 `{default: string}`（`clientExportOf()`）。写成别的形状会**在加载期直接抛**。

2. **Host 半边导出 `remote.a2a` 只读视图**（`lib/index.js`）：`groups()` 返回 §3 的形状；有变化就 `ctx.remote.$emit("a2a/groups-changed")`。没有这一步，面板只能靠 §4 档位 B 的全局注入显示。

3. **把 `setDataSource` 接起来**：`client.js` 的导出对象在浏览器里由 loader 持有，Host 侧插件（同一 profile 的 host 半边）需要拿到它并调用 `setDataSource({read, subscribe})`。若拿不到（cordis 客户端插件之间不共享导出），就走档位 B：host 定期把 `groups()` 的结果写进 `window.__DSH_A2A_GROUPS__` 再 dispatch `dsh-a2a:groups-changed`。

4. **装进 profile 并重启**：`dsh.client` 声明与 bundle patch 只在**进程启动时**读取（同 memory 里那条结论），改完必须重启实例；然后刷新页面。加载失败看浏览器 console 的 `[dsh-a2a]` 前缀 warn。

5. **确认 `sidebar.panellist` 与 `main` 两个槽都已被声明**：它们由 `dsh-client-ui-sidebar` 与 `dsh-client-ui-layout` 注册。若目标 profile 关了这两个插件，`slots.inject()` 会一直等待（不报错、不显示）——届时面板静默不出现，需要检查这两个内置插件是否启用。

6. **（可选）locale**：想要中英切换，把 `label: "协作群"` 与文案换成 `ctx.locale.register(...)` + `t()`，形状照 `dsh-client-ui-schedule` 的 `MANAGER_NS` 写法。
