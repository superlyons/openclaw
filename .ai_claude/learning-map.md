# OpenClaw 代码库地图（学习视角）

> 目的：把 60+ 个 `src/` 子目录分类，让用户知道**哪些必读、哪些可以暂时跳过**。
> 这是给程序员学习用的视角，**不是架构文档**。

## 一句话定位 OpenClaw

> 一个跑在用户自己设备上的"个人 AI 助手"。它把各种聊天平台（WhatsApp / Telegram / Slack / Discord / iMessage / WeChat 等 20+）作为"通道"接入，用户在自己常用的聊天软件里和 AI 对话。Gateway（网关）只是控制平面，**产品本身是这个助手**。

来源：`README.md` 顶部段落 + `VISION.md`。

## 三层分类

### 第 1 层：产品本体（**优先读**）

| 目录 | 大致职责 |
|---|---|
| `src/channels/` | 各聊天平台适配器（WhatsApp/Telegram/Slack…）—— "通道" 抽象的实现 |
| `src/agents/` | Agent 模型（助手本身的"大脑"） |
| `src/chat/` | 对话流程 |
| `src/flows/` | 多步业务流程 |
| `src/gateway/` | 消息网关（控制平面） |
| `src/routing/` | 消息路由：决定哪条消息交给哪个 agent / channel |
| `src/plugins/` | 插件系统（OpenClaw 的扩展机制） |
| `src/commands/` | 助手能执行的"命令" |

### 第 2 层：能力模块（**按兴趣读**）

| 目录 | 大致职责 |
|---|---|
| `src/canvas-host/` | "Canvas" 渲染（README 提到的实时 UI） |
| `src/tts/` `src/realtime-voice/` `src/realtime-transcription/` | 语音相关 |
| `src/image-generation/` `src/media-generation/` `src/media/` `src/video-generation/` `src/music-generation/` `src/media-understanding/` | 多模态生成与理解 |
| `src/web-search/` `src/web-fetch/` `src/link-understanding/` | 联网能力 |
| `src/memory/` `src/memory-host-sdk/` | 长期记忆 |
| `src/mcp/` | Model Context Protocol 集成 |
| `src/context-engine/` | 上下文管理 |
| `src/wizard/` `src/crestodian/` | 引导式安装（`openclaw onboard`） |
| `src/tasks/` `src/cron/` | 任务/定时 |
| `src/secrets/` `src/security/` | 凭证 / 安全 |
| `src/auto-reply/` | 自动回复 |

### 第 3 层：脚手架 / 基础设施（**用户当前在这里——优先级最低**）

| 目录 | 大致职责 |
|---|---|
| `src/cli/` | 命令行处理（argv、profile、容器路由等大量管道代码，131 个非测试文件） |
| `src/infra/` | 环境检测、路径解析、host env 安全检查等 |
| `src/config/` | 配置加载、校验、env 替换、legacy 兼容 |
| `src/bootstrap/` | 启动流程 |
| `src/entry.ts` | 进程入口 |
| `src/logging/` | 日志 |
| `src/process/` | 进程管理 |
| `src/i18n/` | 国际化 |
| `src/shared/` `src/utils/` `src/types/` `src/globals.ts` | 工具与类型 |
| `src/test-helpers/` `src/test-utils/` | 测试辅助 |
| `src/compat/` | 向后兼容 |
| `src/hooks/` | 进程钩子 |
| `src/bindings/` | 平台/原生绑定 |
| `src/sessions/` | 会话状态 |
| `src/daemon/` `src/node-host/` | 后台/宿主 |
| `src/docs/` | 内嵌文档 |
| `src/markdown/` | Markdown 处理 |
| `src/status/` | 状态显示 |
| `src/terminal/` `src/tui/` | 终端 UI |
| `src/pairing/` | 设备配对 |
| `src/proxy-capture/` | 代理抓包（调试用？） |
| `src/trajectory/` | 轨迹/调用历史记录 |
| `src/model-catalog/` | 模型目录 |
| `src/plugin-sdk/` | 插件 SDK |
| `src/acp/` | （ACP 协议？需进一步确认） |
| `src/web/` `src/channel-web.ts` | Web 通道 |
| `src/interactive/` | 交互式 |
| `src/scripts/` | 内嵌脚本 |
| `src/docker-*.test.ts` | Docker 集成测试 |

## 推荐的"垂直切片"阅读路线

### 路线 A：理解一条消息怎么走完全程（**推荐**）

> 跟一条用户消息从外部聊天平台进来 → 经过 channel → routing → agent → 回到 channel 的完整路径。

1. 先看 `src/channels/` 里**任选一个简单的 channel**（建议 `irc` 或 `discord`，避开 `whatsapp`/`imessage` 这类复杂的）。
2. 找到 channel 的"接收消息"入口（grep `onMessage` / `handleIncoming` 之类）。
3. 跟到 `src/routing/` 看路由决策。
4. 跟到 `src/agents/` 看 agent 如何处理。
5. 回到 channel 看回复怎么发出去。

### 路线 B：理解插件系统

1. 读 `src/plugins/` 的入口（看 `discovery.ts`、`config-state.ts`、`registry`）
2. 读一个 bundled plugin（在 `packages/` 或 `src/plugins/bundled-dir.ts` 指向的目录）
3. 看 plugin 怎么注册 CLI 命令、怎么注册 channel

### 路线 C：理解 `openclaw onboard`（用户第一次实际使用的命令）

1. `src/wizard/` + `src/crestodian/`
2. 这条线和 README 的"推荐入门方式"完全对应，最贴近用户视角

## 给学习者的几条建议

1. **不要追测试文件**（`*.test.ts`、`__openclaw_vitest__/`）—— 它们是验证而非主流程。
2. **`*.conflict.202632.20260415.bk.ts` 全部忽略**—— 这是仓库里的合并冲突备份，不是源码。
3. **看到 `lyc:ai` / `lyc:` 注释**就是用户自己加的中文学习笔记，可以放心修改/补充。
4. **抗拒"再多读一个 import 就懂了"的诱惑**—— 大型项目里这是无底洞。
5. **看不懂的名字（Crestodian / ACP / Swabble）就直接问**—— 这些是项目特有词汇，文档可能比代码更快给答案。
