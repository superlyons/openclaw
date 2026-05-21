# 阅读进度

> 最近更新：2026-05-20（合并到 v2026.5.18 之后）

## ⚠️ 重要：分支已升级到 v2026.5.18

**当前分支**：`study-base-v2026.5.18`（从 `v2026.5.18` tag 出发，合并了 `study-base-v2026.4.26` 的笔记）

**已 push 到 origin**：`git@github.com:superlyons/openclaw.git`

**注释保留情况**：
- 主流程文件（entry.ts、run-main.ts、route.ts 等）—— 笔记基本完整保留，标注了 v2026.5 的所有改动点
- 9 个大重构文件 —— 你的 4.26 版注释快照在 `.ai_claude/snapshots/`，对照阅读
- 3 个被删除函数 —— 注释存档在 `.ai_claude/orphaned-comments.md`

**对学习的影响**：之前规划读的 `run-main.ts 327-460` 行号已经变了（v2026.5 加了 trace、gateway-run 快速路径等），需要重新对位。

## 当前调用栈（v2026.5.18 版本）

```
npm run dev
  └─ scripts/run-node.mjs                       [已读 4.26 版主线；5.18 用 startupTrace 包了计时]
       └─ src/entry.ts                          [已读完，含 v2026.5 改动注释]
            ├─ [v2026.5 新] compile-cache respawn 守卫
            ├─ tryHandleRootVersionFastPath     [L1：--version]
            ├─ tryHandleRootHelpFastPath        [L2：根 --help]
            └─ src/cli/run-main.ts (runCli)     [已读到 L3 调用点]
                 ├─ [v2026.5 新] tryRunGatewayRunFastPath  [gateway-run 专用快速路径]
                 ├─ [v2026.5 新] bootstrapCliProxyCaptureAndDispatcher  [代理引导抽出来]
                 ├─ tryRouteCli                            [L3：13 个轻量命令]
                 │    └─ src/cli/route.ts                  [已读完]
                 └─ Commander 主流程 (慢路径)               [⬅ 待读]
                      └─ src/cli/program.ts (buildProgram) [⬅ 主线核心]
                           └─ program/routes.ts (findRoutedCommand) [配对补完]
```

## 用户当前学习策略（2026-05-18 校准）

**只读启动主线，不深入 helpers**。读完后进入垂直切片 A→B→C。

明确的纪律：
- 18 个顶部 import 不展开，只在本文件"已识别 helpers"区记一句话
- 好奇某个 helper 时，写进"未解之谜"区，**不要立刻追下去**
- 例外：`buildProgram` **必须**展开看实现，是主线核心

## 注释约定（已验证）

- `// lyc:` 或 `// lyc: ...` — **用户本人加的中文笔记**（高频、行内、零散；src/ 中 154 个文件）
- `/* lyc:ai ... */` — **另一个 AI 工具自动加的**（集中、多行块、语气教科书化；src/ 中 19 个文件）
- `// lyc:aic` 或 `/* lyc:aic ... */` — **Claude（本助手）加的**学习洞察 / 全局视角注释

**插入策略（重要）**：`lyc:aic` 注释**只新增独立行，绝不修改任何已有行**——为了让用户以后从官方 upstream 拉新代码时冲突最小。新增位置一般紧贴被注释的代码上方。

未来 Claude 不要把 `lyc:ai` 当成用户的话，也不要"自动总结"成新的 `lyc:ai` 块——这是另一个工具的痕迹。
新增 Claude 自己的注释**必须**用 `lyc:aic` 前缀，与 `lyc:ai` 区分。

## 已读完文件

1. `scripts/run-node.mjs`（1133 行，146 处 `lyc:` 注释）—— Node 运行入口、watch、build 触发、runtime post-build
2. `src/entry.ts`（258 行，26 处 `lyc:`）—— 进程入口；顶层 if/else 块就是入口逻辑（无 main 函数）；包含 respawn 机制 + L1/L2 快速路径
3. `src/cli/run-main.ts` lines 1-323（35 处 `lyc:`，16 处 `lyc:ai`）—— CLI 主入口前半段；停在 `tryRouteCli` 调用点
4. `src/cli/route.ts`（85 行）—— `tryRouteCli` 定义；快速路径分发逻辑

## 已嵌入代码的 `lyc:aic` 注释（备份索引，便于以后清理或迁移）

| 文件 | 位置 | 内容 |
|---|---|---|
| `src/entry.ts` | 顶部（const 之前） | 4 阶段骨架 + 3 层快速路径梯队总览 |
| `src/entry.ts` | `ensureCliRespawnReady` 函数上方 | Respawn 机制本质 + 两个 node 进程现象 |
| `src/entry.ts` | `tryHandleRootVersionFastPath` 调用前 | L1 快速路径标签 |
| `src/entry.ts` | `tryHandleRootHelpFastPath` 函数前 | L2 快速路径标签 |
| `src/entry.ts` | `runCli` 调用前 | 移交到 run-main.ts 的注解 |
| `src/cli/run-main.ts` | `tryRouteCli` import 前 | L3 快速路径标签 |
| `src/cli/run-main.ts` | `createCliProgress` import 前 | 慢路径起点分隔条 + 5 步骤 |
| `src/cli/route.ts` | `tryRouteCli` 函数前 | L3 总览 + OPENCLAW_DISABLE_ROUTE_FIRST 开关 |

## 启动主线的关键架构认识

