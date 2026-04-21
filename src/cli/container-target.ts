import { spawnSync } from "node:child_process";
import { consumeRootOptionToken, FLAG_TERMINATOR } from "../infra/cli-root-options.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import { forwardConsumedCliRootOption } from "./root-option-forward.js";
import { takeCliRootOptionValue } from "./root-option-value.js";

type CliContainerParseResult =
  | { ok: true; container: string | null; argv: string[] }
  | { ok: false; error: string };

export type CliContainerTargetResult =
  | { handled: true; exitCode: number }
  | { handled: false; argv: string[] };

type ContainerTargetDeps = {
  env: NodeJS.ProcessEnv;
  spawnSync: typeof spawnSync;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
};

type ContainerRuntimeExec = {
  runtime: "podman" | "docker";
  command: string;
  argsPrefix: string[];
};

// lyc: 解析CLI容器目标参数, 并返回解析结果
// lyc: 如果解析失败, 则返回错误信息
export function parseCliContainerArgs(argv: string[]): CliContainerParseResult {
  if (argv.length < 2) {
    return { ok: true, container: null, argv };
  }
  // lyc: out直接等于argv的前两个参数, 例如: ["node", "/path/openclaw.mjs", "run", "dev", "--container", "name"] -> ["node", "/path/openclaw.mjs"]
  const out: string[] = argv.slice(0, 2);
  let container: string | null = null;

  // lyc: 遍历argv的剩余参数, 例如: ["node", "/path/openclaw.mjs", "run", "dev", "--container", "name"] -> ["run", "dev", "--container", "name"]
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === FLAG_TERMINATOR) {
      out.push(arg, ...args.slice(i + 1));
      break;
    }

    // lyc: 处理--container选项, 设置容器名称
    // lyc: 如果--container后面没有值, 则返回错误
    if (arg === "--container" || arg.startsWith("--container=")) {
      const next = args[i + 1];
      const { value, consumedNext } = takeCliRootOptionValue(arg, next);
      if (consumedNext) {
        i += 1;
      }
      if (!value) {
        return { ok: false, error: "--container requires a value" };
      }
      container = value;
      continue;
    }

    // lyc: 处理其他根选项, 并将参数添加到out数组中
    const consumedRootOption = forwardConsumedCliRootOption(args, i, out);
    if (consumedRootOption > 0) {
      i += consumedRootOption - 1;
      continue;
    }

    // lyc: 其他参数直接添加到out数组中
    out.push(arg);
  }

  return { ok: true, container, argv: out };
}

// lyc: 从argv中解析容器目标参数或者从环境变量OPENCLAW_CONTAINER中获取容器名称, 并返回容器名称
export function resolveCliContainerTarget(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const parsed = parseCliContainerArgs(argv);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  return parsed.container ?? normalizeOptionalString(env.OPENCLAW_CONTAINER) ?? null;
}

// lyc: 检查容器是否正在运行
function isContainerRunning(params: {
  exec: ContainerRuntimeExec;
  containerName: string;
  deps: Pick<ContainerTargetDeps, "spawnSync">;
}): boolean {
  /* lyc: 
    spawnSync返回结果类型: {
      status: number | null,    // 退出状态码，0 表示成功
      stdout: string | Buffer,  // 标准输出
      stderr: string | Buffer,  // 标准错误
      pid: number,              // 子进程 PID
      output: Array,            // [stdin, stdout, stderr]
      signal: string | null     // 退出信号
    }
    docker inspect --format {{.State.Running}} container-1
    获取容器container-1的JSON格式的详细信息, 并返回State.Running字段的值并输出到stdout
  */
  const result = params.deps.spawnSync(
    params.exec.command,
    [...params.exec.argsPrefix, "inspect", "--format", "{{.State.Running}}", params.containerName],
    // lyc: 注意: 当params.exec.command === "sudo" 时, params.exec.argsPrefix[0]应该设置为"docker"或"podman"
    params.exec.command === "sudo"
      /* lyc: 
        utf8: 将输出（stdout/stderr）自动转换为 UTF-8 编码的字符串, 而不是返回 Buffer 对象
        inherit: stdin标准输入继承父进程的stdin通常是键盘输入
        pipe:  stdout（标准输出）：创建管道, 子进程的stdout将写入管道, 父进程从管道读取, 输出被捕获并可通过 result.stdout 访问
        inherit: stderr（标准错误）：继承自父进程的stderr, 错误信息直接显示到终端, 不被捕获，用户可以看到错误信息
      */
      ? { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] }
      : { encoding: "utf8" },
  );
  // lyc: 检查命令是否成功, 并且输出结果是否为true
  return result.status === 0 && result.stdout.trim() === "true";
}

