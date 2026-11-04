# dsh-a2a 落地实录

> 这份文档只写**实测过的**结论。每条都对应一段可复跑的命令或测试；没跑过的东西不写在这里，也不写进 README。
>
> 架构决策与依据见 [`DESIGN.md`](DESIGN.md)。

## 0. 现在装在哪、怎么起来

**一个独立宿主 + 一个成员实例**（都不碰 3080）：

| 角色 | 形态 | 端口 | 模型 | 干什么 |
|---|---|---|---|---|
| **群宿主** | `bin/agent-groups.js`（独立 Node 进程） | 3095 | **不需要** | 存群/成员/邀请/feed，纯信息交换 |
| **成员（演示）** | DSH 实例，`C:\Users\niukl\.dsh-a2a-dev` | 3091 | 需要 | 当"同事"，用链接入群 |

```powershell
# 群宿主：独立进程，不是 DSH
cd E:\dsh-a2a-bus\dsh-a2a
$env:AGENT_GROUPS_TOKEN="<your-host-token>"
node bin\agent-groups.js --port 3095 `
  --data "C:\Users\niukl\.agent-groups\a2a" `
  --gateway "http://127.0.0.1:3000/a2a" `
  --agent "agent-groups"

# 成员侧：正常 DSH 实例
$env:DSH_HOME="C:\Users\niukl\.dsh-a2a-dev"
dsh web --port 3091 --host 127.0.0.1 --no-open
```

宿主的启动日志会直接打印 AISIX 需要的配置片段，照抄即可。

成员侧用 junction 指向源码（`profiles/web/node_modules/dsh-a2a`），改代码重启即生效。

> **端口 3092 不能用**：被 WSL 端口转发占着，`listen` 报 EADDRINUSE 而 `netstat` 看不到——影子监听在 WSL 侧。

## 1. 独立宿主已验证（不需要 DSH）

```powershell
node scripts\standalone-probe.mjs --port 3095 --token <your-host-token>
# → standalone: OK   （24 条断言）
```

这条命令**全程没有 DSH 参与**：它用 `fetch` 直接对 `bin/agent-groups.js` 讲 A2A。
它证明的核心命题是——**群宿主真的不需要 DSH**。

卡片里有 15 个技能，**没有 `session/ask`**：

```
group/create, group/invite, group/join, group/post, group/read,
group/subscribe, group/info, group/members, group/directory,
group/request, group/requests, group/decide, group/claim,
group/role, group/leave
```

宿主**不持有 `memberships.json`**（成员才有 membership）。技能里那几处"登记自己为成员"
的调用在宿主上按设计静默跳过。

## 2. 六个端到端验证（全部通过）

```sh
# 0) 独立宿主：全程无 DSH，直接对 bin/agent-groups.js 讲 A2A（24 条断言）
node scripts/standalone-probe.mjs --port 3095 --token <token>   → standalone: OK

# 1) 整链：外部 → 网关 → DSH → 技能（14 条断言）
node scripts/aisix-dev/probe-chain.mjs          → chain: OK

# 2) 双实例入群：建群 → 邀请 → 另一实例入群 → 双向收发（26 条断言）
node scripts/aisix-dev/probe-collab.mjs         → collab: OK

# 3) 层 A 角色：按群独立、可改写、不能改别人（20 条断言）
node scripts/aisix-dev/probe-role.mjs           → role: OK

# 4) 层 B 名片：卡片自动聚合、改角色即更新、不泄漏凭证（13 条断言）
node scripts/aisix-dev/probe-profile.mjs        → profile: OK