**3 层快速路径梯队**（都为绕开 Commander 加载）：
- L1 `tryHandleRootVersionFastPath` (entry.ts:193) — `--version` / `-v`
- L2 `tryHandleRootHelpFastPath` (entry.ts:200) — 根级 `--help`
- L3 `tryRouteCli` (run-main.ts:301) — 13 个轻量命令（health/status/sessions/...）
- 3 层都没命中 → 进 `buildProgram` 慢路径

**Respawn 机制**（entry.ts:108-146）：
- 某些 Node flag（`--max-old-space-size` 等）必须启动时传，运行时无法设置
- 需要时 spawn 子进程，**父进程退出**
- 结果：`npm run dev` 实际跑两个 node 进程，父是短命启动器
- `attachChildProcessBridge` 把信号从父透传给子

**Profile/Container 对称**：
- 两者都在 Commander 看到 argv 前先消化掉相关 flag
- `--profile` / `--dev` → 改 env、改 argv、当前进程继续
- `--container` → 把进程整个搬进 Docker；与 profile 互斥

## 主线已知的快速路径命令（来自 `tryRouteCli`）

走 `tryRouteCli` 快速路径，**不加载完整 Commander**：
health · status · gateway-status · sessions · agents-list · config-get · config-unset · models-list · models-status · tasks-list · tasks-audit · channels-list · channels-status

其他所有命令 → 走 `run-main.ts` line 327+ 的慢路径（Commander）。

## 剩余主线（按读的顺序）

1. **`run-main.ts` line 327-460**（~130 行）—— 5 步骤：enableConsoleCapture → buildProgram → 错误处理 → 命令注册（core/subcli/plugin）→ `program.parseAsync`
2. **`src/cli/program.ts`** —— `buildProgram` 实现，**主线核心，必须展开**
3. **`src/cli/program/routes.ts`** —— `findRoutedCommand`，补完 tryRouteCli 的另一半
4. **`run-main.ts` 顶部 18 个 import** —— 不展开，"已识别 helpers"区记一句话足够

## 已识别但未深入的 helpers（待补一句话表）

> 格式：`文件 — 一句话职责 — 何时被调用`

- `src/cli/argv-invocation.ts` (`resolveCliArgvInvocation`) — 解析 argv 得到 commandPath/primary/hasHelpOrVersion — `tryRouteCli` 开头 + 主流程
- `src/cli/argv.ts` (`hasFlag`) — 检测 argv 是否含某个 flag — route.ts
- `src/cli/command-execution-startup.ts` — 启动策略 + banner 展示 + 引导完成 — `prepareRoutedCommand`
- `src/cli/program/routes.ts` (`findRoutedCommand`) — 在路由表里找匹配的快速路径命令 — `tryRouteCli`
- `src/cli/run-main-policy.ts` — 各种"是否应该 X"的策略函数 — `run-main.ts` 多处
- `src/cli/command-registration-policy.ts` — 主命令注册策略 — `run-main.ts` line 390/406
- `src/cli/profile.ts` — CLI profile env 处理 — `run-main.ts` 顶部
- `src/cli/container-target.ts` — 容器路由 — `run-main.ts` 顶部
- `src/cli/windows-argv.ts` — Windows argv 规范化 — `run-main.ts` 顶部
- `src/infra/runtime-guard.ts` — Node 运行时版本守卫 — `run-main.ts` 顶部
- `src/infra/path-env.ts` — 确保 CLI 在 PATH 中 — `run-main.ts` 顶部
- `src/infra/env.ts` (`normalizeEnv`, `isTruthyEnvValue`) — 环境变量工具 — 多处
- `src/infra/is-main.ts` (`isMainModule`) — 判断当前是不是被直接运行 — `isCliMainModule`
- `src/config/paths.ts` (`resolveStateDir`) — `~/.openclaw` 状态目录解析 — dotenv 加载
- `src/plugins/memory-state.ts` / `memory-runtime.ts` — 内存运行时管理 — `closeCliMemoryManagers`
- `src/proxy-capture/runtime.ts` / `coverage.ts` — HTTP 代理捕获（调试用） — `run-main.ts` 中段
- `src/version.ts` — VERSION 常量 — banner / route.ts
- `src/plugins/manifest-command-aliases.runtime.ts` — 插件清单命令别名解析 — 错误消息构造

## 未解之谜（不要立即追，留给垂直切片）

- 插件命令的 lazy 注册 vs eager 注册的差异（`mode: "lazy"`）
- `applyCliProfileEnv` 究竟改了哪些 env？
- `maybeRunCliInContainer` 在什么场景下真的把进程挪进容器？
- Crestodian 是什么（README 提到 onboard，代码里又叫 crestodian）？
- `subcli` 这个概念——某些命令是独立子 CLI？

## 仓库异常状态

- 大量 `*.conflict.202632.20260415.bk.ts` 备份文件遍布 `src/`，是合并/rebase 残留。**别 commit**，建议加入 `.gitignore` 或清理。
- 当前分支 `study-base-v2026.4.26`（学习用）

## 下次会话开场建议

按以下顺序推进，不深入：

1. 读 `run-main.ts` 327-460 —— Commander 主流程的 5 步骤
2. 读 `src/cli/program.ts` —— **buildProgram 必须展开**
3. 读 `src/cli/program/routes.ts` —— `findRoutedCommand`
4. 给 `run-main.ts` 顶部 18 个 import 各补一句话进"已识别 helpers"区

完成后：进入 **垂直切片 A**（参见 `learning-map.md`）。