// lyc: 返回所有可能的容器运行时
function candidateContainerRuntimes(): ContainerRuntimeExec[] {
  return [
    {
      runtime: "podman",
      command: "podman",
      argsPrefix: [],
    },
    {
      runtime: "docker",
      command: "docker",
      argsPrefix: [],
    },
  ];
}

// lyc: 解析运行中的容器, 并返回容器运行时和容器名称
function resolveRunningContainer(params: {
  containerName: string;
  env: NodeJS.ProcessEnv;
  deps: Pick<ContainerTargetDeps, "spawnSync">;
}): (ContainerRuntimeExec & { containerName: string }) | null {
  const matches: Array<ContainerRuntimeExec & { containerName: string }> = [];
  const candidates = candidateContainerRuntimes();
  // lyc: 遍历所有可能的容器运行时, 并检查容器是否正在运行
  for (const exec of candidates) {
    if (
      isContainerRunning({
        exec,
        containerName: params.containerName,
        deps: params.deps,
      })
    ) {
      // lyc: 如果容器正在运行, 则添加到matches数组中
      matches.push({ ...exec, containerName: params.containerName });
      if (exec.runtime === "docker") {
        break;
      }
    }
  }
  if (matches.length === 0) {
    return null;
  }
  if (matches.length > 1) {
    const runtimes = matches.map((match) => match.runtime).join(", ");
    throw new Error(
      `Container "${params.containerName}" is running under multiple runtimes (${runtimes}); use a unique container name.`,
    );
  }
  return matches[0];
}

/* lyc:
已docker命令为例执行如下参数的命令:
docker exec -i -t -e OPENCLAW_CONTAINER_HINT=container-1 -e OPENCLAW_CLI_CONTAINER_BYPASS=1 container-1 openclaw arg1 arg2 arg3
  exec: Docker 命令，用于在运行的容器中执行命令
  -i(或 --interactive): 保持 STDIN 开放，即使没有连接到容器; 允许与容器内的进程进行交互输入; 通常与 -t 一起使用来创建交互式会话
  -t (或 --tty): 分配一个伪终端 (pseudo-TTY); 使容器看起来像一个真实的终端设备; 通常与 -i 结合使用来获得交互式 shell
  -e OPENCLAW_CONTAINER_HINT=container-1: 设置环境变量; 这个环境变量会被传递给容器内部的进程;  OpenCLAW 应用用来识别容器标识的变量
  -e OPENCLAW_CLI_CONTAINER_BYPASS=1: 设置环境变量; 这个环境变量会被传递给容器内部的进程;  OpenCLAW 应用用来禁用容器的默认配置
  container-1: 目标容器的名称或 ID; 表示要在名为 container-1 的容器中执行命令
  openclaw: 要在容器内执行的命令/程序
  arg1 arg2 arg3: 要传递给 openclaw 命令的参数
*/
function buildContainerExecArgs(params: {
  exec: ContainerRuntimeExec;
  containerName: string;
  argv: string[];
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
}): string[] {
  const envFlag = params.exec.runtime === "docker" ? "-e" : "--env";
  const interactiveFlags = ["-i", ...(params.stdinIsTTY && params.stdoutIsTTY ? ["-t"] : [])];
  return [
    ...params.exec.argsPrefix,
    "exec",
    ...interactiveFlags,
    envFlag,
    `OPENCLAW_CONTAINER_HINT=${params.containerName}`,
    envFlag,
    "OPENCLAW_CLI_CONTAINER_BYPASS=1",
    params.containerName,
    "openclaw",
    ...params.argv,
  ];
}

function buildContainerExecEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  // Container-targeted CLI invocations should use the container's own profile
  // and gateway auth/runtime state rather than inheriting host overrides.
  delete next.OPENCLAW_PROFILE;
  delete next.OPENCLAW_GATEWAY_PORT;
  delete next.OPENCLAW_GATEWAY_URL;
  delete next.OPENCLAW_GATEWAY_TOKEN;
  delete next.OPENCLAW_GATEWAY_PASSWORD;
  // The child CLI should render container-aware follow-up commands via
  // OPENCLAW_CONTAINER_HINT, but it should not treat itself as still
  // container-targeted for validation/routing.
  next.OPENCLAW_CONTAINER = "";
  return next;
}

// lyc: 检查是否是update命令, 则不支持在容器中运行
function isBlockedContainerCommand(argv: string[]): boolean {
  if (resolveCliArgvInvocation(["node", "openclaw", ...argv]).primary === "update") {
    return true;
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg || arg === FLAG_TERMINATOR) {
      return false;
    }
    if (arg === "--update") {
      return true;
    }
    const consumedRootOption = consumeRootOptionToken(argv, i);
    if (consumedRootOption > 0) {
      i += consumedRootOption - 1;
      continue;
    }
    if (!arg.startsWith("-")) {
      return false;
    }
  }
  return false;
}

// lyc: 如果有容器目标参数, 则尝试在容器中运行CLI
export function maybeRunCliInContainer(
  argv: string[],
  deps?: Partial<ContainerTargetDeps>,
): CliContainerTargetResult {
  const resolvedDeps: ContainerTargetDeps = {
    env: deps?.env ?? process.env,
    spawnSync: deps?.spawnSync ?? spawnSync,
    stdinIsTTY: deps?.stdinIsTTY ?? process.stdin.isTTY,
    stdoutIsTTY: deps?.stdoutIsTTY ?? process.stdout.isTTY,
  };

  // lyc: OPENCLAW_CLI_CONTAINER_BYPASS 为 1 时, 则不尝试在容器中运行CLI
  if (resolvedDeps.env.OPENCLAW_CLI_CONTAINER_BYPASS === "1") {
    return { handled: false, argv };
  }

  // lyc: 解析容器目标参数
  const parsed = parseCliContainerArgs(argv);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  // lyc: 从argv中解析容器目标参数或者从环境变量OPENCLAW_CONTAINER中获取容器名称
  const containerName = resolveCliContainerTarget(argv, resolvedDeps.env);
  if (!containerName) {
    return { handled: false, argv: parsed.argv };
  }
  // lyc: 如果是update命令, 则不支持在容器中运行
  if (isBlockedContainerCommand(parsed.argv.slice(2))) {
    throw new Error(
      // lyc: 使用--container时不支持openclaw更新；请重新构建或重新启动容器镜像。
      "openclaw update is not supported with --container; rebuild or restart the container image instead.",
    );
  }
  // lyc: 解析运行中的容器, 并返回容器运行时和容器名称
  const runningContainer = resolveRunningContainer({
    containerName,
    env: resolvedDeps.env,
    deps: resolvedDeps,
  });
  // lyc: 如果没有找到运行中的容器, 则抛出错误
  if (!runningContainer) {
    throw new Error(`No running container matched "${containerName}" under podman or docker.`);
  }

  // lyc: 构建容器执行命令的参数并执行容器内命令, 例如: docker exec -i -t -e OPENCLAW_CONTAINER_HINT=container-1 -e OPENCLAW_CLI_CONTAINER_BYPASS=1 container-1 openclaw arg1 arg2 arg3
  // lyc: 注意: argv.slice(2) 是为了去掉openclaw命令本身, 只保留用户传递的参数
  const result = resolvedDeps.spawnSync(
    runningContainer.command,
    buildContainerExecArgs({
      exec: runningContainer,
      containerName: runningContainer.containerName,
      argv: parsed.argv.slice(2),
      stdinIsTTY: resolvedDeps.stdinIsTTY,
      stdoutIsTTY: resolvedDeps.stdoutIsTTY,
    }),
    {
      stdio: "inherit",
      env: buildContainerExecEnv(resolvedDeps.env),
    },
  );
  return {
    handled: true,
    // lyc: 检查容器内命令是否成功, 并返回退出状态码, 0 表示成功
    exitCode: typeof result.status === "number" ? result.status : 1,
  };
}
