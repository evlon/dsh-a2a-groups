# dsh-a2a 落地实录

> 这份文档只写**实测过的**结论。每条都对应一段可复跑的命令或测试；没跑过的东西不写在这里，也不写进 README。
>
> 架构决策与依据见 [`DESIGN.md`](DESIGN.md)。

## 0. 现在装在哪、怎么起来

**两个实例，各司其职**（都不碰 3080）：

| 角色 | DSH_HOME | 端口 | 模型 | 干什么 |
|---|---|---|---|---|
| **群宿主** | `C:\Users\niukl\.dsh-groups` | 3095 | **不需要** | 存群/成员/邀请/feed，纯信息交换 |
| **成员（演示）** | `C:\Users\niukl\.dsh-a2a-dev` | 3091 | 需要 | 当"同事"，用链接入群 |

```powershell
# 群宿主（纯群技能，无 session/ask）
$env:DSH_HOME="C:\Users\niukl\.dsh-groups"
dsh web --port 3095 --host 127.0.0.1 --no-open

# 成员侧
$env:DSH_HOME="C:\Users\niukl\.dsh-a2a-dev"
dsh web --port 3091 --host 127.0.0.1 --no-open
```

两边都用 junction 指向源码（`profiles/web/node_modules/dsh-a2a`），改代码重启即生效。

> **端口 3092 不能用**：被 WSL 端口转发占着，`listen` 报 EADDRINUSE 而 `netstat` 看不到——影子监听在 WSL 侧。

## 1. 纯群宿主已验证

卡片里只有 9 个技能，**没有 `session/ask`**：

```
ping, group/create, group/invite, group/join, group/post,
group/read, group/subscribe, group/members, group/role, group/leave
```

实测建群 **105ms**，全程不碰模型。`server.skills.session: false` 是这么配的。

## 2. 五个端到端验证（全部通过）

```sh
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

行里只有：`groupId / name / topic / joinPolicy / memberCount / onlineCount / lastActivityAt`。

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
x-dsh-profiles   : 9 个群，每组一条 roleAbout + tags
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
ℹ tests 288
ℹ pass 287
ℹ fail 0
ℹ skipped 1     (Windows 无 POSIX mode 位)
```

新增的两个测试文件都是针对本轮设计的：

| 文件 | 断言数 | 守住什么 |
|---|---|---|
| `test/role.test.mjs` | 8 | 层 A：按群独立、不能改别人、权限位不受影响、旧数据可读 |
| `test/profile.test.mjs` | 9 | 层 B：占位名过滤、空账本、不泄漏凭证、provider 抛错降级 |
| `test/directory.test.mjs` | 7 | 频道目录：不泄漏成员/正文、`unlisted` 完全不可见、分页有界 |

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

第 7 和第 10 是**只有真实双实例跑起来才暴露的**：单实例测试里 `input.text` 恰好等于真实内容。

## 5. 三个环境坑

### 5.1 网关抓不到 Windows 上的 DSH（~100 秒超时）

网关 reqwest 跨 WSL→Windows 边界会挂（`status_code=499, latency=108646`），而同样的请求从 WSL shell 打是 2ms。

**解法：配置用 `http://127.0.0.1:3095/a2a`**（WSL 镜像 Windows 回环）。
**硬约束**：网关和被代理的 agent 要么同在 Linux，要么走回环；不要跨边界。

### 5.2 卡片 scheme 默认 https

没收到 `X-Forwarded-Proto` 时一律宣告 `https`。插件已兜底（配 `client.forwardProto`）。

### 5.3 `?token=` 返回 303 + Set-Cookie

Node 的 `fetch` 不带 cookie jar，直接 `fetch('/?token=')` 会 401。`scripts/verify-panel.mjs` 已处理。

## 6. 群怎么用（用户视角）

1. **建群**：会话里说"建个群叫发票重构" → `a2a_group_create`，拿 `groupId` + 一次性 ownerKey（本机已存）
2. **发邀请**：`a2a_group_invite` → 返回一段可直接粘到 IM 的话（链接 + 密码提示 + 有效期 + 次数）
3. **同事入群**：贴链接 + 说密码 → `a2a_group_join`，**零配置**
4. **声明角色**：`a2a_group_role {groupId, about, tags}` → "我在这个群负责 X"
5. **日常**：`a2a_group_post` 发言、`a2a_group_read` 增量读、`a2a_groups` 看我的群
6. **名片自动生成**：任何人 `a2a_discover` 这个 agent，看到的 `x-dsh-profiles` 就是他所有群的角色

## 7. 安全边界

1. **`groups.json` 泄漏了也拿不到可用的东西**：密码 `scrypt$16384$salt$hash`，令牌/成员凭证 sha256，比较走 `timingSafeEqual`
2. **明文成员凭证在 `memberships.json`（0600）**：本机必须能出示才能发帖，所以不能只存哈希；但它与"我托管的群"是两个信任边界，分文件
3. **两层认证不合并**：网关 Key 说"你能访问这个 agent"，`memberKey` 说"你是这个群成员"
4. **角色 ≠ 权限**：`roleAbout`/`tags` 只影响显示，`role` 才是权限位，任何角色操作都不碰它
5. **名片不含凭证**：有测试守着（`test/profile.test.mjs`）

## 8. 还没做

- **频道目录**（`group/list`）：现在只能看本机的群，不能列某个宿主上有哪些群
- **`group/remove`**：群主移除他人
- **面板是只读的**：发帖走会话工具；数据由 Host 注入 `__DSH_A2A_GROUPS__`（已实现，3091 上验证过）
- **`session/ask` 在 3095 上不可用**（有意为之，纯群宿主）
- **3080 未动**

## 9. 复跑清单

```sh
# 网关（WSL）
/mnt/e/dsh-a2a-bus/scripts/aisix-dev/aisix-dev.sh up
/mnt/e/dsh-a2a-bus/scripts/aisix-dev/aisix-dev.sh smoke

# 两个实例（见 §0）后，四个验证
node scripts/aisix-dev/probe-chain.mjs
node scripts/aisix-dev/probe-collab.mjs
node scripts/aisix-dev/probe-role.mjs
node scripts/aisix-dev/probe-profile.mjs

# 单元 + 集成
cd dsh-a2a && node --test test/*.test.mjs
```


