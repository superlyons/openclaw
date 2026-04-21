#!/usr/bin/env node
import { spawn } from "node:child_process";
import { enableCompileCache } from "node:module";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isRootHelpInvocation, isRootVersionInvocation } from "./cli/argv.js";
import { parseCliContainerArgs, resolveCliContainerTarget } from "./cli/container-target.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./cli/profile.js";
import { normalizeWindowsArgv } from "./cli/windows-argv.js";
import { buildCliRespawnPlan } from "./entry.respawn.js";
import { isTruthyEnvValue, normalizeEnv } from "./infra/env.js";
import { isMainModule } from "./infra/is-main.js";
import { ensureOpenClawExecMarkerOnProcess } from "./infra/openclaw-exec-env.js";
import { installProcessWarningFilter } from "./infra/warning-filter.js";
import { attachChildProcessBridge } from "./process/child-process-bridge.js";

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

  const { installGaxiosFetchCompat } = await import("./infra/gaxios-fetch-compat.js");
  // lyc: 安装 gaxios fetch 兼容层
  await installGaxiosFetchCompat();
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
    const child = spawn(process.execPath, plan.argv, {
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

  function tryHandleRootVersionFastPath(argv: string[]): boolean {
    // lyc: 检查是否是容器目标命令, 是则直接返回false
    if (resolveCliContainerTarget(argv)) {
      return false;
    }
    // lyc: 检查是否是根版本命令, 不是则直接返回false
    if (!isRootVersionInvocation(argv)) {
      return false;
    }

    // lyc: 这里代表不是容器目标命令但是是根版本命令, 则直接打印版本信息并退出进程
    Promise.all([import("./version.js"), import("./infra/git-commit.js")])
      .then(([{ VERSION }, { resolveCommitHash }]) => {
        const commit = resolveCommitHash({ moduleUrl: import.meta.url });
        console.log(commit ? `OpenClaw ${VERSION} (${commit})` : `OpenClaw ${VERSION}`);
        process.exit(0);
      })
      .catch((error) => {
        console.error(
          "[openclaw] Failed to resolve version:",
          error instanceof Error ? (error.stack ?? error.message) : error,
        );
        process.exitCode = 1;
      });
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
    // lyc: 解析容器目标参数, 即parsedContainer.container = --container选项后的值, parsedContainer.argv = 去掉--container参数后的剩余参数
    const parsedContainer = parseCliContainerArgs(process.argv);
    if (!parsedContainer.ok) {
      console.error(`[openclaw] ${parsedContainer.error}`);
      process.exit(2);
    }

    // lyc: 解析profile或dev跟选项参数, 即parsed.profile = --profile选项后的值或"dev", parsed.argv = 去掉--profile或--dev参数后的剩余参数
    // lyc: 注意: 只有当主命令是"gateway"时, --dev 和 --profile 可以结合使用, 但本函数返回的profile的值为--profile选项的值, 同时返回的argv中会包含--dev参数
    const parsed = parseCliProfileArgs(parsedContainer.argv);
    if (!parsed.ok) {
      // Keep it simple; Commander will handle rich help/errors after we strip flags.
      console.error(`[openclaw] ${parsed.error}`);
      process.exit(2);
    }

    // lyc: 从argv中解析容器目标参数或者从环境变量OPENCLAW_CONTAINER中获取容器名称, 并返回容器名称
    const containerTargetName = resolveCliContainerTarget(process.argv);
    if (containerTargetName && parsed.profile) {
      // lyc: --container|OPENCLAW_CONTAINER 不能与 --profile/--dev 结合使用
      console.error("[openclaw] --container cannot be combined with --profile/--dev");
      process.exit(2);
    }

    if (parsed.profile) {
      // lyc: 应用profile环境变量, 并根据profile值设置其他环境变量
      applyCliProfileEnv({ profile: parsed.profile });
      // Keep Commander and ad-hoc argv checks consistent.
      // lyc: 保持Commander和临时argv检查的一致性。
      process.argv = parsed.argv;
    }

    // lyc: 处理根版本命令, 如果不是根版本命令, 则继续执行主命令runMainOrRootHelp
    if (!tryHandleRootVersionFastPath(process.argv)) {
      runMainOrRootHelp(process.argv);
    }
  }
}

// lyc: 处理根帮助命令, 如果不是根帮助命令, 则继续执行主命令runMainOrRootHelp
export function tryHandleRootHelpFastPath(
  argv: string[],
  deps: {
    outputRootHelp?: () => void | Promise<void>;
    onError?: (error: unknown) => void;
    env?: NodeJS.ProcessEnv;
  } = {},
): boolean {
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
  if (deps.outputRootHelp) {
    Promise.resolve()
      .then(() => deps.outputRootHelp?.())
      .catch(handleError);
    return true;
  }
  import("./cli/root-help-metadata.js")
    .then(async ({ outputPrecomputedRootHelpText }) => {
      if (outputPrecomputedRootHelpText()) {
        return;
      }
      const { outputRootHelp } = await import("./cli/program/root-help.js");
      await outputRootHelp();
    })
    .catch(handleError);
  return true;
}

function runMainOrRootHelp(argv: string[]): void {
  // lyc: 处理根帮助命令, 如果不是根帮助命令, 则继续执行主命令runMainOrRootHelp
  if (tryHandleRootHelpFastPath(argv)) {
    return;
  }
  import("./cli/run-main.js")
    .then(({ runCli }) => runCli(argv))
    .catch((error) => {
      console.error(
        "[openclaw] Failed to start CLI:",
        error instanceof Error ? (error.stack ?? error.message) : error,
      );
      process.exitCode = 1;
    });
}
