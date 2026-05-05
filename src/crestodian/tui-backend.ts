/* lyc:ai
Crestodian TUI Backend —— 实现OpenClaw的TuiBackend接口，为Crestodian提供交互式终端用户界面
*/
import { randomUUID } from "node:crypto";
import type { SessionsPatchParams, SessionsPatchResult } from "../gateway/protocol/index.js";
import { buildAgentMainSessionKey } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import type {
  ChatSendOptions,
  TuiAgentsList,
  TuiBackend,
  TuiEvent,
  TuiModelChoice,
  TuiSessionList,
} from "../tui/tui-backend.js";
import { runTui as defaultRunTui } from "../tui/tui.js";
import type { CrestodianAssistantPlanner } from "./assistant.js";
import { approvalQuestion, isYes, resolveCrestodianOperation } from "./dialogue.js";
import {
  executeCrestodianOperation,
  isPersistentCrestodianOperation,
  type CrestodianCommandDeps,
  type CrestodianOperation,
} from "./operations.js";
import { formatCrestodianStartupMessage, loadCrestodianOverview } from "./overview.js";

type RunTui = typeof defaultRunTui;

export type CrestodianTuiOptions = {
  yes?: boolean;
  deps?: CrestodianCommandDeps;
  planWithAssistant?: CrestodianAssistantPlanner;
  runTui?: RunTui;
};

type CrestodianHistoryMessage = {
  role: "assistant" | "user";
  content: Array<{ type: "text"; text: string }>;
  timestamp: number;
};

type CaptureRuntime = RuntimeEnv & {
  read: () => string;
};

const CRESTODIAN_AGENT_ID = "crestodian";
const CRESTODIAN_SESSION_KEY = buildAgentMainSessionKey({ agentId: CRESTODIAN_AGENT_ID });

function createCaptureRuntime(): CaptureRuntime {
  const lines: string[] = [];
  return {
    log: (...args) => lines.push(args.join(" ")),
    error: (...args) => lines.push(args.join(" ")),
    exit: (code) => {
      throw new Error(`Crestodian operation exited with code ${String(code)}`);
    },
    read: () => lines.join("\n").trim(),
  };
}

async function loadOverviewForTui(opts: CrestodianTuiOptions) {
  if (opts.deps?.loadOverview) {
    return await opts.deps.loadOverview();
  }
  return await loadCrestodianOverview();
}

