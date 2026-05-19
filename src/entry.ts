#!/usr/bin/env node
import { spawn } from "node:child_process";
import { enableCompileCache } from "node:module";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isRootHelpInvocation } from "./cli/argv.js";
import { parseCliContainerArgs, resolveCliContainerTarget } from "./cli/container-target.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./cli/profile.js";
import { normalizeWindowsArgv } from "./cli/windows-argv.js";
import { buildCliRespawnPlan } from "./entry.respawn.js";
import { tryHandleRootVersionFastPath } from "./entry.version-fast-path.js";
import { isTruthyEnvValue, normalizeEnv } from "./infra/env.js";
import { isMainModule } from "./infra/is-main.js";
import { ensureOpenClawExecMarkerOnProcess } from "./infra/openclaw-exec-env.js";
import { installProcessWarningFilter } from "./infra/warning-filter.js";
import { attachChildProcessBridge } from "./process/child-process-bridge.js";

/* lyc:aic
entry.ts 主线骨架（4 阶段；本文件无 main 函数，顶层 if/else 块即入口逻辑）：
  [1] isMainModule 守卫 (line 52)        防 bundler 重复启动
  [2] 进程级初始化     (line 73-100)     title/env/警告/编译缓存
  [3] Respawn 分支     (line 156)        必要时 spawn 新 node 子进程，父进程退出
  [4] 参数解析+路由    (line 160-196)    container/profile → version/help 快速路径 → runCli

3 层快速路径梯队（都为绕开 Commander 加载）：
  L1 tryHandleRootVersionFastPath  (本文件 line 193)         `--version` / `-v`
  L2 tryHandleRootHelpFastPath     (本文件 line 200)         根级 `--help`
  L3 tryRouteCli                   (src/cli/run-main.ts:301) 13 个轻量命令
  3 层都没命中 → 进 buildProgram 慢路径 (src/cli/program.ts)
*/
// lyc: 定义了包装器文件与实际入口文件的映射关系, openclaw.mjs 和 openclaw.js 是包装器，它们会导入 entry.js, 这样 isMainModule 可以正确识别主入口文件
const ENTRY_WRAPPER_PAIRS = [
  { wrapperBasename: "openclaw.mjs", entryBasename: "entry.js" },
  { wrapperBasename: "openclaw.js", entryBasename: "entry.js" },
] as const;

/* lyc:
检查是否强制只读认证存储
检测是否执行 openclaw secrets audit 命令
# 运行: openclaw secrets audit
# argv = ["node", "openclaw.mjs", "secrets", "audit"]
# tokens = ["secrets", "audit"]
# 返回 true，设置只读模式
*/
function shouldForceReadOnlyAuthStore(argv: string[]): boolean {
  const tokens = argv.slice(2).filter((token) => token.length > 0 && !token.startsWith("-"));
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index] === "secrets" && tokens[index + 1] === "audit") {
      return true;
    }
  }
  return false;
}

