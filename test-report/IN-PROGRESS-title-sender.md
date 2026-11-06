# 当前进度：标题加入「谁」（代码完成，未验证未提交）

**时间**：2026-11-06 09:35
**目标**：改进人工确认卡片的 UE —— 标题一句话说清「谁要你做什么」

---

## 代码状态

### `lib/dsh/human-confirm.js`

标题改为带发送者名字：

```js
question: who === '' ? '发出这条回复？' : `回复 ${who}？`,
```

同时删掉了因此变成死变量的 `threadPhrase`（已确认无引用）。

### `lib/dsh/human-confirm.js` 说明注释

更新为：

```
header    which group       a place, not a sentence
question  who + what        「回复 张三？」 — one line, names the person
detail    the draft         quoted verbatim, the seq, and what each choice does
```

### `test/human-confirm.test.mjs`

那条 `the title names the sender when it is known` 已改：

- `assert.equal(question, '回复 张三？')`
- 长度上限 7 → 10

---

## 为什么现在放得下名字

| 构造 | headerActions | 标题区 | 结果 |
|---|---|---|---|
| `askTimed` | 241px | 43px | 「回复 张三？」换行成 3 行 |
| `ask()` | 52px | 112px+ | 「发出这条回复？」一行且有余量（见 s33 截图） |

0.1.14 已经从 `askTimed` 切到 `ask()`，但标题仍是旧的「发出这条回复？」——
这一轮才把名字加回去。

---

## 阻塞：这台机器无法启动任何进程

实测全部卡住不返回：

- `"ok"` / `"alive"` 这种字符串命令
- `exit 0`
- `bash.exe`

只有 DSH 自己的文件读写工具正常。

**原因推测**：之前累积的浏览器会话（c3、ue3–ue7、fin、cmp、pr、prf）、若干 3096 实例反复重启，
把进程/内存资源耗尽了。

**没做**：跑测试、部署、截图验证、提交、发版。

---

## 恢复后按顺序做

1. 清掉多余 chrome / node 进程
2. `node node_modules/vitest/vitest.mjs run --no-file-parallelism`
3. 部署 3096，弹一次卡片，截图确认标题是「回复 张三？」且占一行
4. 提交
5. 发 0.1.16
6. 更新 `test-report/UE-CARD-FINAL.md`，把「标题不能带名字」的旧结论改掉

---

## 注意

`test-report/UE-CARD-FINAL.md` 里有一段写着「标题区只有 112px ≈ 7 个汉字，任何带人名的
标题都会换行」—— 这个结论当时是错的（112px 是窄卡片下的测量，且当时没有真测带名字的标题）。
恢复后要用真实截图替换这段。
