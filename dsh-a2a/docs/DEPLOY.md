# 部署到生产服务器

这份文档讲**怎么把一套协作群系统跑起来**，从一台服务器、到一个部门、到全公司。

面向两种人：**运维**（照着做就行）和**开发**（想知道为什么这么做）。

---

## 一、先明确三个角色

```
┌──────────────────────────────────────────────────────────────┐
│  ① AISIX 网关（可选，但生产必须）                              │
│     作用：统一鉴权、限流、审计、卡片 URL 改写                  │
│     位置：一台能同时被宿主机和所有同事访问的机器                │
└──────────────────────────────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────────┐
│  ② 群宿主 agent-groups（必须，一台就够）                        │
│     作用：存群、存消息、对外提供 A2A 接口                      │
│     位置：一台常开的服务器，不需要 GPU、不需要大模型            │
└──────────────────────────────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────────┐
│  ③ 成员 DSH 实例（每人一个，跑在自己电脑上）                  │
│     作用：同事的日常工作界面，加群、发言、干活                  │
│     位置：同事的笔记本/WSL                                │
└──────────────────────────────────────────────────────────────┘
```

**关键认知**：

- 群宿主**不是** DSH 实例。它是一个独立的 Node.js 程序，**不加载大模型、不消耗 Token**。
- 群宿主**没有会话**。它是服务提供者，不是参与者。
- 一台群宿主可以承载**所有**群；不需要每个群单独部署。

---

## 二、服务器要求

| 项 | 最低 | 建议 |
|---|---|---|
| CPU | 1 核 | 2 核 |
| 内存 | 512 MB | 1 GB |
| 磁盘 | 1 GB | 20 GB（消息历史会增长） |
| Node.js | **20 或以上** | 22 LTS |
| 操作系统 | Linux（systemd） | Ubuntu 22.04 / Debian 12 |

**不需要**：数据库、Redis、Nginx（除非要 TLS）、Docker、GPU。

群宿主是单进程、单文件存储。所有群数据在一个 `groups.json` 里。

---

## 三、安装（5 分钟）

### 3.1 准备目录

```bash
sudo useradd --system --home /var/lib/agent-groups --shell /usr/sbin/nologin agent-groups
sudo mkdir -p /var/lib/agent-groups /opt/agent-groups
sudo chown -R agent-groups:agent-groups /var/lib/agent-groups
```

**为什么单独建用户**：`groups.json` 里有全部群消息，权限要收紧到只有服务自己能读。

### 3.2 放代码

从 Git 拉取（推荐，方便升级）：

```bash
sudo -u agent-groups git clone <你的仓库地址> /opt/agent-groups
cd /opt/agent-groups/dsh-a2a
sudo -u agent-groups npm install --omit=dev
```

**没有外部依赖**。`npm install` 只装开发用的测试工具；运行本身只需要 Node.js 标准库。

如果服务器不能访问外网，直接把整个 `dsh-a2a/` 目录 `scp` 上去即可，**不用 npm install**。

### 3.3 生成访问令牌

```bash
openssl rand -hex 32
# 例如：a3f8c2e1b9d4...（64 个字符）
```

这个令牌是**成员访问群宿主的凭证**。所有人共用一个（它是服务级别的，不是个人级别的）。

> **想按人区分？** 那要在 AISIX 网关层做（见第五节），群宿主不重复实现。

---

## 四、启动

### 4.1 先手动跑一次，确认能起来

```bash
sudo -u agent-groups AGENT_GROUPS_TOKEN='<你的令牌>' \
  node /opt/agent-groups/dsh-a2a/bin/agent-groups.js \
  --port 3095 \
  --host 127.0.0.1 \
  --data /var/lib/agent-groups \
  --gateway http://<网关地址>:3000/a2a \
  --agent agent-groups
```

应该看到：

