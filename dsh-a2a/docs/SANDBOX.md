# 测试实例的工作区隔离

> 三个测试实例（3091/3093/3096）**不再使用** `Documents\deepseek-harness\default-workspace`。
> 各自指向 `%TEMP%\a2a-sandbox\w1|w2|w3`。

---

## 一、之前的问题

三个实例共用 DSH 的**首次使用工作区**：

```
C:\Users\niukl\Documents\deepseek-harness\default-workspace
```

那是 DSH 在没有指定目录时自动建在 `Documents` 下的，**不是任何项目目录，但完全可写**。群里的 agent 能读写它。

当时里面只有 3 个测试文档，没出事。但**离出事只差一条误指令**。

### 为什么之前没发现

`dsh web --help` **没有 `--cwd` 参数**，所以「启动时指定目录」这条路不存在。工作目录是 DSH 的
`workspaceRegistry` 决定的，存在：

```
$DSH_HOME/storages/workspace.json
```

之前没人查过这个文件，所以三个实例一直静默共用默认工作区。

---

## 二、现在的做法

### 沙箱目录

```
%TEMP%\a2a-sandbox\w1    3091
%TEMP%\a2a-sandbox\w2    3093
%TEMP%\a2a-sandbox\w3    3096
```

每个里面有 `README.md` 说明「这是测试目录，可随意读写」。

### 改法

`storages\workspace.json` 是普通 JSON，工作区路径就在 `path` 字段：

```json
{
  "tables": {
    "workspaces": {
      "<id>": {
        "path": "C:\\Users\\niukl\\AppData\\Local\\Temp\\a2a-sandbox\\w1",
        "title": "a2a-sandbox-w1",
        "sessionIds": [ ... ]
      }
    }
  }
}
```

**改 `path` 一个字段**就完成迁移：

- 会话仍挂在同一个 `workspaceId` 上，不变
- memberships 不变，群里的身份不变
- 只有**新产生的文件写到哪**变了

### 验证

```
会话目录键: --C-Users-niukl-AppData-Local-Temp-a2a-sandbox-w1--
```

---

## 三、没做和没动的

| 项 | 状态 |
|---|---|
| `Documents\deepseek-harness\default-workspace` 里的 3 个文件 | **没删**，仍在原处 |
| 旧会话历史 | 保留，可查 |
| 备份 | 每个实例的 `workspace.json.bak` |

**为什么没删那 3 个文件**：它们是测试产物，删不删是机主的事，不是脚本该决定的。现在只是**不再往里写**。

---

## 四、回滚

```bash
# 恢复某个实例的工作区
copy "C:\Users\niukl\.dsh-a2a-dev\storages\workspace.json.bak" `
     "C:\Users\niukl\.dsh-a2a-dev\storages\workspace.json"
```

然后重启实例。

---

## 五、给正式环境的建议

**别让群实例落在默认工作区。** 三种做法，按推荐顺序：

1. **在 UI 里打开目标目录**（`工作区 → 更多 → 打开文件夹`），这是 DSH 的正常路径
2. **预置 `workspace.json`**（本文的方法），适合自动化部署
3. 不接受「就用默认工作区」——那是 `Documents` 下的通用目录，任何群里的 agent 都能写

### 一个判断标准

**工作目录应该是一个你愿意让 agent 随便改的地方。**

如果答案是「这是我的项目源码」，就不该让群直接指过去——应该让群指向一个协作目录，源码通过工具按需读写。
