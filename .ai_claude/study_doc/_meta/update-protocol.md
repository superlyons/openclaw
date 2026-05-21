<!-- doc-version: v2026.5.18 -->
<!-- last-verified: 2026-05-21 -->

# 文档更新协议

如何让 Claude 在未来的会话里**精准更新**这些文档。

---

## 三种典型场景

### 场景 1：你读某篇文档时不懂

**说**："我读 `20-mechanism/01-startup-flow.md` 时不明白 respawn 机制"

**Claude 做**：
1. 读这篇文档的"Respawn"小节
2. 找到原始源码（看文档头 `source-anchors`）
3. 重写这一节：补充更多例子、更细的步骤、或者改换比喻
4. **不动其他章节**
5. 更新 `last-verified` 日期

### 场景 2：升级到新版本

**说**："分支升级到 v2026.6.0 了，所有文档同步一下"

**Claude 做**：
1. `git diff v2026.5.18..v2026.6.0` 看官方代码改动
2. 列出每篇文档的 `source-anchors`，与改动文件取交集
3. **只更新有交集的文档**：
   - 把文档里描述的代码行为对照新版改对
   - 把 `doc-version` 更新到新 tag
   - 把 `last-verified` 更新到今天
4. **没受影响的文档**只更新 `last-verified`（如果还有效），或维持不动
5. 给出报告："X 篇被改、Y 篇 last-verified 推后、Z 篇与新版无关"

### 场景 3：你想新加一篇

**说**："给 `src/channels/` 的 channel 抽象写一篇"

**Claude 做**：
1. 看 `_meta/doc-conventions.md` 拿规约
2. 读 `src/channels/` 主要文件
3. 在 `20-mechanism/` 下新建文件，编号续上（如 `04-channel-architecture.md`）
4. 写完后更新 `README.md` 索引（把 `[ ]` 改 `[x]`）

---

## 文档元信息字段速查

```markdown
<!-- doc-version: v2026.5.18 -->
<!-- last-verified: 2026-05-21 -->
<!-- source-anchors: src/cli/run-main.ts, src/entry.ts -->
<!-- reading-order: after 00-overview/what-is-openclaw.md -->
```

| 字段 | 作用 | 谁更新 |
|---|---|---|
| `doc-version` | 文档基于哪个 OpenClaw 版本写的 | Claude 在升级时更新 |
| `last-verified` | 最后一次核对源码的日期 | Claude 每次实质性修改时更新 |
| `source-anchors` | 这篇文档主要追踪的源码文件 | Claude 写文档时填，升级时用来定位影响 |
| `reading-order` | 应该先读哪篇（建立前置依赖） | Claude 写文档时填 |

---

## Claude 更新文档时的纪律

1. **保持版本戳一致**：每次实质性修改后，更新 `last-verified`。版本升级时更新 `doc-version`。

2. **不要"全文重写"**：除非用户明确说"重写整篇"。
   - 不懂 → 改不懂的那节
   - 错了 → 改错的那段
   - 升级 → 改受影响的那部分

3. **保持文档间链接有效**：移动文件或重命名时，必须 grep 引用并同步更新。

4. **不要在示例里编造命令输出**：
   - 凡是 stdout/stderr，**必须**从源码里找到对应的 `console.log` / `runtime.error` 等再写
   - 如果代码没法直接看出输出，标 "**未验证**"
   - 这条规约的根据：[memory:feedback-docs-must-have-concrete-examples](../../../C:\Users\lyons\.claude\projects\E--ai-agent-openclaw-source-code-myfork-openclaw\memory\feedback_docs_must_have_concrete_examples.md)

5. **README.md 是入口**：任何新增 / 删除 / 重命名文档，都要同步更新 `study_doc/README.md` 索引。

---

## 触发用语模板（给 lyc 速查）

| 你想做什么 | 怎么跟 Claude 说 |
|---|---|
| 重写某节 | "重写 study_doc/20-mechanism/01-startup-flow.md 的 X 节，我看不懂" |
| 加更多例子 | "study_doc/20-mechanism/01-startup-flow.md 的 X 节例子不够，再加 2 个" |
| 改图 | "study_doc/.../X.md 的 Mermaid 图改成 Discord 为例" |
| 新加文档 | "给 src/<目录> 写一篇 mechanism 文档" |
| 升级 | "分支升级到 v2026.x.y，所有 study_doc 跟着同步" |
| 验证文档 | "把 X.md 的所有源码引用跑一遍，看还对不对" |