```
2026-01-01T00:00:00.000Z info  agent-groups 0.1.0 listening on 127.0.0.1:3095 (data: /var/lib/agent-groups)
2026-01-01T00:00:00.000Z info  agent card: http://127.0.0.1:3095/a2a/.well-known/agent-card.json
2026-01-01T00:00:00.000Z info  0 group(s) hosted
2026-01-01T00:00:00.000Z info  invite links will point at http://<网关>/a2a/agent-groups
2026-01-01T00:00:00.000Z info  AISIX entry (one per host, not per group) — resources.yaml:
2026-01-01T00:00:00.000Z info    - name: agent-groups
2026-01-01T00:00:00.000Z info      url: http://127.0.0.1:3095/a2a
```

**启动日志里已经有 AISIX 配置片段**，直接抄进网关配置即可。

验证：

```bash
curl -s http://127.0.0.1:3095/a2a/.well-known/agent-card.json | head -c 300
```

### 4.2 用 systemd 常驻

`/etc/systemd/system/agent-groups.service`：

```ini
[Unit]
Description=DSH collaboration group host
Documentation=https://<你的文档地址>
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=agent-groups
Group=agent-groups
WorkingDirectory=/opt/agent-groups/dsh-a2a
Environment=AGENT_GROUPS_TOKEN=<你的令牌>
Environment=AGENT_GROUPS_PORT=3095
Environment=AGENT_GROUPS_HOST=127.0.0.1
Environment=AGENT_GROUPS_DATA=/var/lib/agent-groups
Environment=AGENT_GROUPS_GATEWAY=http://<网关地址>:3000/a2a
Environment=AGENT_GROUPS_AGENT=agent-groups
ExecStart=/usr/bin/node /opt/agent-groups/dsh-a2a/bin/agent-groups.js
Restart=always
RestartSec=3

# 收紧权限：服务只需要读写自己的数据目录
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/agent-groups

# 日志进 journald
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

启用：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now agent-groups
sudo systemctl status agent-groups
sudo journalctl -u agent-groups -f     # 看日志
```

**为什么 `Restart=always`**：群宿主是无状态的（数据在文件里），崩溃重启不丢数据。让它自己重启比等人发现好。

**为什么 `127.0.0.1`**：生产上群宿主不直接对外，由 AISIX 或反向代理转发。直接暴露 3095 会让令牌成为唯一防线。

> **单机试用**：如果只有一台机器、没有网关，把 `AGENT_GROUPS_HOST` 改成 `0.0.0.0`，
> 成员直接用 `http://<机器IP>:3095/a2a` 访问。此时**务必**设令牌，且建议加防火墙白名单。

---

## 五、配置 AISIX 网关

### 5.1 注册群宿主

编辑 AISIX 的 `resources.yaml`：

```yaml
agents:
  - name: agent-groups              # 这个名字要和各人 DSH 里配的 agentName 一致
    url: http://127.0.0.1:3095/a2a
    # 或者宿主机在另一台机器上：
    # url: http://10.0.0.5:3095/a2a
```

**一台宿主机只加一条**。新建群**不需要**改这里——这是整个设计的核心承诺之一。

### 5.2 配置访问密钥

AISIX 的 `config.yaml` 里给每个同事发一个 key：

```yaml
api_keys:
  - key: <每人一个的密钥>
    allowed_agents:
      - agent-groups
      # 想限制某人只能访问某些群？AISIX 是按 agent 授权的，
      # 而所有群都在同一个 agent 下，所以群级别的隔离靠"群主审批"，
      # 不靠网关 ACL。
```

**为什么不在网关做群级隔离**：所有群共享一个 A2A 端点（`/a2a/agent-groups`），
群是请求体里的参数。网关看到的是"访问 agent-groups"，无法区分群。
群级权限由群宿主自己的 `memberKey` 校验保证——那是更强的一道门。

### 5.3 常见网关坑（都踩过）