// Guard: only run entry-point logic when this file is the main module.
// The bundler may import entry.js as a shared dependency when dist/index.js
// is the actual entry point; without this guard the top-level code below
// would call runCli a second time, starting a duplicate gateway that fails
// on the lock / port and crashes the process.
/* lyc: isMainModule 检查
保护：仅当此文件作为主模块时，才运行入口点逻辑。
当dist/index.js是实际入口点时，打包器可能会将entry.js作为共享依赖导入；
如果没有这个保护措施，下面的顶级代码会再次调用runCli，从而启动一个在锁/端口上失败的重复网关，并导致进程崩溃。
*/
if (
  !isMainModule({
    currentFile: fileURLToPath(import.meta.url),
    wrapperEntryPairs: [...ENTRY_WRAPPER_PAIRS],
  })
) {
  /* lyc: 本文件当前是作为模块被导入的
    # 某个文件中: import { someFunction } from './entry.ts'
    # isMainModule 返回 false
    # 不执行 else 块中的代码
    */
  // Imported as a dependency — skip all entry-point side effects.
  // lyc: 如果作为依赖导入，跳过所有入口点副作用效果。
} else {
  // lyc: 当前是作为主模块被执行的
  /* lyc: 例如: node openclaw.mjs arg1 arg2 arg3
    run dev命令会执行 node scripts/run-node.mjs, 
    run-node.mjs中的runOpenClaw()函数内部会使用spawn执行node openclaw.mjs arg1 arg2 arg3
    openclaw.mjs会通过tryImport("./dist/entry.js")导入await import("./dist/entry.js")即本文件src/entry.ts
    */
  // lyc: 设置进程标题为 openclaw
  process.title = "openclaw";
  // lyc: 确保在当前进程环境中设置 OPENCLAW_CLI 环境变量 env.OPENCLAW_CLI = "1"
  ensureOpenClawExecMarkerOnProcess();
  // lyc: 安装自定义的警告过滤器
  installProcessWarningFilter();
  // lyc: 规范环境变量
  normalizeEnv();
  // lyc: 启用编译缓存（性能优化）: env.NODE_DISABLE_COMPILE_CACHE=false
  if (!isTruthyEnvValue(process.env.NODE_DISABLE_COMPILE_CACHE)) {
    try {
      // lyc: Node.js 22+ 的特性, 缓存编译后的代码，加快启动速度, 如果失败不影响程序运行（catch 块）
      enableCompileCache();
    } catch {
      // Best-effort only; never block startup.
      // lyc: 仅尽最大努力；绝不阻碍启动。
    }
  }
  // lyc: 处理特殊环境变量
  // lyc: secrets audit 命令设置只读模式
  if (shouldForceReadOnlyAuthStore(process.argv)) {
    process.env.OPENCLAW_AUTH_STORE_READONLY = "1";
  }

  // lyc: 禁用彩色输出
  if (process.argv.includes("--no-color")) {
    process.env.NO_COLOR = "1";
    process.env.FORCE_COLOR = "0";
  }

  /* lyc:aic
  Respawn 机制的本质：
  某些 Node flag（--max-old-space-size / --no-warnings 等）必须**启动时**
  传给 node 可执行文件，运行时无法动态设置。需要时就 spawn 一个带正确 flag
  的新 node 子进程，父进程退出。

  实际后果：`npm run dev` 启动后会看到**两个 node 进程**——父进程是短命启动器，
  子进程才是真正跑 CLI 的。attachChildProcessBridge 负责把外部信号（Ctrl-C 等）
  从父进程透传给子进程。
  */
  /* lyc:ai
  确保CLI重启动准备就绪函数
  此函数负责检查是否需要重新启动CLI进程，并在需要时创建子进程来执行重启动操作。
  重启动通常用于应用特定的Node.js选项或环境变量，这些选项在当前进程中无法动态设置。
  返回true表示已启动子进程并应终止父进程，返回false表示无需重启动，可以继续正常执行。
  */
  function ensureCliRespawnReady(): boolean {
    // lyc:ai 调用buildCliRespawnPlan()构建重启动计划，如果不需要重启动则返回null
    const plan = buildCliRespawnPlan();
    if (!plan) {
      return false;
    }

    // lyc:ai 使用spawn创建子进程，使用当前Node.js可执行路径和构建好的参数及环境变量
    // lyc: node --no-warnings --max-old-space-size=4096 openclaw.mjs arg1 arg2 arg3
    const child = spawn(plan.command, plan.argv, {
      stdio: "inherit",
      env: plan.env,
    });

    // lyc:ai 调用attachChildProcessBridge()建立父子进程信号桥接，确保父进程收到的信号能传递给子进程
    attachChildProcessBridge(child);

    // lyc:ai 监听子进程退出事件，根据退出码或信号设置父进程的退出状态
    child.once("exit", (code, signal) => {
      if (signal) {
        process.exitCode = 1;
        return;
      }
      process.exit(code ?? 1);
    });

    // lyc:ai 监听子进程错误事件，记录错误并退出父进程
    child.once("error", (error) => {
      console.error(
        "[openclaw] Failed to respawn CLI:",
        error instanceof Error ? (error.stack ?? error.message) : error,
      );
      process.exit(1);
    });

    // Parent must not continue running the CLI.
    // lyc:ai 父进程必须停止执行CLI逻辑，因为子进程已经接管了执行
    return true;
  }

  /* lyc:
    规范化 Windows 参数; 处理 Windows 平台的命令行参数解析问题
    - Windows 的命令行参数解析与 Unix 不同
    - 特殊字符、引号等处理方式不同
    - 需要规范化以保证跨平台一致性
    */
  process.argv = normalizeWindowsArgv(process.argv);

  if (!ensureCliRespawnReady()) {
    // lyc: 解析容器目标参数, 即parsedContainer.container = --container选项的值, parsedContainer.argv = 去掉--container参数后的剩余参数
    // lyc: 注意: 即使process.argv没有--container选项, parsedContainer.ok也会为true, 但container为null, argv=argv
    // lyc: 即检查--container选项是否正确
    const parsedContainer = parseCliContainerArgs(process.argv);
    if (!parsedContainer.ok) {
      console.error(`[openclaw] ${parsedContainer.error}`);
      process.exit(2);
    }

    // lyc: 解析profile或dev跟选项参数, 即parsed.profile = --profile选项后的值或"dev", parsed.argv = 去掉--profile或--dev参数后的剩余参数(qa matrix和gateway例外)
    // lyc: 注意: 只有当主命令是"gateway"时, --dev 和 --profile 可以结合使用, 但本函数返回的profile的值为--profile选项的值, 同时返回的argv中会包含--dev参数
    // lyc: 即检查--profile和--dev选项是否正确
    const parsed = parseCliProfileArgs(parsedContainer.argv);
    if (!parsed.ok) {
      // Keep it simple; Commander will handle rich help/errors after we strip flags.
      console.error(`[openclaw] ${parsed.error}`);
      process.exit(2);
    }

    // lyc: 从process.argv或env.OPENCLAW_CONTAINER中获取容器名称, 并返回容器名称
    const containerTargetName = resolveCliContainerTarget(process.argv);
    if (containerTargetName && parsed.profile) {
      // lyc: --container|OPENCLAW_CONTAINER 不能与 --profile/--dev 结合使用
      console.error("[openclaw] --container cannot be combined with --profile/--dev");
      process.exit(2);
    }

    if (parsed.profile) {
      // lyc: 应用profile环境变量(env环境变量), 并根据profile值设置其他环境变量
      applyCliProfileEnv({ profile: parsed.profile });
      // Keep Commander and ad-hoc argv checks consistent.
      // lyc: 保持Commander和临时argv检查的一致性。
      process.argv = parsed.argv;
    }

    // lyc:aic L1 快速路径：处理 `--version` / `-v`。3 层快速路径梯队的第 1 层。
    // lyc: 处理根版本命令, 如果不是根版本命令, 则继续执行主命令runMainOrRootHelp
    if (!tryHandleRootVersionFastPath(process.argv)) {
      await runMainOrRootHelp(process.argv);
    }
  }
}