function message(role: "assistant" | "user", text: string): CrestodianHistoryMessage {
  return {
    role,
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

function splitModelRef(ref: string | undefined): { provider?: string; model?: string } {
  const trimmed = ref?.trim();
  if (!trimmed) {
    return {};
  }
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash >= trimmed.length - 1) {
    return { model: trimmed };
  }
  return {
    provider: trimmed.slice(0, slash),
    model: trimmed.slice(slash + 1),
  };
}

class CrestodianTuiBackend implements TuiBackend {
  readonly connection = { url: "crestodian local" };

  onEvent?: (evt: TuiEvent) => void;
  onConnected?: () => void;
  onDisconnected?: (reason: string) => void;
  onGap?: (info: { expected: number; received: number }) => void;

  private seq = 0;
  private pending: CrestodianOperation | null = null;
  private handoff: CrestodianOperation | null = null;
  private requestExit: (() => void) | null = null;
  private readonly messages: CrestodianHistoryMessage[] = [];

  constructor(
    private readonly opts: CrestodianTuiOptions,
    welcome: string,
  ) {
    this.messages.push(message("assistant", welcome));
  }

  setRequestExitHandler(handler: () => void): void {
    this.requestExit = handler;
  }

  consumeHandoff(): CrestodianOperation | null {
    const handoff = this.handoff;
    this.handoff = null;
    return handoff;
  }

  start(): void {
    queueMicrotask(() => {
      this.onConnected?.();
    });
  }

  stop(): void {
    // The enclosing TUI owns terminal shutdown; Crestodian has no transport to close.
  }

  // lyc: 发送聊天消息
  async sendChat(opts: ChatSendOptions): Promise<{ runId: string }> {
    const runId = opts.runId ?? randomUUID();
    const text = opts.message.trim();
    this.messages.push(message("user", opts.message));
    void this.respond(runId, opts.sessionKey, text);
    return { runId };
  }

  async abortChat(): Promise<{ ok: boolean; aborted: boolean }> {
    return { ok: true, aborted: false };
  }

  async loadHistory(): Promise<{
    sessionId: string;
    messages: CrestodianHistoryMessage[];
    thinkingLevel: string;
    verboseLevel: string;
  }> {
    return {
      sessionId: "crestodian",
      messages: this.messages,
      thinkingLevel: "off",
      verboseLevel: "off",
    };
  }

  async listSessions(): Promise<TuiSessionList> {
    const overview = await loadOverviewForTui(this.opts);
    const model = splitModelRef(overview.defaultModel);
    return {
      ts: Date.now(),
      path: "crestodian",
      count: 1,
      defaults: {
        model: model.model ?? null,
        modelProvider: model.provider ?? null,
        contextTokens: null,
      },
      sessions: [
        {
          key: CRESTODIAN_SESSION_KEY,
          sessionId: "crestodian",
          displayName: "Crestodian",
          updatedAt: Date.now(),
          thinkingLevel: "off",
          verboseLevel: "off",
          model: model.model,
          modelProvider: model.provider,
        },
      ],
    };
  }

  async listAgents(): Promise<TuiAgentsList> {
    return {
      defaultId: CRESTODIAN_AGENT_ID,
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: CRESTODIAN_AGENT_ID, name: "Crestodian" }],
    };
  }

  async patchSession(opts: SessionsPatchParams): Promise<SessionsPatchResult> {
    const model = splitModelRef(typeof opts.model === "string" ? opts.model : undefined);
    return {
      ok: true,
      path: "crestodian",
      key: CRESTODIAN_SESSION_KEY,
      entry: {
        sessionId: "crestodian",
        displayName: "Crestodian",
        updatedAt: Date.now(),
        ...(model.model ? { model: model.model } : {}),
        ...(model.provider ? { modelProvider: model.provider } : {}),
      },
      resolved: {
        modelProvider: model.provider,
        model: model.model,
      },
    };
  }

  async resetSession(): Promise<{ ok: boolean }> {
    this.pending = null;
    const overview = await loadOverviewForTui(this.opts);
    this.messages.splice(
      0,
      this.messages.length,
      message("assistant", formatCrestodianStartupMessage(overview)),
    );
    return { ok: true };
  }

  async getGatewayStatus(): Promise<string> {
    const overview = await loadOverviewForTui(this.opts);
    return overview.gateway.reachable ? "Gateway reachable" : "Gateway unreachable";
  }

  async listModels(): Promise<TuiModelChoice[]> {
    return [];
  }

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  private emit(event: string, payload: unknown): void {
    this.onEvent?.({
      event,
      payload,
      seq: this.nextSeq(),
    });
  }

  private emitFinal(runId: string, sessionKey: string, text: string): void {
    const assistant = message(
      "assistant",
      text || "Crestodian listened and found nothing to change.",
    );
    this.messages.push(assistant);
    this.emit("chat", {
      runId,
      sessionKey,
      state: "final",
      message: assistant,
    });
  }

  private emitError(runId: string, sessionKey: string, error: unknown): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    this.emit("chat", {
      runId,
      sessionKey,
      state: "error",
      errorMessage,
    });
  }

  // lyc: 处理回复
  private async respond(runId: string, sessionKey: string, text: string): Promise<void> {
    try {
      const reply = await this.resolveReply(text);
      this.emitFinal(runId, sessionKey, reply);
    } catch (error) {
      this.emitError(runId, sessionKey, error);
    }
  }

  // lyc: 解析回复并执行操作, 最后返回结果文本
  private async resolveReply(text: string): Promise<string> {
    // lyc: 若有pending操作, 则先确认用户是否允许执行
    if (this.pending) {
      if (isYes(text)) {
        const pending = this.pending;
        this.pending = null;
        const capture = createCaptureRuntime();
        await executeCrestodianOperation(pending, capture, {
          approved: true,
          deps: this.opts.deps,
        });
        return capture.read() || "Applied. Audit entry written.";
      }
      this.pending = null;
      return "Skipped. No barnacles on config today.";
    }

    const capture = createCaptureRuntime();
    // lyc: 解析用户意图返回明确的操作
    const operation = await resolveCrestodianOperation(text, capture, this.opts);

    // lyc: 若操作是open-tui, 设置handoff=open-tui操作 并退出CrestodianTUI(即当前TUI CrestodianTui)
    // 如果是在runCrestodianTui调用上下文中, 则会切换到用户的AgentTUI(handoff), 在AgentTUI中通过"/crestodian"还能返回CrestodianTUI
    if (operation.kind === "open-tui") {
      this.handoff = operation;
      // lyc: 请求退出CrestodianTUI(即当前TUI CrestodianTui), 在如果是在runCrestodianTui调用上下文中runTui()会返回
      queueMicrotask(() => this.requestExit?.());
      // lyc: 即将打开你的常规代理TUI。在那里使用/crestodian来返回。
      return "Opening your normal agent TUI. Use /crestodian there to come back.";
    }

    // lyc: 若操作是持久性的(config-set/model切换等), 即涉及到系统配置的改变, 暂存到pending，询问用户确认
    if (isPersistentCrestodianOperation(operation) && !this.opts.yes) {
      this.pending = operation;
      await executeCrestodianOperation(operation, capture, {
        approved: false,
        deps: this.opts.deps,
      });
      return [capture.read(), approvalQuestion(operation)].filter(Boolean).join("\n\n");
    }

    // lyc: 若操作不是持久性的, 则直接执行
    await executeCrestodianOperation(operation, capture, {
      approved: this.opts.yes === true || !isPersistentCrestodianOperation(operation),
      deps: this.opts.deps,
    });

    // lyc: 获取执行结果文本
    const reply = capture.read();
    if (operation.kind === "none" && reply.includes("Bye.")) {
      queueMicrotask(() => this.requestExit?.());
    }
    return reply;
  }
}

