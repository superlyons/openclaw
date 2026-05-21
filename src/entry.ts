#!/usr/bin/env node
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isRootHelpInvocation } from "./cli/argv.js";
import { parseCliContainerArgs, resolveCliContainerTarget } from "./cli/container-target.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./cli/profile.js";
import { normalizeWindowsArgv } from "./cli/windows-argv.js";
import {
  enableOpenClawCompileCache,
  resolveEntryInstallRoot,
  respawnWithoutOpenClawCompileCacheIfNeeded,
} from "./entry.compile-cache.js";
import { buildCliRespawnPlan, runCliRespawnPlan } from "./entry.respawn.js";
import { tryHandleRootVersionFastPath } from "./entry.version-fast-path.js";
import { isTruthyEnvValue, normalizeEnv } from "./infra/env.js";
import { isMainModule } from "./infra/is-main.js";
import { ensureOpenClawExecMarkerOnProcess } from "./infra/openclaw-exec-env.js";
import { installProcessWarningFilter } from "./infra/warning-filter.js";

/* lyc:aic

*/
// lyc: 定义了包装器文件与实际入口文件的映射关系, openclaw.mjs 和 openclaw.js 是包装器，它们会导入 entry.js, 这样 isMainModule 可以正确识别主入口文件
const ENTRY_WRAPPER_PAIRS = [
  { wrapperBasename: "openclaw.mjs", entryBasename: "entry.js" },
  { wrapperBasename: "openclaw.js", entryBasename: "entry.js" },
] as const;

/* lyc:
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

function createGatewayEntryStartupTrace(argv: string[]) {
  const enabled =
    isTruthyEnvValue(process.env.OPENCLAW_GATEWAY_STARTUP_TRACE) &&
    argv.slice(2).includes("gateway");
  const started = performance.now();
  let last = started;
  const emit = (name: string, durationMs: number, totalMs: number) => {
    if (!enabled) {
      return;
    }
    process.stderr.write(
      `[gateway] startup trace: entry.${name} ${durationMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms\n`,
    );
  };
  return {
    mark(name: string) {
      const now = performance.now();
      emit(name, now - last, now - started);
      last = now;
    },
    async measure<T>(name: string, run: () => Promise<T>): Promise<T> {
      const before = performance.now();
      try {
        return await run();
      } finally {
        const now = performance.now();
        emit(name, now - before, now - started);
        last = now;
      }
    },
  };
}

const gatewayEntryStartupTrace = createGatewayEntryStartupTrace(process.argv);

// Guard: only run entry-point logic when this file is the main module.
// The bundler may import entry.js as a shared dependency when dist/index.js
// is the actual entry point; without this guard the top-level code below
// would call runCli a second time, starting a duplicate gateway that fails
// on the lock / port and crashes the process.
/* lyc: isMainModule 检查
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
    */
  // lyc:aic v2026.5 新增：在做任何进程级初始化前，先检查是否需要 respawn 关掉 compile cache
  //         （某些情况下 Node compile cache 会出问题，需要重启 node 干净启动）。
  const entryFile = fileURLToPath(import.meta.url);
  const installRoot = resolveEntryInstallRoot(entryFile);
  const waitingForCompileCacheRespawn = respawnWithoutOpenClawCompileCacheIfNeeded({
    currentFile: entryFile,
    installRoot,
  });
  if (!waitingForCompileCacheRespawn) {
    // lyc: 设置进程标题为 openclaw
    process.title = "openclaw";
    // lyc: 确保在当前进程环境中设置 OPENCLAW_CLI 环境变量 env.OPENCLAW_CLI = "1"
    ensureOpenClawExecMarkerOnProcess();
    // lyc: 安装自定义的警告过滤器
    installProcessWarningFilter();
    // lyc: 规范环境变量
    normalizeEnv();

    // lyc:aic v2026.5 重构：编译缓存逻辑从 node:module 的 enableCompileCache 抽到了
    //         entry.compile-cache.js 里的 enableOpenClawCompileCache，支持更复杂的策略。
    enableOpenClawCompileCache({
      installRoot,
    });
    gatewayEntryStartupTrace.mark("bootstrap");

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


    */
    /* lyc:ai
    */
    function ensureCliRespawnReady(): boolean {
      // lyc:ai 调用buildCliRespawnPlan()构建重启动计划，如果不需要重启动则返回null
      const plan = buildCliRespawnPlan();
      if (!plan) {
        return false;
      }

      // lyc:aic v2026.5：spawn/桥接/退出/错误处理全部封装到 runCliRespawnPlan
      runCliRespawnPlan(plan);
      // Parent must not continue running the CLI.
      // lyc:ai 父进程必须停止执行CLI逻辑，因为子进程已经接管了执行
      return true;
    }

    /* lyc:
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
      gatewayEntryStartupTrace.mark("argv");

      // lyc:aic L1 快速路径：处理 `--version` / `-v`。3 层快速路径梯队的第 1 层。
      // lyc: 处理根版本命令, 如果不是根版本命令, 则继续执行主命令runMainOrRootHelp
      if (!tryHandleRootVersionFastPath(process.argv)) {
        await runMainOrRootHelp(process.argv);
      }
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
    //        v2026.5 用 gatewayEntryStartupTrace.measure 包装来计 import 时间。
    const { runCli } = await gatewayEntryStartupTrace.measure(
      "run-main-import",
      () => import("./cli/run-main.js"),
    );
    await runCli(argv);
  } catch (error) {
    const { formatCliFailureLines } = await import("./cli/failure-output.js");
    for (const line of formatCliFailureLines({
      title: "Could not start the CLI.",
      error,
      argv,
    })) {
      console.error(line);
    }
    process.exit(1);
  }
}