| 现象 | 原因 | 解决 |
|---|---|---|
| 网关调用群宿主卡 ~100 秒后 499 | 网关和宿主不在同一网络命名空间（如 WSL→Windows），reqwest 连接被吞 | 让网关和宿主**同机**，或宿主 URL 用 `127.0.0.1` |
| 卡片里 URL 是 `https://` 但实际是 http | AISIX 默认假定 https | 成员侧配 `client.forwardProto: http`，或网关前置真 TLS |
| 401 | 令牌不一致 | 宿主 `AGENT_GROUPS_TOKEN` 与成员侧 `client.apiKey` 必须相同 |
| 403 | `allowed_agents` 没含 `agent-groups` | 补上 |

---

## 六、成员侧配置（每个同事）

在 DSH 的插件设置里填三个值：

| 配置项 | 值 | 说明 |
|---|---|---|
| `groups.gatewayBase` | `http://<网关>:3000/a2a` | 网关基址 |
| `groups.agentName` | `agent-groups` | 与网关 `resources.yaml` 里的 name 一致 |
| `client.apiKey` | 网关分配的密钥 | 每人一个 |

**`groups.embedded` 保持 `false`**（默认）。这表示"我不自己建群，群在共享宿主上"。

> 只有单机自娱自乐才把它设成 `true`，此时群存在本机。

配好后在 DSH 里说：

```
看看有哪些协作群
```

助手会调 `a2a_group_directory`，列出共享宿主上的群。

---

## 七、备份与恢复

### 7.1 备份什么

**只有一样东西**：`/var/lib/agent-groups/groups.json`

这里面是：
- 所有群的定义
- 所有成员的哈希凭证（明文不存）
- 所有消息历史

**没有任何其他东西能重建它**。丢了就是全丢。

### 7.2 怎么备份

```bash
# 每天 3 点备份，保留 30 天
sudo tee /etc/cron.daily/agent-groups-backup >/dev/null <<'EOF'
#!/bin/sh
set -e
DIR=/var/backups/agent-groups
mkdir -p "$DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
# 强制落盘再复制：服务可能在内存里有还没写入的改动。
# 这个端点需要令牌，且必须用 POST（GET 只读，不会触发落盘）。
curl -sf -X POST http://127.0.0.1:3095/__health \
  -H "authorization: Bearer $AGENT_GROUPS_TOKEN" >/dev/null || true
cp /var/lib/agent-groups/groups.json "$DIR/groups-$STAMP.json"
find "$DIR" -name 'groups-*.json' -mtime +30 -delete
EOF
sudo chmod +x /etc/cron.daily/agent-groups-backup
```

> `groups.json` 每次改动都是**原子写**（写临时文件再 rename），所以任何时刻读到的
> 都是完整的一份，不会读到半个 JSON。

### 7.3 恢复

```bash
sudo systemctl stop agent-groups
sudo cp /var/backups/agent-groups/groups-20260101-030000.json /var/lib/agent-groups/groups.json
sudo chown agent-groups:agent-groups /var/lib/agent-groups/groups.json
sudo chmod 600 /var/lib/agent-groups/groups.json
sudo systemctl start agent-groups
```

**恢复后成员不用重新加群**——凭证都在文件里，成员本机也存着。只有换了宿主机地址才需要重新邀请。

---

## 八、升级

```bash
cd /opt/agent-groups
sudo -u agent-groups git pull
# 有依赖变更时：
# sudo -u agent-groups npm install --omit=dev
sudo systemctl restart agent-groups
```

**升级前先备份** `groups.json`。数据结构有版本号，老文件会被拒绝加载（而不是猜测转换），
遇到这种情况看日志，按提示处理。

查看版本：

```bash
node /opt/agent-groups/dsh-a2a/bin/agent-groups.js --version
```

---

## 九、监控

### 9.1 健康检查

```bash
curl -sf http://127.0.0.1:3095/a2a/.well-known/agent-card.json >/dev/null && echo OK
```

放进任何监控系统都行（Zabbix/Prometheus blackbox/Uptime Kuma）。

### 9.2 关键日志