// lyc:aic L2 快速路径：处理根级 `--help`。3 层快速路径梯队的第 2 层。
// lyc: 处理根帮助命令, 如果不是根帮助命令, 则继续执行主命令runMainOrRootHelp
export async function tryHandleRootHelpFastPath(
  argv: string[],
  deps: {
    outputPrecomputedRootHelpText?: () => boolean;
    outputRootHelp?: () => void | Promise<void>;
    onError?: (error: unknown) => void;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<boolean> {
  if (resolveCliContainerTarget(argv, deps.env)) {
    return false;
  }
  if (!isRootHelpInvocation(argv)) {
    return false;
  }
  const handleError =
    deps.onError ??
    ((error: unknown) => {
      console.error(
        "[openclaw] Failed to display help:",
        error instanceof Error ? (error.stack ?? error.message) : error,
      );
      process.exitCode = 1;
    });
  try {
    if (deps.outputRootHelp) {
      await deps.outputRootHelp();
      return true;
    }
    const outputPrecomputedRootHelpText =
      deps.outputPrecomputedRootHelpText ??
      (await import("./cli/root-help-metadata.js")).outputPrecomputedRootHelpText;
    if (!outputPrecomputedRootHelpText()) {
      const { outputRootHelp } = await import("./cli/program/root-help.js");
      await outputRootHelp();
    }
    return true;
  } catch (error) {
    handleError(error);
    return true;
  }
}

async function runMainOrRootHelp(argv: string[]): Promise<void> {
  // lyc: 处理根帮助命令, 如果不是根帮助命令, 则继续执行主命令runMainOrRootHelp
  if (await tryHandleRootHelpFastPath(argv)) {
    return;
  }
  try {
    // lyc:aic 移交给 src/cli/run-main.ts 的 runCli — 内部还有 L3 tryRouteCli 一次拦截，
    //        都没命中才进入 buildProgram 慢路径。
    const { runCli } = await import("./cli/run-main.js");
    await runCli(argv);
  } catch (error) {
    console.error(
      "[openclaw] Failed to start CLI:",
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
    process.exitCode = 1;
  }
}
