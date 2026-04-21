import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { loadGlobalRuntimeDotEnvFiles, loadWorkspaceDotEnvFile } from "../infra/dotenv.js";

// lyc: 加载CLI的环境变量(.env), 先加载工作目录下的.env文件cwd/.env, 然后加载状态目录下的.env文件~/.openclaw/.env和~/.config/openclaw/gateway.env
// lyc: 并且状态目录下的环境变量不会覆盖工作目录下的环境变量
export function loadCliDotEnv(opts?: { quiet?: boolean }) {
  const quiet = opts?.quiet ?? true;
  // lyc: 当前工作目录下的.env文件路径
  const cwdEnvPath = path.join(process.cwd(), ".env");
  // lyc: 加载工作区的环境变量(cwd()/.env)到process.env中, 过滤掉被阻止的环境变量
  loadWorkspaceDotEnvFile(cwdEnvPath, { quiet });

  // Then load the global fallback set without overriding any env vars that
  // were already set or loaded from CWD. This includes the Ubuntu fresh-install
  // gateway.env compatibility path.
  // lyc: 然后加载全局回退设置，且不覆盖任何已设置或从当前工作目录（CWD）加载的环境变量。这包括Ubuntu全新安装的gateway.env兼容路径。
  // lyc: 加载全局的环境变量(.env)到process.env中, 默认为~/.openclaw/.env和~/.config/openclaw/gateway.env
  loadGlobalRuntimeDotEnvFiles({
    quiet,
    stateEnvPath: path.join(resolveStateDir(process.env), ".env"),
  });
}