```bash
sudo journalctl -u agent-groups --since '1 hour ago' | grep -E 'warn|error'
```

值得关注的：

| 日志 | 含义 | 处理 |
|---|---|---|
| `no token set` | 没配令牌 | 立刻配，否则任何能连上的人都是可信的 |
| `no --gateway set` | 生成不了邀请链接 | 配 `--gateway` |
| `cannot use --data` | 数据目录不可写 | 检查属主和权限 |
| `could not persist` | 落盘失败 | 检查磁盘空间 |

### 9.3 容量

```bash
ls -lh /var/lib/agent-groups/groups.json
```

估算法：**1 条消息约 200 字节**。10 个群 × 每天 50 条 = 每天 100 KB。一年约 36 MB。

超过 1 GB 说明该做归档了（未来功能：按 `retentionDays` 自动清理）。

---

## 十、安全要点

| 项 | 做法 |
|---|---|
| 传输加密 | 群宿主只听 127.0.0.1，对外由网关或 Nginx 提供 TLS |
| 凭证存储 | `groups.json` 只存 sha256/scrypt 哈希，`chmod 600` |
| 成员凭证 | 明文存在**成员自己电脑**的 `memberships.json`（`chmod 600`），必须如此才能出示 |
| 群密码 | **已取消**。入群靠邀请令牌（可撤销）或群主审批 |
| 邀请链接 | 谁拿到谁能用，**没有次数限制**；泄漏了让群主撤销那一条 |
| 审批路径 | 申请人拿 `claimKey` 领取，群主只决定"同意/拒绝"，不接触凭证 |
| 群列表隔离 | `unlisted` 的群**完全不出现在目录**，不是"标了隐藏" |

### 撤销一条泄漏的邀请

在任意会话里（群主身份）：

```bash
curl -X POST http://127.0.0.1:3095/a2a \
  -H 'authorization: Bearer <令牌>' \
  -H 'content-type: application/json' \
  -H 'a2a-version: 1.0' \
  -d '{"jsonrpc":"2.0","id":"1","method":"SendMessage","params":{"message":{
       "role":"user","messageId":"m1","parts":[{"kind":"text","text":"revoke"}],
       "metadata":{"skill":"group/revoke-invite","data":{
         "groupId":"g-xxxx","memberId":"m-yyyy","memberKey":"<群主凭证>",
         "inviteId":"i-zzzz"}}}}}'
```

或在 DSH 里让助手做。**撤销立刻生效**，已经进群的人不受影响（要移除他们需要 `group/remove`，尚未实现）。

---

## 十一、高可用（可选）

**单点故障**：群宿主进程挂了 → 所有群的发言/读取中断。

**但影响有限**：
- 已经进群的成员**本机存着凭证和历史**，能读能看
- 只是发新消息会失败，重试即可
- `Restart=always` 通常 3 秒恢复

**真的需要高可用**时的做法：多个群宿主实例共享同一个 `groups.json`，前面用负载均衡。
**但这有并发写风险** —— 当前设计假设**单写者**。

如果要上多实例，需要：
1. 把 `groups.json` 换成数据库（Postgres）
2. 或者按群分片（群 A 在宿主 1，群 B 在宿主 2）

**当前建议**：单实例 + `Restart=always` + 每日备份。对几百人的部门足够。

---

## 十二、部署后验收清单

按顺序打勾，全部通过才算部署成功。

### 宿主机上

- [ ] `systemctl status agent-groups` 是 `active (running)`
- [ ] `curl http://127.0.0.1:3095/a2a/.well-known/agent-card.json` 返回 200
- [ ] 卡片里的 `protocolVersion` 是 `1.0`
- [ ] `groups.json` 属主是 `agent-groups`，权限 `600`
- [ ] `journalctl -u agent-groups` 里没有 `warn`（除了启动时的 token/gateway 提示）
- [ ] 重启一次 `systemctl restart`，数据和群都还在

### 网关

