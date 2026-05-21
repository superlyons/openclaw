import { spawnSync } from "node:child_process";
import { isIP } from "node:net";
import { consumeRootOptionToken, FLAG_TERMINATOR } from "../infra/cli-root-options.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import { scanCliRootOptions } from "./root-option-scan.js";
import { takeCliRootOptionValue } from "./root-option-value.js";

type CliContainerParseResult =
  | { ok: true; container: string | null; argv: string[] }
  | { ok: false; error: string };

type CliContainerTargetResult =
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

// lyc:aic v2026.5 新增：OPENCLAW_CONTAINER_ALLOW_LOOPBACK_PROXY_URL 环境变量名常量
const CONTAINER_ALLOW_LOOPBACK_PROXY_URL_ENV = "OPENCLAW_CONTAINER_ALLOW_LOOPBACK_PROXY_URL";

// lyc: 解析 CLI 容器目标参数 --container, 并返回解析结果, return.argv 不会包含 --container 参数, 如果解析失败则返回错误信息
// lyc: 注意: 即使 argv 没有 --container 选项, return.ok 也会为 true, 但 container 为 null, argv=argv
export function parseCliContainerArgs(argv: string[]): CliContainerParseResult {
  let container: string | null = null;

  // lyc: arg当前处理的参数, args=argv.slice(2), index=args[index]=arg
  const scanned = scanCliRootOptions(argv, ({ arg, args, index }) => {
    // lyc: 处理--container选项, 获得容器名并设置外部container变量, 如果没有容器名则返回错误信息, 如果是不关心的参数, 则返回pass
    // lyc: 注意: 本回调函数没有接收第四个入参out, 代表当前处理的参数, 不需要添加到out数组中, 即scanned.argv不会包含--container参数
    if (arg === "--container" || arg.startsWith("--container=")) {
      const next = args[index + 1];
      const { value, consumedNext } = takeCliRootOptionValue(arg, next);
      if (!value) {
        return { kind: "error", error: "--container requires a value" };
      }
      container = value;
      return { kind: "handled", consumedNext };
    }
    return { kind: "pass" };
  });

  if (!scanned.ok) {
    return scanned;
  }

  return { ok: true, container, argv: scanned.argv };
}

// lyc: 从argv或env.OPENCLAW_CONTAINER中获取容器名称, 并返回容器名称
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
  */
  const result = params.deps.spawnSync(
    params.exec.command,
    [...params.exec.argsPrefix, "inspect", "--format", "{{.State.Running}}", params.containerName],
    // lyc: 注意: 当params.exec.command === "sudo" 时, params.exec.argsPrefix[0]应该设置为"docker"或"podman"
    params.exec.command === "sudo"
      /* lyc: 
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
*/
function buildContainerExecArgs(params: {
  exec: ContainerRuntimeExec;
  containerName: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
}): string[] {
  const envFlag = params.exec.runtime === "docker" ? "-e" : "--env";
  const proxyUrl = normalizeOptionalString(params.env.OPENCLAW_PROXY_URL);
  if (proxyUrl) {
    assertContainerProxyUrlIsReachable(proxyUrl, params.env);
  }
  const proxyEnvArgs = proxyUrl ? [envFlag, `OPENCLAW_PROXY_URL=${proxyUrl}`] : [];
  const interactiveFlags = ["-i", ...(params.stdinIsTTY && params.stdoutIsTTY ? ["-t"] : [])];
  return [
    ...params.exec.argsPrefix,
    "exec",
    ...interactiveFlags,
    envFlag,
    `OPENCLAW_CONTAINER_HINT=${params.containerName}`,
    envFlag,
    "OPENCLAW_CLI_CONTAINER_BYPASS=1",
    ...proxyEnvArgs,
    params.containerName,
    "openclaw",
    ...params.argv,
  ];
}

function assertContainerProxyUrlIsReachable(proxyUrl: string, env: NodeJS.ProcessEnv): void {
  if (env[CONTAINER_ALLOW_LOOPBACK_PROXY_URL_ENV] === "1") {
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    return;
  }
  if (!isLoopbackProxyHostname(parsed.hostname)) {
    return;
  }
  throw new Error(
    `OPENCLAW_PROXY_URL=${redactProxyUrlForMessage(proxyUrl)} is loopback; 127.0.0.1 inside a container points at the container, not the host. ` +
      `Use a container-reachable proxy address, or set ${CONTAINER_ALLOW_LOOPBACK_PROXY_URL_ENV}=1 if this is intentional.`,
  );
}

function isLoopbackProxyHostname(hostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase().replace(/\.+$/, "");
  if (normalizedHostname === "localhost") {
    return true;
  }
  if (isIP(normalizedHostname) === 4) {
    return normalizedHostname.split(".", 1)[0] === "127";
  }
  const ipv6Hostname = normalizedHostname.replace(/^\[|\]$/g, "");
  if (isIP(ipv6Hostname) !== 6) {
    return false;
  }
  if (ipv6Hostname === "::1" || ipv6Hostname === "0:0:0:0:0:0:0:1") {
    return true;
  }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ipv6Hostname);
  if (!mapped) {
    return false;
  }
  const high = Number.parseInt(mapped[1], 16);
  return Number.isInteger(high) && high >= 0x7f00 && high <= 0x7fff;
}

function redactProxyUrlForMessage(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      url.username = "redacted";
      url.password = url.password ? "redacted" : "";
    }
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "<invalid URL>";
  }
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

  // lyc: env.OPENCLAW_CLI_CONTAINER_BYPASS 为 1 时, 则不尝试在容器中运行CLI
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
      env: resolvedDeps.env,
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
