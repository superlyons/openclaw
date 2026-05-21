<!-- doc-version: v2026.5.18 -->
<!-- last-verified: 2026-05-21 -->

# OpenClaw 学习文档

这是一份**为程序员从零开始学习 OpenClaw 源码**而写的内部机制文档，配合 [`.ai_claude/progress.md`](../progress.md)（个人学习进度）一起使用。

**重要前提**：本文档的读者 lyc**从未运行过 OpenClaw**，纯靠读源码学习。因此：
- 每个抽象概念都配**具体例子**（命令输入 + 预期输出 / 行为）
- **不假设**读者跑过任何 openclaw 命令
- 涉及命令行为时，明确标注"根据代码推断"或"假设你跑了 X，会看到 Y"

详细规约见 [`_meta/doc-conventions.md`](_meta/doc-conventions.md)。

## 文档分层

| 层 | 目录 | 我们写的内容 |
|---|---|---|
| L1 用户视角 | [`10-usage/`](10-usage/) | **不复制**官方文档，只放链接索引 |
| L2 全景概念 | [`00-overview/`](00-overview/) | 一句话定位、术语表、代码库地图 |
| L3 内部机制 ★ | [`20-mechanism/`](20-mechanism/) | **本文档核心**——每个核心模块的流程、概念、源码追踪 |
| L4 深度专题 | [`30-deep-dive/`](30-deep-dive/) | 特定难点的独立专题 |

## 文档索引

### 00-overview/ 总览

- [ ] [`what-is-openclaw.md`](00-overview/what-is-openclaw.md) — OpenClaw 一句话定位 + 核心概念
- [ ] [`codebase-map.md`](00-overview/codebase-map.md) — `src/` 60+ 子目录分类
- [ ] [`glossary.md`](00-overview/glossary.md) — 术语表（Crestodian / ACP / Channel / Agent 等）

### 10-usage/ 使用层

- [ ] [`_index.md`](10-usage/_index.md) — 链接到 docs.openclaw.ai 的索引

### 20-mechanism/ 内部机制 ★

- [x] [`01-startup-flow.md`](20-mechanism/01-startup-flow.md) — **启动流程**：从 `npm run dev` 到命令分发
- [ ] [`02-cli-routing.md`](20-mechanism/02-cli-routing.md) — CLI 路由：3 层快速路径 + Commander 慢路径
- [ ] [`03-plugin-system.md`](20-mechanism/03-plugin-system.md) — 插件系统
- [ ] [`04-channel-architecture.md`](20-mechanism/04-channel-architecture.md) — Channel 抽象与适配器
- [ ] [`05-agent-runtime.md`](20-mechanism/05-agent-runtime.md) — Agent 运行时
- [ ] [`06-message-flow.md`](20-mechanism/06-message-flow.md) — 消息端到端流转
- [ ] [`07-config-system.md`](20-mechanism/07-config-system.md) — 配置加载与验证
- [ ] [`08-gateway.md`](20-mechanism/08-gateway.md) — 网关

（更多按学习进度添加）

### 30-deep-dive/ 深度专题

按需添加。例如：
- `compile-cache-respawn.md` — v2026.5 新增的 compile-cache 守卫机制详解
- `fast-path-tiers.md` — 3 层快速路径的设计动机与边界

## 重要

- [`_meta/doc-conventions.md`](_meta/doc-conventions.md) — 文档规约（版本戳、Mermaid 风格、源码链接格式、"抽象概念→例子"模板）
- [`_meta/update-protocol.md`](_meta/update-protocol.md) — 如何让 Claude 更新/重建文档

## 状态约定

文档前的复选框：
- `[x]` — 已完成、已验证
- `[ ]` — 待写或待补
