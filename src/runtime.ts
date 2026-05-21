import { clearActiveProgressLine } from "./terminal/progress-line.js";
import { restoreTerminalState } from "./terminal/restore.js";

export type RuntimeEnv = {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: (code: number) => void;
};

export type OutputRuntimeEnv = RuntimeEnv & {
  writeStdout: (value: string) => void;
  writeJson: (value: unknown, space?: number) => void;
};

// lyc: 检查是否应该输出运行时日志, 不是测试环境(VITEST!=true) 或者 env.OPENCLAW_TEST_RUNTIME_LOG=1, 或者 console.log被模拟时, 才输出日志
// lyc: 默认情况下console.log属于高层函数,效率较低,底层调用process.stdout.write, 会自动格式化输出增加换行符
function shouldEmitRuntimeLog(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.VITEST !== "true") {
    return true;
  }
  if (env.OPENCLAW_TEST_RUNTIME_LOG === "1") {
    return true;
  }
  /* lyc:
  */
  const maybeMockedLog = console.log as unknown as { mock?: unknown };
  return typeof maybeMockedLog.mock === "object";
}

// lyc: 检查是否应该输出运行时标准输出, 不是测试环境(VITEST!=true) 或者 env.OPENCLAW_TEST_RUNTIME_LOG=1, 或者 process.stdout被模拟时, 才输出标准输出
// lyc: 默认情况下process.stdout.write属于底层函数,效率高, 但不会自动格式化输出或增加换行符, 默认情况console.log是它的上层函数, 适合构建CLI工具, 例如 process.stdout.write(`Progress: ${percent}%\r`); // \r 回到行首覆盖
function shouldEmitRuntimeStdout(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.VITEST !== "true") {
    return true;
  }
  if (env.OPENCLAW_TEST_RUNTIME_LOG === "1") {
    return true;
  }
  const stdout = process.stdout as NodeJS.WriteStream & {
    write: {
      mock?: unknown;
    };
  };
  return typeof stdout.write.mock === "object";
}

// lyc: 检查是否是管道关闭错误
function isPipeClosedError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === "EPIPE" || code === "EIO";
}

function hasRuntimeOutputWriter(
  runtime: RuntimeEnv | OutputRuntimeEnv,
): runtime is OutputRuntimeEnv {
  return typeof (runtime as Partial<OutputRuntimeEnv>).writeStdout === "function";
}

// lyc: 写入标准输出(process.stdout.write),会自动添加换行符,并忽略管道关闭错误
function writeStdout(value: string): void {
  if (!shouldEmitRuntimeStdout()) {
    return;
  }
  clearActiveProgressLine();
  const line = value.endsWith("\n") ? value : `${value}\n`;
  try {
    process.stdout.write(line);
  } catch (err) {
    // lyc: 忽略管道关闭错误
    if (isPipeClosedError(err)) {
      return;
    }
    throw err;
  }
}

// lyc: 创建运行时IO环境, 包含log, error, writeStdout, writeJson; log,error走高层函数console.log,console.error, writeStdout,writeJson走底层函数process.stdout.write
function createRuntimeIo(): Pick<OutputRuntimeEnv, "log" | "error" | "writeStdout" | "writeJson"> {
  return {
    log: (...args: Parameters<typeof console.log>) => {
      // lyc: 是否应该输出日志
      if (!shouldEmitRuntimeLog()) {
        return;
      }
      // lyc: 清除当前活动的进度行
      clearActiveProgressLine();
      console.log(...args);
    },
    error: (...args: Parameters<typeof console.error>) => {
      clearActiveProgressLine();
      console.error(...args);
    },
    writeStdout,
    writeJson: (value: unknown, space = 2) => {
      writeStdout(JSON.stringify(value, null, space > 0 ? space : undefined));
    },
  };
}

export const defaultRuntime: OutputRuntimeEnv = {
  ...createRuntimeIo(),
  exit: (code) => {
    // lyc: 退出时恢复终端状态, 避免在 Docker TTY 中恢复 stdin 导致容器进程无法正常退出
    restoreTerminalState("runtime exit", { resumeStdinIfPaused: false });
    process.exit(code);
    throw new Error("unreachable"); // satisfies tests when mocked
  },
};

export function createNonExitingRuntime(): OutputRuntimeEnv {
  return {
    ...createRuntimeIo(),
    exit: (code: number) => {
      throw new Error(`exit ${code}`);
    },
  };
}

export function writeRuntimeJson(
  runtime: RuntimeEnv | OutputRuntimeEnv,
  value: unknown,
  space = 2,
): void {
  if (hasRuntimeOutputWriter(runtime)) {
    runtime.writeJson(value, space);
    return;
  }
  runtime.log(JSON.stringify(value, null, space > 0 ? space : undefined));
}
