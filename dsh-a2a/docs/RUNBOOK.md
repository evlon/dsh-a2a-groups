# 运行手册

> **这份文档只写「怎么让它跑起来，跑起来怎么用」。**
> 踩过的坑、修过的 bug、验证过什么，都在 [CHANGELOG.md](../CHANGELOG.md)。
> 架构决策见 [DESIGN.md](DESIGN.md)，部署见 [DEPLOY.md](DEPLOY.md)。

---

## 一、三个角色

| 角色 | 是什么 | 端口示例 | 需要模型吗 | 谁部署 |
|---|---|---|---|---|
| **群宿主** | 独立 Node 进程 | 3095 | **不需要** | 一台服务器，一次 |
| **网关** | AISIX，可选 | 3000 | 不需要 | 运维，一次 |
| **成员** | 每人的 DSH | 3091… | 需要 | 每人自己的机器 |

**关键**：群宿主不是 DSH 实例，不加载模型、不消耗 Token。一台普通机器就够。

---

## 二、启动群宿主

```powershell
cd <repo>\dsh-a2a
$env:AGENT_GROUPS_TOKEN="<随机长串>"
node bin\agent-groups.js `
  --port 3095 `
  --data "C:\ProgramData\agent-groups" `
  --gateway "http://127.0.0.1:3000/a2a" `
  --agent "agent-group-host"
```

**启动日志会直接打印网关需要的配置片段**，照抄即可。

验证它活着：

```powershell
curl http://127.0.0.1:3095/a2a/.well-known/agent-card.json
# 返回 A2A 1.0 卡片，含 group/* 技能
```

数据落在 `--data` 指定的目录，两个文件：

| 文件 | 内容 |
|---|---|
| `groups.json` | 群、成员、消息 |
| `memberships.json` | 本机加入过哪些群 |

已有：`bin/agent-groups.js --help` 有全部参数。

---

## 三、让一个人的 DSH 能进群

### 3.1 装插件

```bash
# 公司内网（首选）：两个源是同一个构建产物，shasum 相同
dsh plugin --profile web add dsh-a2a-groups --registry=http://registry.ict.cmcc

# 外网 / 出差
dsh plugin --profile web add dsh-a2a-groups --registry=https://registry.npmmirror.com
```

> **为什么现在要显式写 `--registry`**：内网 Verdaccio **不自动同步上游 npm**，只有被手动推过的包才在。
> 这台机器的默认 registry 是外网镜像，所以「装得上」不代表「同事装得上」。发版时两边都推（见 §六）。

**然后必须做第二步**：编辑 `<$DSH_HOME>/profiles/web/package.json`，把包名加进 `dsh.profile.bundles`：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-a2a-groups"
      ]
    }
  }
}
```

> 漏了这步，重启后 UI 里**什么都不会出现，也不报错**。`dsh plugin` 只负责装包，启用是另一件事。

### 3.1b 升级插件：别在 DSH 运行时动 node_modules

**踩坑实录（生产环境，同事实测）**：DSH 正在运行时，用 `pnpm add` 升级 profile 里的插件，会撞上文件锁：

```
ERR_PNPM_PACKAGE_MANAGER_REMOVE_MODULES_DIR
Failed to remove modules directory contents: 拒绝访问 (os error 5)
```

结果 pnpm 中途失败，把 `node_modules` 删得只剩几项、丢了好几个依赖。只能用备份的 lockfile + `pnpm install --frozen-lockfile` 重建才恢复。

**规则**：

| 场景 | 正确做法 |
|---|---|
| 桌面应用（Electron 独占的 `desktop` profile） | **只用桌面应用的插件管理面板**更新。命令行 `dsh plugin --profile desktop` 会被拒：`profile "desktop" is managed exclusively by the Electron application` |
| 命令行升级 `web` 等 profile | **先停掉 DSH 进程**，再 `dsh plugin --profile web add …`，最后重启 |
| 想不重启就升级 | 做不到。profile 的 `node_modules` 和 `package.json` 只在启动时读 |

> 这条和「重启后插件只加载一半」是同一类问题：**运行时改 node_modules / 路由注册，都会留下半加载状态**。改完必须干净地重启。

### 3.2 配置

同一个 profile 的 `cordis.patch.yml`：

```yaml
- id: a2a
  name: dsh-a2a-groups
  config:
    groups:
      enabled: true
      gatewayBase: http://<网关>:3000/a2a
      agentName: agent-person-you        # 你在网关注册的名字
    client:
      enabled: true
      apiKey: <网关调用方密钥>
      gatewayBase: http://<网关>:3000/a2a
    server:
      enabled: true
      publicUrl: http://<你的地址>:3091/a2a
      token: <本机 A2A 令牌>
    tools: true
    promptSection: true
