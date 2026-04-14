import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { resolveConfigDir } from "../utils.js";

/* lyc: 
  加载环境变量, 即: 从.env文件加载环境变量到process.env
*/
export function loadDotEnv(opts?: { quiet?: boolean }) {
  const quiet = opts?.quiet ?? true;

  /* lyc: 
    第一层加载环境变量
    - quiet参数控制是否在找不到.env文件时显示警告信息
    - 从进程当前工作目录（CWD）加载：这是 dotenv 库的默认行为
    - 路径：process.cwd() + '/.env'
      假设你在 /projects/my-app 目录运行, 则会加载 /projects/my-app/.env 文件
    - 优先级：最高优先级，会覆盖后续加载的同名变量
  */
  // Load from process CWD first (dotenv default).
  dotenv.config({ quiet });

  // Then load global fallback: ~/.openclaw/.env (or OPENCLAW_STATE_DIR/.env),
  // without overriding any env vars already present.
  // lyc: 加载全局后备环境变量： ~/.openclaw/.env (或 OPENCLAW_STATE_DIR/.env), 且不覆盖任何已存在的环境变量
  const globalEnvPath = path.join(resolveConfigDir(process.env), ".env");
  if (!fs.existsSync(globalEnvPath)) {
    return;
  }

  /* lyc: 
    第二层加载环境变量
    - 从 globalEnvPath 指定的文件加载环境变量
    - 优先级：最低优先级，不会覆盖已存在的环境变量 (override: false)
  */
  dotenv.config({ quiet, path: globalEnvPath, override: false });
}
