import { isRootVersionInvocation } from "./cli/argv.js";
import { resolveCliContainerTarget } from "./cli/container-target.js";

export function tryHandleRootVersionFastPath(
  argv: string[],
  deps: {
    env?: NodeJS.ProcessEnv;
    moduleUrl?: string;
    output?: (message: string) => void;
    exit?: (code?: number) => void;
    onError?: (error: unknown) => void;
    resolveVersion?: () => Promise<{
      VERSION: string;
      resolveCommitHash: (params: { moduleUrl: string }) => string | null;
    }>;
  } = {},
): boolean {
  // lyc: 检查是否是容器目标命令, 是则直接返回false
  if (resolveCliContainerTarget(argv, deps.env)) {
    return false;
  }
  // lyc: 检查是否是根版本命令, 不是则直接返回false
  if (!isRootVersionInvocation(argv)) {
    return false;
  }
  const output = deps.output ?? ((message: string) => console.log(message));
  const exit = deps.exit ?? ((code?: number) => process.exit(code));
  const onError =
    deps.onError ??
    ((error: unknown) => {
      console.error(
        "[openclaw] Failed to resolve version:",
        error instanceof Error ? (error.stack ?? error.message) : error,
      );
      process.exitCode = 1;
    });
  const resolveVersion =
    deps.resolveVersion ??
    (async () => {
      const [{ VERSION }, { resolveCommitHash }] = await Promise.all([
        import("./version.js"),
        import("./infra/git-commit.js"),
      ]);
      return { VERSION, resolveCommitHash };
    });
  // lyc: 这里代表不是容器目标命令但是是根版本命令, 则直接打印版本信息并退出进程
  resolveVersion()
    .then(({ VERSION, resolveCommitHash }) => {
      const commit = resolveCommitHash({ moduleUrl: deps.moduleUrl ?? import.meta.url });
      output(commit ? `OpenClaw ${VERSION} (${commit})` : `OpenClaw ${VERSION}`);
      exit(0);
    })
    .catch(onError);
  return true;
}