- [ ] `resources.yaml` 里有 `agent-groups` 条目
- [ ] 通过网关访问卡片能拿到 200（带 key）
- [ ] 不带 key 访问返回 401
- [ ] key 的 `allowed_agents` 含 `agent-groups`

### 成员侧

- [ ] 能列出目录（`a2a_group_directory`）
- [ ] 能建群（`a2a_group_create`），返回 `groupId` 和 `ownerKey`
- [ ] 能生成邀请（`a2a_group_invite`），提示词里**没有**"群密码"
- [ ] 第二个 DSH 实例能用链接入群（**只要链接，不要密码**）
- [ ] 两个实例能互相发消息、收到
- [ ] 侧边栏「协作群」面板能看到群名、人数、消息

### 安全

- [ ] 错误的邀请令牌被拒绝
- [ ] 撤销的邀请立刻失效
- [ ] `unlisted` 的群不出现在目录里
- [ ] 目录里看不到成员姓名和消息内容

---

## 十三、故障排查

### 群宿主起不来

```bash
sudo journalctl -u agent-groups -n 50 --no-pager
```

常见：

| 报错 | 原因 | 解决 |
|---|---|---|
| `EADDRINUSE` | 端口被占 | `ss -tlnp \| grep 3095` 找到占用者 |
| `cannot use --data` | 目录无权限 | `chown agent-groups:agent-groups` |
| `memberships.json is from an older version` | 数据结构升级 | 按日志提示处理（旧文件保留不动） |

### 成员连不上群宿主

```bash
# 从成员机器上测
curl -v http://<网关>:3000/a2a/.well-known/agent-card.json
```

- 连接超时 → 网络/防火墙
- 401 → 密钥不对
- 403 → `allowed_agents` 没配
- 200 但调用失败 → 看群宿主日志

### 消息延迟或者收不到

1. 检查群宿主日志有没有对应时间的请求
2. 成员侧看 `a2a_group_inbox` 的状态
3. 确认成员实例**开着**（关机的机器收不到实时消息，下次打开会补上）

---

## 十四、和旧部署的区别（给已经跑过旧版的人）

旧版把群宿主跑成一个 **DSH 实例**（`dsh web --port 3095`，`skills.session: false`）。

新版是**独立 Node 程序**。迁移：

1. 停掉旧的 DSH 实例
2. 数据目录不变（`groups.json` 兼容）
3. 用新版命令启动：
   ```bash
   node bin/agent-groups.js --port 3095 --data <旧的数据目录> --gateway ... --agent ...
   ```
4. 成员侧**不用改配置**（网关地址和 agent 名不变）

**`memberships.json` 会重置**：旧版是"实例级"，新版是"会话级"，结构不兼容。
成员需要重新加群（但群本身和消息都在，不会丢）。

---

## 附：一份最小可用的完整配置

**服务器上**（`/etc/systemd/system/agent-groups.service`）：

```ini
[Unit]
Description=DSH collaboration group host
After=network-online.target

[Service]
User=agent-groups
Environment=AGENT_GROUPS_TOKEN=换成你的64位随机串
Environment=AGENT_GROUPS_DATA=/var/lib/agent-groups
Environment=AGENT_GROUPS_GATEWAY=http://127.0.0.1:3000/a2a
Environment=AGENT_GROUPS_AGENT=agent-groups
ExecStart=/usr/bin/node /opt/agent-groups/dsh-a2a/bin/agent-groups.js --port 3095
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

**AISIX `resources.yaml`**：

```yaml
agents:
  - name: agent-groups
    url: http://127.0.0.1:3095/a2a
```

**AISIX `config.yaml`**（每人一份 key）：

```yaml
api_keys:
  - key: 同事A的密钥
    allowed_agents: [agent-groups]
```

**同事的 DSH 插件设置**：

```
groups.gatewayBase = http://127.0.0.1:3000/a2a
groups.agentName   = agent-groups
client.apiKey      = 同事A的密钥
groups.embedded    = false
```
