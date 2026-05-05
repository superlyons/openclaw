/* lyc:ai
Crestodian核心调度器 —— 由run-main.ts在两种模式下调用:
1. 裸根模式: openclaw → runCrestodian({onReady}) → 交互式TUI
2. 现代引导: openclaw onboard --modern → runCrestodian({message, yes, json, interactive})

runCrestodian内部三条执行路径:
- json模式: 加载系统概览，输出JSON后退出
- message模式: 加载概览→格式化→runOneShot(解析+执行单次命令)
- 默认(交互): 启动runCrestodianTui(TUI后端)进行持续对话
*/
import { stdin as defaultStdin, stdout as defaultStdout } from "node:process";
import { withProgress } from "../cli/progress.js";
import { defaultRuntime, writeRuntimeJson, type RuntimeEnv } from "../runtime.js";
import type { CrestodianAssistantPlanner } from "./assistant.js";
import { resolveCrestodianOperation } from "./dialogue.js";
import {
  executeCrestodianOperation,
  isPersistentCrestodianOperation,
  type CrestodianCommandDeps,
} from "./operations.js";
import {
  formatCrestodianOverview,
  loadCrestodianOverview,
  type CrestodianOverview,
} from "./overview.js";

type CrestodianInteractiveRunner = (
  opts: RunCrestodianOptions,
  runtime: RuntimeEnv,
) => Promise<void>;

export type RunCrestodianOptions = {
  message?: string;
  yes?: boolean;
  json?: boolean;
  interactive?: boolean;
  onReady?: () => void;
  deps?: CrestodianCommandDeps;
  formatOverview?: (overview: CrestodianOverview) => string;
  loadOverview?: typeof loadCrestodianOverview;
  planWithAssistant?: CrestodianAssistantPlanner;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  runInteractiveTui?: CrestodianInteractiveRunner;
};

function crestodianCommandDepsFromOptions(
  opts: RunCrestodianOptions,
): CrestodianCommandDeps | undefined {
  if (!opts.deps && !opts.formatOverview && !opts.loadOverview) {
    return undefined;
  }
  return {
    ...opts.deps,
    ...(opts.formatOverview ? { formatOverview: opts.formatOverview } : {}),
    ...(opts.loadOverview ? { loadOverview: opts.loadOverview } : {}),
  };
}

/* lyc:ai
单次命令执行: 解析用户输入(intent) → 执行对应操作 → 返回结果
调用链: runCrestodian({message:"status"}) → runOneShot
  → resolveCrestodianOperation (dialogue.ts: 先正则匹配，失败则调AI助手)
  → executeCrestodianOperation (operations.ts: 执行具体操作如doctor/status/config-set)
持久性操作(如model切换、config修改)需要用户确认(yes=true或操作已批准)
*/
async function runOneShot(
  input: string,
  runtime: RuntimeEnv,
  opts: RunCrestodianOptions,
): Promise<void> {
  const operation = await resolveCrestodianOperation(input, runtime, opts);
  await executeCrestodianOperation(operation, runtime, {
    approved: opts.yes === true || !isPersistentCrestodianOperation(operation),
    deps: crestodianCommandDepsFromOptions(opts),
  });
}

/* lyc: 执行Crestodian核心调度器 
runCrestodian的执行流程:
1. 若opts.json为true：加载系统概览并输出JSON后退出
2. 若opts.message有值：加载概览→格式化输出→执行单次命令（runOneShot）
    runOneShot内部：先调resolveCrestodianOperation解析用户意图
    (src/crestodian/dialogue.ts)，如果解析失败则调用AI助手规划器
    (src/crestodian/assistant.ts::planCrestodianCommand)，
    最后调用executeCrestodianOperation执行操作
    (src/crestodian/operations.ts)
3. 否则（裸根模式默认路径）：启动交互式TUI
    (src/crestodian/tui-backend.ts::runCrestodianTui)
    TUI后端基于OpenClaw的通用TUI框架(src/tui/tui.ts)
    会话固定使用"crestodian" agent和"crestodian" session key
*/
export async function runCrestodian(
  opts: RunCrestodianOptions = {},
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  /* lyc:ai
  路径1: JSON模式 - 加载系统概览(配置/Agent/网关/工具链)，以JSON格式输出后退出
  用于 --json 标志场景，例如 openclaw onboard --modern --json
  */
  if (opts.json) {
    // lyc: loadCrestodianOverview(): 加载系统概览(配置/Agent/网关/工具链)
    const overview = await (opts.loadOverview ?? loadCrestodianOverview)();
    writeRuntimeJson(runtime, overview);
    return;
  }

  /* lyc:ai
  路径2: 单次消息模式 - 有message参数时，先显示系统概览，再处理用户命令
  用于 openclaw crestodian --message "status" 或 openclaw onboard --modern --non-interactiv(此时message="overview") 场景
  流程: 加载概览(带进度条) → 格式化输出概览 → runOneShot()解析并执行命令
  */
  if (opts.message?.trim()) {
    const overview = await withProgress(
      {
        label: "Loading Crestodian overview…",
        indeterminate: true,
        delayMs: 0,
        fallback: "none",
      },
      async () => await (opts.loadOverview ?? loadCrestodianOverview)(),
    );
    // lyc: 以文本方式格式化输出关键的系统概览(loadCrestodianOverview()返回的overview)
    runtime.log((opts.formatOverview ?? formatCrestodianOverview)(overview));
    runtime.log("");
    await runOneShot(opts.message, runtime, opts);
    return;
  }

  /* lyc:ai
  路径3: 交互式TUI模式 - 加载完整的Crestodian对话界面
  默认路径，裸根模式 `openclaw` 和 现代引导交互模式(不带其他参数的) `openclaw onboard --modern` 都走这里 
  TUI后端实现: tui-backend.ts::runCrestodianTui
  基于OpenClaw通用TUI框架 src/tui/tui.ts
  */
  const interactive = opts.interactive ?? true;
  const input = opts.input ?? defaultStdin;
  const output = opts.output ?? defaultStdout;
  const inputIsTty = (input as { isTTY?: boolean }).isTTY === true;
  const outputIsTty = (output as { isTTY?: boolean }).isTTY === true;
  if (!interactive || !inputIsTty || !outputIsTty) {
    runtime.error("Crestodian needs an interactive TTY. Use --message for one command.");
    return;
  }

  const runInteractiveTui =
    opts.runInteractiveTui ?? (await import("./tui-backend.js")).runCrestodianTui;
  // lyc: 加载完成, 停止进度条
  opts.onReady?.();
  // lyc: 运行交互式TUI界面
  await runInteractiveTui(opts, runtime);
}