/* lyc:ai CrestodianTUI入口函数
核心流程:
1. 无限循环(for(;;)): 加载系统概览 → 创建CrestodianTuiBackend → 调用runTui启动TUI
2. 用户输入通过 CrestodianTuiBackend.sendChat()发送聊天 -> this.respond()回应 -> this.resolveReply()处理答复 
CrestodianTuiBackend.resolveReply()处理流程:
   a. 有pending操作: 检查用户是否说"yes"确认 → 执行/跳过
   b. 无pending: 调 resolveCrestodianOperation 解析意图 → executeCrestodianOperation 执行
      - 若操作是open-tui(例如用户说了"talk to agent"等意图): 退出CrestodianTUI(即当前TUI CrestodianTui)后，切换到用户的AgentTUI(handoff) 
          CrestodianTUI是配置管理界面, 使用的是本页实现的CrestodianTuiBackend，作为前端接口
          AgentTUI是用户真正的工作界面, 使用GatewayChatClient|EmbeddedTuiBackend, 作为前端接口
      - 若操作是持久性的(config-set/model切换等): 暂存到pending，询问用户确认
      - 否则直接执行，返回结果文本
3. 会话固定使用"crestodian" agent和session key，消息历史管理在本地的messages[]中

runTui:
runTui 是 OpenClaw 通用 TUI 框架的核心渲染函数。它来自 src/tui/tui.ts ，基于 @mariozechner/pi-tui 库。
它做的事情是：
- 创建一个全屏终端 UI（header + 聊天日志 + 状态栏 + footer + 输入编辑器）
- 接收一个 TuiBackend 作为参数 —— 这个 backend 决定了这个 TUI "跟谁聊天"
- 进入自己的事件循环处理用户输入、联网事件、重连等等
- 只有当内部条件触发 exit 时才会返回 （用户按 Ctrl+C 两次、断连、或者 backend 主动调用 requestExit() ）
你可以把它理解为一个"终端 UI 壳" —— 壳是一样的，但里面装的内容（backend）不同。
*/
export async function runCrestodianTui(
  opts: CrestodianTuiOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  let nextInput: string | undefined;
  for (;;) {
    const overview = await loadOverviewForTui(opts);
    const backend = new CrestodianTuiBackend(opts, formatCrestodianStartupMessage(overview));
    const runTui = opts.runTui ?? defaultRunTui;
    // lyc: 启动TUI, 使用CrestodianTuiBackend作为backend, 即由谁来处理用户输入和输出
    await runTui({
      local: true,
      session: CRESTODIAN_SESSION_KEY,
      historyLimit: 200,
      backend,
      config: {},
      title: "openclaw crestodian",
      ...(nextInput ? { message: nextInput } : {}),
    });

    const handoff = backend.consumeHandoff();
    if (!handoff) {
      return;
    }
    /* lyc: 执行handoff操作, 在当前上下文中一定是open-tui操作, 内部会调用第二个 runTui 来启动AgentTUI
      executeCrestodianOperation()中处理open-tui操作, 会启动一个AgentTUI:
        当用户在 AgentTUI 中输入 /crestodian fix gateway 回车后 触发onSubmit事件:
          因为以"/"开头, 需调用handleCommand()处理, 内部会调用:
            requestExit({
                exitReason: "return-to-crestodian",
                crestodianMessage: "fix gateway"
              }), 
          这会导致AgentTUI退出并返回{exitReason: "return-to-crestodian", crestodianMessage: "fix gateway"},
        executeCrestodianOperation返回{applied: false, nextInput: "fix gateway"}
      因此result = {applied: false, nextInput: "fix gateway"}
      src/tui/tui.ts:
      505行左右: const client: TuiBackend = CrestodianTuiBackend | GatewayChatClient | EmbeddedTuiBackend
      940行左右: const { handleCommand, sendMessage, ... } = createCommandHandlers({ client, ... })
        src\tui\tui-command-handlers.ts:
          616行左右: const sendMessage = async (text: string) => { ... await client.sendChat(...) ... }
                    这里会调用TuiBackend::sendChat()接口
          275行左右: const handleCommand = async (raw: string) => { ... await sendMessage(raw) ... }
                    处理的命令: help, auth, gateway-status, agent, agents, context, crestodian, session, sessions, model, models, think, verbose, trace, fast, reasoning, usage, elevated, activation, new, reset, abort, settings, exit, quit
                    context命令调用openContextModeSelector()(其内部调用了sendMessage()) 或 sendMessage(), 未知命令会调用sendMessage()
          166行左右: openContextModeSelector 方法会调用sendMessage()
      973行左右: submitHandler = createEditorSubmitHandler({ ..., handleCommand, sendMessage, ... })
                createEditorSubmitHandler返回一个函数, 当用户输入以"/"开头时调用handleCommand(), 否则调用sendMessage()
      979行左右: editor.onSubmit = createSubmitBurstCoalescer({ submit: submitHandler, ... });
    */
    const result = await executeCrestodianOperation(handoff, runtime, {
      approved: true,
      deps: opts.deps,
    });
    // lyc: 用户在 AgentTUI 中输入 /crestodian fix gateway 后会推出AgentTUI, result = {applied: false, nextInput: "fix gateway"}
    nextInput = result.nextInput;
    // lyc: 若handoff操作没有传递下一条用户消息, 则直接退出, 
    // lyc: 否则继续循环, 进入CrestodianTui界面处理下一条用户消息
    if (!nextInput?.trim()) {
      return;
    }
  }
}