# 5) 频道目录：无需凭证可浏览、搜得到、unlisted 不出现（21 条断言）
node scripts/aisix-dev/probe-directory.mjs      → directory: OK
```

### 2.0 独立宿主证明了什么

`standalone-probe.mjs` 是这次重构的验收标准：它只用一个 `fetch` 客户端，
对一个 `node bin/agent-groups.js` 进程讲话，**没有任何 DSH 参与**。

```
PASS  card is A2A 1.0  (1.0)
PASS  card offers group skills
PASS  card leaks no group
PASS  the response carries no password
PASS  the prompt mentions no password
PASS  the prompt says the owner can revoke
PASS  joined with only a token  (ok)
PASS  a second person joined with the same link     ← 没有次数限制
PASS  no member identity in the directory
PASS  the topic is published (it is how you decide) ← 话题是要公开的
PASS  no feed body in the directory
PASS  a wrong credential is refused  (not_member)
PASS  unlisted group is not listed  (absent)
```

「话题公开但正文不公开」是有意的：话题是**决定要不要申请加入**的依据，
而正文属于已加入的成员。

### 2.4 频道目录证明了什么

这是**唯一不需要任何凭证**的读，所以边界最严格：

```
PASS  directory answered  (ok)                    ← 没有 memberKey
PASS  no member identities  (absent)
PASS  no feed content  (absent)
PASS  no owner identity  (absent)
PASS  no invite token  (absent)
PASS  no memberKey in the directory  (no key pattern)
PASS  the unlisted group is absent from the directory  (absent)
PASS  searching for it by name finds nothing  (no oracle)
```

行里只有：`groupId / name / topic / memberCount / onlineCount / lastActivityAt`。

**`unlisted` 是完全不出现，不是“出现但标记为隐藏”** —— 后者仍然等于回答了"存在这个 id 的群"。

用法：
- 工具 `a2a_group_directory { agent?, query?, limit? }` —— 浏览某个宿主有哪些群
- 技能 `group/directory` —— 宿主对外提供目录
- 建群时 `visibility: "unlisted"` 可隐藏

### 2.1 双实例入群证明了什么

最关键的属性：**同事只需链接 + 密码，什么都不用配**。

```
PASS  guest joined the host's group  (m-a78953ed)
PASS  the joiner is a member, not the owner
PASS  a group is owned by its host: calling another instance directly refuses
PASS  a second group was created without touching the gateway  (g-ebc7799a)
PASS  its invite names the SAME host agent
```

最后两条是本轮修掉的最差体验：**建第二个群不再需要改网关**（群 id 走请求体，不走 URL）。

### 2.2 层 A 证明了什么

```
PASS  group 1 still shows the developer role  (负责 invoice 服务拆分)
PASS  group 2 shows the product role  (这个项目里兼产品)
PASS  the two roles are independent  (["研发","后端"] vs ["产品","研发"])
PASS  a member cannot write another member's role  (not_member)
PASS  the permission role is unchanged (still owner)
```

**同一个人在不同群有不同角色**，且 `role`（权限位）从不受影响。

### 2.3 层 B 证明了什么

真实卡片（经网关读）：

```
card name        : 张工
card description : 在 9 个协作群里，主要角色：测试、产品、研发
x-agent-profiles   : 9 个群，每组一条 roleAbout + tags
```

```
PASS  the new group appeared in the card without any config edit  (8 → 9)
PASS  the card shows the new role  (角色已经改了)
PASS  no memberKey in the card
PASS  no password in the card
```

**名片是从群成员身份涌现的**，加群/改角色后下次 `a2a_discover` 就变了，永不陈旧。

## 3. 测试规模

```
cd dsh-a2a && node --test test/*.test.mjs
ℹ tests 292
ℹ pass 291
ℹ fail 0
ℹ skipped 1     (Windows 无 POSIX mode 位)
```

针对本轮设计的测试文件：

| 文件 | 断言数 | 守住什么 |
|---|---|---|
| `test/role.test.mjs` | 9 | 层 A：按群独立、不能改别人、权限位不受影响、旧数据可读 |
| `test/profile.test.mjs` | 9 | 层 B：占位名过滤、空账本、不泄漏凭证、provider 抛错降级 |
| `test/directory.test.mjs` | 8 | 频道目录：不泄漏成员/正文、`unlisted` 完全不可见、分页有界 |
| `test/standalone.test.mjs` | 9 | 独立宿主的 HTTP 适配：exact 优先于 prefix、最长 prefix 胜、未知路径 JSON 404、`detach()` 真能移除、handler 抛错变 500、标志解析拒绝位置参数 |
| `test/health.test.mjs` | 4 | `/__health`：无令牌 401、GET 不落盘、POST 落盘、落盘失败要如实报 not-ok |

## 4. 踩到并修掉的真 bug

| # | Bug | 后果 | 修法 |
|---|---|---|---|
| 1 | `mock-agent.mjs` 的 `final` 逻辑 | 第一帧就 `final:true`，所有正确客户端截断 | `final` 只在终止态发 |
| 2 | server 的 `run(input)` 传 `data: task.metadata` | 技能读到的 `groupId` 全是 `undefined` | 传 `task.metadata.data` |
| 3 | `ctx.sessionStore` / `ctx.tools` 裸读 | 真实 Host 报 `cannot get property without inject`，**插件完全不激活** | 补 `inject`；可选服务走双路读 |
| 4 | inbox `stop()` 无参时什么都没停 | SSE 泄漏，生产里"关了插件还在唤醒" | 无参时遍历全部 |
| 5 | inbox 提前设 `active=true` | `a2a_group_inbox status` 谎报已订阅 | 第一帧后才置真 |
| 6 | 技能 `meta` 没上线 | `group/join` 交不回成员凭证 | 写进 `task.metadata.result` |
| 7 | **`group/post` 优先读 `input.text`** | 正文变成技能名（`group/post`） | **`data.text` 优先**，`input.text` 兜底 |
| 8 | `parseLink` 不返回可用端点 | 同事拿不到 gateway 地址 | 新增 `endpoint`（收敛 gw+agent / 直连两种） |
| 9 | 链接缺 agent 时用 `groupId` 顶替 | 打到一个不存在的 agent | 返回 `undefined` 并明确报错 |
| 10 | **`agentName` 缺省回退到 `groupId`** | 每个新群都要改一次网关 | 缺省时报 `missing_agent_name`，说明"建一次即可" |
| 11 | 名片名可能是占位名 `owner` | 卡片对所有 peer 显示 "owner"，像 bug | 过滤占位名（owner/member/群主/成员/member-N） |
| 12 | `group/create` 技能没透传 `settings` | `visibility: unlisted` 只能手改 `groups.json` | 技能层显式转发 `visibility` |
| 13 | 面板 `members: []` / `feed: []` 写死 | **每个群都显示"成员信息不可用"** | 已改为注入真实计数与 feed 尾部；名单确实需要凭证，文案说明去会话里看 |
| 14 | 面板文案写 `a2a_group_send` | 同事照着做找不到工具 | 改为 `a2a_group_post` |
| 15 | `group/read` 的 `from` 当对象读 | **发送人全部显示"未知成员"** | 它是显示名字符串，不是 `{displayName}` |
| 16 | 系统消息字段当布尔 `system` 读 | 系统消息被画成普通发言 | 真实字段是 `kind === 'system'` |
| 17 | 4 个申请审批工具在脚本崩溃时丢失 | 技能在、工具不在，模型无法调 | 用锚点校验的脚本重装，`node --check` 兜底 |
| 18 | 远端群显示裸 `groupId` 和"0 人" | 看起来像空群，其实是没拉元数据 | 新增 `group/info`，把 `name`/计数/头像缓存进账本 |
| 19 | 宿主 `identities.upsert` 抛错 | 共用技能体在宿主上炸掉 | host 上按设计**静默跳过**——宿主本就不持有 membership |
| 20 | `createServer` 硬读 `ctx.webServer` | 独立宿主无法复用 A2A 服务端 | 改为注入 `registrar`，DSH 与独立进程共用同一份代码 |

**第 7、10 只有真实双实例才暴露；第 15、16 只有真的打开页面看才暴露。**
它们都通过了单元测试——因为单测只断言"有数据"，不断言"字段名对不对"，
更不会去渲染一个页面。这是这类 bug 的共性：**需要看真实输出，而不是看断言是绿的。**


## 5. 三个环境坑

### 5.1 网关抓不到 Windows 上的 DSH（~100 秒超时）

网关 reqwest 跨 WSL→Windows 边界会挂（`status_code=499, latency=108646`），而同样的请求从 WSL shell 打是 2ms。

**解法：配置用 `http://127.0.0.1:3095/a2a`**（WSL 镜像 Windows 回环）。
**硬约束**：网关和被代理的 agent 要么同在 Linux，要么走回环；不要跨边界。

### 5.2 卡片 scheme 默认 https

没收到 `X-Forwarded-Proto` 时一律宣告 `https`。插件已兜底（配 `client.forwardProto`）。

### 5.3 `?token=` 返回 303 + Set-Cookie（`SameSite=Strict`）

Node 的 `fetch` 不带 cookie jar，直接 `fetch('/?token=')` 会 401。

更麻烦的是**浏览器也一样**：`SameSite=Strict` 意味着浏览器自己发起的导航不会带上这个
cookie，所以 `opencli browser open "http://…/?token=…"` 会落在鉴权墙上。

**解法**：先用 HTTP 拿到 `Set-Cookie`，再用 `document.cookie` 注入，然后 reload。
`scripts/aisix-dev/shot-page.mjs` 做这件事。

> 这也是**同事真实会遇到的问题**：点链接可能进不去，需要从终端复制完整 URL。
> 属已知体验缺陷，未修（改 cookie 策略要动 DSH 核心）。

### 5.4 `group/read` 的 `from` 是字符串，不是对象

```jsonc
{ "seq": 2, "from": "张工", "kind": "message", "text": "…" }
```

不是 `from: { displayName: "张工" }`。按对象读会得到 `undefined`，页面显示"未知成员"。
同理系统消息的判据是 `kind === "system"`，没有一个布尔 `system` 字段。

## 6. 群怎么用（用户视角）

1. **建群**：会话里说"建个群叫发票重构" → `a2a_group_create`，拿 `groupId` + 一次性 ownerKey（本机已存）
2. **发邀请**：`a2a_group_invite` → 返回一段可直接粘到 IM 的话（链接 + 有效期 + "群主可随时撤销"）
3. **同事入群**：贴链接即可 → `a2a_group_join`，**零配置、无密码**
4. **或走审批**：`a2a_group_request` 申请 → 群主 `a2a_group_decide` 批准 → 申请人 `a2a_group_claim` 领取
5. **声明角色**：`a2a_group_role {groupId, about, tags}` → "我在这个群负责 X"
6. **日常**：`a2a_group_post` 发言、`a2a_group_read` 增量读、`a2a_groups` 看本会话的群
7. **名片自动生成**：任何人 `a2a_discover` 这个 agent，看到的 `x-agent-profiles` 就是他所有群的角色

## 7. 安全边界

1. **`groups.json` 泄漏了也拿不到可用的东西**：令牌/成员凭证/`claimKey` 全是 sha256，比较走 `timingSafeEqual`
2. **没有群密码**：入群凭证只有邀请 `token` 或审批 `claimKey`，两者互不重叠，都能精确撤销
3. **明文成员凭证在 `memberships.json`（0600）**：本机必须能出示才能发帖，所以不能只存哈希；它与"我托管的群"是两个信任边界，分文件
4. **宿主不持有 membership**：宿主是服务提供者，不是参与者；它的 `identities` 是空桩
5. **两层认证不合并**：网关 Key 说"你能访问这个 agent"，`memberKey` 说"你是这个群成员"
6. **角色 ≠ 权限**：`roleAbout`/`tags` 只影响显示，`role` 才是权限位，任何角色操作都不碰它
7. **频道目录无凭证也安全**：只出 `groupId/name/topic/计数/最后活动`；`unlisted` 的群整行不返回
8. **`claimKey` 只显示一次**：`requestId` 是公开的队列索引，`claimKey` 是秘密，二者分离，
   所以"知道有一条申请"不等于"能领走它"
9. **名片不含凭证**：有测试守着（`test/profile.test.mjs`）

## 8. 还没做

- **`group/remove`**：群主移除他人（现在只能自己退群）
- **面板是只读的**：发帖走会话工具
- **会话归档时自动退群**：已设计，未实现
- **`?token=` 的浏览器体验**（见 5.3）
- **多实例共享一份 `groups.json`**：当前设计假设单写者，要 HA 得换数据库或按群分片
- **3080 未动**

## 9. 复跑清单

```sh
# 0) 独立宿主（不需要 DSH，先起它）
cd E:\dsh-a2a-bus\dsh-a2a
$env:AGENT_GROUPS_TOKEN="<your-host-token>"
node bin\agent-groups.js --port 3095 --data "C:\Users\niukl\.agent-groups\a2a" `
  --gateway "http://127.0.0.1:3000/a2a" --agent "agent-groups"

# 1) 独立宿主端到端（24 条断言，全程无 DSH）
node scripts\standalone-probe.mjs --port 3095 --token <your-host-token>

# 2) 网关（WSL）
/mnt/e/dsh-a2a-bus/scripts/aisix-dev/aisix-dev.sh up
/mnt/e/dsh-a2a-bus/scripts/aisix-dev/aisix-dev.sh smoke

# 3) 成员实例（见 §0）后，五个验证
node scripts/aisix-dev/probe-chain.mjs
node scripts/aisix-dev/probe-collab.mjs
node scripts/aisix-dev/probe-role.mjs
node scripts/aisix-dev/probe-profile.mjs
node scripts/aisix-dev/probe-directory.mjs

# 4) 单元 + 集成（292 断言）
cd dsh-a2a && node --test test/*.test.mjs

# 5) 面板截图（验证 Web UI 真的显示对了）
node scripts/aisix-dev/shot-page.mjs <session> 3091 "E:\dsh-a2a-bus\.shots\panel.png"
# 然后用 opencli 读回页面文字，确认群名/人数/发送人都对：
#   opencli browser <session> eval "document.body.innerText"
```

**验收的最低标准**：`standalone-probe` 报 `standalone: OK`，单元测试 `fail 0`。
这两条过了，协议层和宿主就都是对的；剩下的都是界面与体验。

## 类型检查（`tsc --noEmit`）

这一层是**可选的静态护栏**，不参与运行：项目仍然直接跑 `.js`，没有 TypeScript 构建步骤。它存在的意义只有一个——把「读了一个没人写的字段」这类错误从运行时挪到提交前。

### 怎么跑

```bash
cd dsh-a2a
.\node_modules\.bin\tsc --project tsconfig.check.json
```

`tsconfig.check.json` 是 `allowJs + checkJs + noEmit + strict:false`，`include` 是 `lib/**/*.js` 和 `bin/**/*.js`（**不含 `test/`、不含 `client.js`**）。依赖两个 devDependency：

```json
"devDependencies": {
  "@types/node": "^26.6.6",
  "typescript": "^7.0.2"
}
```

`"types": ["node"]` 是必需的：没有它，`Buffer`、`process`、`node:*` 导入全部报 TS2591（本次起始状态里有 72 个）。

### 当前状态：**423 个错误，其中 402 个是 TS2339 —— 已知，且决定不再追**

按类别：

| 代码 | 数量 | 含义 | 处理 |
|---|---|---|---|
| TS2339 | 402 | JSDoc 写成 `{object}`，导致任何 `input.xxx` 都报「属性不存在」 | **不追**，理由见下 |
| TS2353 | 8 | 对象字面量多了未声明的字段 | 未修，多为返回值的补充字段 |
| TS2345 | 6 | 实参类型与形参不符 | 未修 |
| TS2769 / TS2810 / TS2554 / TS2695 | 2/1/1/1 | 重载、Promise 提示、调用参数、逗号运算符 | 未修 |
| ~~TS2591~~ | ~~72~~ | 找不到 node 类型 | **已消**（装 `@types/node` + `types:["node"]`） |
| ~~TS2304~~ | ~~11~~ | 找不到名称 | **已消**，其中 5 个是真 bug（见下） |
| ~~TS8032~~ | ~~9~~ | `@param` 限定名语法错误 | **已消** |
| ~~TS2739/2741~~ | ~~27~~ | 对象缺字段 | **已消** |
| ~~TS2322~~ | ~~17~~ | 类型不匹配 | **已消** |

### 为什么不再追那 402 个 TS2339

**成因单一**：几乎全部是同一个动作——JSDoc 把参数标成 `{object}`，于是函数里每一处 `input.groupId` 都报错。修它只有两条路，代价都很高：

1. 把 `{object}` 展开成完整内联记录。一个 20 个字段的选项对象要写 20 行注释，而这个函数的实际逻辑往往只有 5 行。
2. 引入 `@typedef`。可 `@typedef` 一旦定义在「被调用方」，就要保证每个调用点传进来的形状都精确匹配；实测中这会把错误**从定义处搬到每个调用处**（我先试过一轮：402 个 TS2339 变成了 380 个 TS2339 + 95 个 TS8032 + 50 个 TS2345，净效果是负的）。

**它拦不住真正的 bug**。这次实际发现的有价值问题，没有一个是 TS2339 报出来的：

- 4 个 `ReferenceError`（`displayNameOf`、`settingsAgentName`、`parseInviteLink`、`probeReachability`）→ 是 **TS2304** 报的
- `splitRoster` 丢 `isSelf` → 是**测试**抓到的

也就是说：**TS2339 的 402 个里，真 bug 命中率接近 0；而为了它们改 400 处注释，会让 diff 在 review 时不可读**，反而淹没真正有价值的改动。

### 已修的真问题（附证据）

| 位置 | 症状 | 证据 |
|---|---|---|
| `lib/shared/tool-runtime.js` | `displayNameOf` 未定义 → `a2a_group_create` 100% 崩溃 | 运行时 `ReferenceError: displayNameOf is not defined` |
| 同上 | `settingsAgentName` 未定义 → 建群成功后取 gatewayName 崩溃 | 同一路径复现 |
| 同上 | `parseInviteLink` 未定义 → `a2a_group_join` 100% 崩溃 | `ReferenceError: parseInviteLink is not defined`；该函数其实存在于 `lib/dsh/tools.js:65`，只是没 import |
| 同上 | `probeReachability` 未定义 → `a2a_serve` 100% 崩溃 | `ReferenceError: probeReachability is not defined`；实存于 `lib/core/probe.js:38` |
| `lib/core/bridge.js:117` | `detail.code` 被标成 `{number}`，但代码传了 10 处字符串子码（`'aborted'`、`'bad_target'`…），而同文件 `toJSON()` 自己写的是 `number\|string` | 注释自相矛盾；3 个消费方用 `typeof code === 'string'` 判断，说明字符串才是约定 |

前四条由 Lead 修复（补 import + 补两个函数），最后一条是这次改注释时发现并修正的。

### 什么情况下该重新考虑

不是"等有空再说"，而是有明确的触发条件：

1. **如果开始定义核心数据结构的 `@typedef`**（`Group` / `Member` / `Task` / `Membership`），TS2339 会**自然**大幅下降——因为错误的根源是形状没有名字，而不是代码有问题。那时再追它，就是在收一份已经付过成本的收益。
2. **如果准备上 `strict: true`**。`strict` 会让 `null`/`undefined` 成为必须处理的分支，收益远高于 TS2339；但它要求先把上面那批 `@typedef` 建好，否则错误数会先暴涨。
3. **如果 TS2339 之外出现了新的 TS2304**。这一类便宜且命中率高，任何时候都值得立刻修。

反之，**不要**为了降低错误总数去批量展开 `{object}`——本次实测证明那是在搬动错误，不是在消除错误。

### 这一轮的约束（供后续参照）

改这一层时只动注释，不改逻辑。落地的校验方式有两个，都在本次过程中实际用过：

1. **代码行比对**：去掉所有注释、丢掉空行后，逐行必须完全一致。
2. **测试基线**：`node --test test/*.test.mjs` 必须保持 `395 tests / 394 pass / 1 skip`（那 1 个 skip 是 Windows 没有 POSIX 文件权限，属预期）。

唯一一处例外需要在 review 时留意：`lib/core/server.js` 的 `readBody()` 里给 `for await` 的目标加了一个 `/** @type {AsyncIterable<Buffer|string>} */` 断言——`node:http` 的 request 本身就是异步可迭代对象，而 JSDoc 无法用 `@property` 表达这一点。它不改变任何运行时行为（断言在运行时被擦除），测试也照旧全绿。