```

### 3.3 重启并确认

```bash
dsh web --port 3091 --host 127.0.0.1 --no-open
```

页面上应该出现 **「协作群」** 按钮。没有的话：

| 现象 | 查这里 |
|---|---|
| 无按钮，`err.log` 干净 | `dsh.profile.bundles` 里有没有包名 |
| `cannot resolve profile bundle` | profile 的 `package.json` 和 patch 里的 `name` 是否一致 |
| `loaded without registering` | 包的 `client.js` 注册 id 是否等于包名 |

---

## 四、日常使用

### 4.1 建群

会话里说「建个协作群叫发票重构」，或直接调工具：

```json
{ "name": "a2a_group_create", "arguments": { "name": "发票重构", "topic": "拆分 invoice 服务" } }
```

返回 `groupId` 和 **ownerKey（只显示一次，收好）**。

### 4.2 邀请同事

```json
{ "name": "a2a_group_invite", "arguments": { "groupId": "g-xxx" } }
```

返回一段可以直接粘到 IM 的话（链接 + 有效期 + 「群主可随时撤销」）。

**同事把链接贴进自己的 DSH 会话即可**，零配置、无密码。

### 4.3 群内发言与 @

```json
{
  "name": "a2a_group_post",
  "arguments": {
    "groupId": "g-xxx",
    "message": "对账接口我改完了，请看下",
    "mentions": ["李四"]
  }
}
```

| 写法 | 效果 |
|---|---|
| 带 `mentions` | 被点到的人**被唤醒** |
| 不带 `mentions` | 所有人只增加未读数，不打断 |
| `["@all"]` | 全员唤醒（公告用） |

**这是群不变成噪音的关键。** 日常进度不加 mentions。

### 4.4 看未读

```json
{ "name": "a2a_inbox_check", "arguments": {} }
```

一次返回全部待办：

```json
{
  "total": 3,
  "directMessages": [{ "kind": "group-invite", "text": "邀请你加入「发票重构」" }],
  "groups": [{ "name": "发票重构", "unread": 2 }]
}
```

**顺序有讲究**：一对一在前，因为邀请会阻塞进度。

> **MCP 客户端必须显式要求模型调用它**，因为 MCP 无推送：
> ```bash
> codebuddy -p "先调用 a2a_inbox_check 看有没有协作群消息，有未读先处理。然后：<任务>"
> ```

### 4.5 声明分工

两个字段，作用域不同：

| 字段 | 作用 | 换群还生效吗 |
|---|---|---|
| `about`（群内介绍） | 我在**这个群**负责什么 | 否 |
| `headline`（个人介绍） | 我是谁 | **是**，显示在所有名片上 |

两个都用同一个工具，一次可以只改一个：

```json
{
  "name": "a2a_group_set_card",
  "arguments": {
    "groupId": "g-xxx",
    "about": "负责对账与发票生成",
    "tags": ["研发", "后端"],
    "headline": "后端工程师，专注对账系统"
  }
}
```

**只传 `about` 不会清掉 `headline`** —— 三个字段各自独立，不传的保持原值。传空字符串才是清空。

面板里也能改：群成员面板 → 点自己那一行 → 展开两个输入框 → 保存。

### 4.6 群管理

| 操作 | 工具 | 谁能做 |
|---|---|---|
| 改名 | `a2a_group_rename` | 群主 |
| 移除成员 | `a2a_group_kick` | 群主 |
| 归档 | `a2a_group_archive` | 群主 |
| 审批申请 | `a2a_group_approvals` + `a2a_group_decide` | 群主 |

**移除保留历史**：被移除的人之前的消息仍在 feed 里。

---

## 五、验证一切正常

```powershell
# 1. 单元 + 集成
cd dsh-a2a
node --test test/*.test.mjs
# → tests 430 / pass 429 / fail 0

# 2. 独立宿主（不需要 DSH）
node scripts\standalone-probe.mjs --port 3095 --token <token>
# → standalone: OK

# 3. MCP 协议
node scripts\mcp-probe.mjs
# → mcp: OK
```

**最低验收标准**：单元测试 `fail 0` + `standalone: OK`。这两条过了，协议层和宿主就是对的。

### 端到端验证脚本

这些在**仓库根目录**的 `scripts/` 下（不在 npm 包里，只有源码仓库有）。需要网关和实例都起来：

```bash
# 从仓库根目录执行
node scripts/aisix-dev/probe-chain.mjs        # 整链：外部 → 网关 → DSH → 技能
node scripts/aisix-dev/probe-collab.mjs       # 双实例：建群 → 邀请 → 入群 → 收发
node scripts/aisix-dev/probe-role.mjs         # 群内角色
node scripts/aisix-dev/probe-profile.mjs      # 同事名片
node scripts/aisix-dev/probe-directory.mjs    # 频道目录
```

> 上面「验证一切正常」那三条在 `dsh-a2a/` 目录下执行 —— 它们在包内，装了 npm 包就能跑。

---

## 六、排错

### 网关 401

密钥不匹配。**先查容器里跑的那份配置**，不是仓库里的模板：

```bash
wsl -e bash -c "grep -n key_hash ~/aisix-dev/data/resources.yaml"
```

仓库里的 `scripts/aisix-dev/resources.yaml` 是**模板**，改它不影响运行中的网关。

### 网关 404

`baseUrl` 缺 agent 名。正确的是：

```
http://gw:3000/a2a/agent-group-host     ✅
http://gw:3000/a2a                      ❌ 404
```

### 面板保存失败

看宿主日志：

```powershell
Get-Content "$env:DSH_HOME\err.log" -Tail 20
# → [a2a-panel] write failed for g-xxx: <真实原因>
```

### 群消息收不到

1. 成员实例的 `groups.gatewayBase` 是否指向网关
2. 网关能否转发到宿主：`curl http://gw:3000/a2a/agent-group-host/.well-known/agent-card.json`
3. 群里发言时**有没有带 mentions** —— 不带只增加未读数，不会唤醒

### 端口冲突

**3092 不能用**：被 WSL 端口转发占着，`listen` 报 EADDRINUSE 但 `netstat` 看不到——影子监听在 WSL 侧。

---

## 七、发版

一个版本发布要动**两个 npm 源**，而且必须在同一次动作里做完。

### 7.1 为什么是两个

```
官方  registry.npmjs.org      外网、CI 在 tag 上自动发布
内网  registry.ict.cmcc       公司内网 Verdaccio，不自动同步上游
```

内网源**只有被手动推过的包才在**。实测 `is-odd`/`left-pad`/`lodash` 全部 404 而 `dsh-himarket` 在，
就是这个原因。

**「官方发布成功 = 同事能装到」不成立。** 中间这一步静默失效：你那边一切正常，同事那边装的是旧版，
没有人会报错。

### 7.2 三步

```bash
# ① 推 tag，CI 会跑测试并发布官方 npm
git tag -a v0.1.30 -m "..." <commit>
git push origin v0.1.30 && git push corp v0.1.30

# ② 官方成功后，推内网（必须显式 --registry，本机默认是外网镜像）
cd /tmp && npm pack dsh-a2a-groups@0.1.30 --registry https://registry.npmjs.org
npm publish dsh-a2a-groups-0.1.30.tgz --registry http://registry.ict.cmcc --access public

# ③ 验证——直接打 registry，不要用 npm view（有缓存）
curl -s http://registry.ict.cmcc/-/package/dsh-a2a-groups/dist-tags
curl -s https://registry.npmjs.org/-/package/dsh-a2a-groups/dist-tags
```

推之前先比 shasum，一致才推——推错版本到内网是**不可撤销**的（同一版本号不能覆盖，只能递增重发）：

```bash
sha1sum dsh-a2a-groups-0.1.30.tgz                       # 本地
curl -s https://registry.npmjs.org/dsh-a2a-groups/0.1.30 | jq -r .dist.shasum
```

> 也可以直接用现成脚本（PKGS 清单已包含本包，含幂等跳过）：
> ```bash
> bash /e/ai-works/k8s/scripts/publish-internal.sh --check
> bash /e/ai-works/k8s/scripts/publish-internal.sh dsh-a2a-groups 0.1.30
> ```

### 7.3 依赖树也要推（`publish-internal.mjs`）

**大部分同事不能访问外网**（公司防火墙），内网源对他们不是便利，是唯一途径。

而内网 Verdaccio 没有 uplink，所以「把我们的包推上去」远远不够：`dsh plugin add <pkg> --registry=<内网>`
会让 pnpm 拿**整棵依赖树**去内网解析，缺一个传递依赖就变成

```
ERR_PNPM_FETCH_404  GET http://registry.ict.cmcc/dsh-plugin: Not Found
```

——报错里的包名，发版的人根本没听过。

```bash
# 一个包 + 它的依赖树
node scripts/publish-internal.mjs dsh-a2a-groups@0.1.31

# 审计某个 profile 缺什么（只读）
node scripts/publish-internal.mjs --profile "$DSH_HOME/profiles/web"

# 补齐它（把缺的包全部推上去）
node scripts/publish-internal.mjs --profile "$DSH_HOME/profiles/web" --fix
```

脚本用 `npm install --package-lock-only` 让 **npm 自己**解析精确版本，不自己实现 semver；
按版本自动选 dist-tag（预发布 → `rc` 之类，低于现有版本 → `legacy-<版本>`），不会污染 `latest`；
已存在的包直接跳过，可重复运行。

三个踩过的坑，脚本里已处理：

| 坑 | 症状 | 处理 |
|---|---|---|
| `pack` 复用同一工作目录 | 拿上一个包的 tarball 去发布，报错里是错的文件名 | 每包一个独立子目录 |
| 上游包带 `publishConfig.provenance` | `EUSAGE Automatic provenance generation not supported for provider: null` | 固定加 `--provenance=false` |
| `process.exit()` 时子进程管道还在关 | Windows 上 libuv 断言，成功也返回 1 | 设 `process.exitCode` 让它自然退出 |

> **根治办法是给 Verdaccio 配 uplink**（代理到 registry.npmjs.org、按需缓存），这样缺包自动补，
> 不用手工推。前提是**那台机器自己能出外网**——如果它也不能，就只能在能出外网的机器上补推。

### 7.4 发版完成的判据（可机器化）


```
完成 = 官方 latest == 内网 latest  且 两边的 tarball shasum 相同
```

**任一项不相等，这次发版就还没完成。** 这条比「记得推一下」可靠——它不依赖任何人记性。

### 7.5 五个坑（都踩过）

| 坑 | 后果 | 对策 |
|---|---|---|
| 内网同版本不可覆盖 | 发错了无法重推 | 推前比 shasum；发错只能递增版本号 |
| 本机默认 registry 是外网镜像 | `npm publish` 不带 `--registry` 会发错地方 | 永远显式写 |
| `npm view` 有缓存 | 误判「已发布」 | 验证一律 `curl` 直打 registry |
| 内网版本可能**超前**于官方 | 「内网落后」的判断不一定成立 | 比版本别只看方向，脚本已按比较区分 |
| `workspace:*` 不能直接 publish | 同事装时报 ERR_PNPM_WORKSPACE_PKG_NOT_FOUND | 用 `pnpm publish` 或先改真实版本号 |

---

## 八、安全边界

给同事讲清楚，避免误用：

1. **没有群密码**：入群凭证只有邀请 token 或审批 claimKey，都能精确撤销
2. **`groups.json` 泄漏也拿不到可用凭证**：存的全是 sha256
3. **明文成员凭证在 `memberships.json`**（0600 权限），只有本机持有
4. **管理员看不到消息正文**：只能看治理指标（多少群、多久没动）
5. **名片不含凭证**：有测试守着
6. **角色 ≠ 权限**：`about`/`tags` 只影响显示，`role` 才是权限位

---

## 九、当前能力边界

**已知不做**（不需要再提需求）：

| 项 | 原因 |
|---|---|
| 群消息自动触发 AI 干活 | 会被别人的消息刷爆，所有人都会关掉它 |
| 一对一持续私聊 | 它是门铃不是聊天室，要聊就建群 |
| 管理员查看群内容 | 同事入群时预期是「和同事说话」，不是「被审阅」 |
| 多人共用一份 `groups.json` | 当前设计假设单写者，要 HA 得换存储 |
| MCP 主动推送 | 协议支持但无客户端消费，见 [MCP.md](MCP.md) |

**已在需求池**，见 [BACKLOG.md](BACKLOG.md)：群运营面板、跨会话可见性收敛、AI 组队推荐。
