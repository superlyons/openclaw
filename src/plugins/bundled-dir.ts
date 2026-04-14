import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// lyc: 解析捆绑(bundled)插件目录, OPENCLAW_BUNDLED_PLUGINS_DIR, 执行根目录下的extensions目录
export function resolveBundledPluginsDir(): string | undefined {
  const override = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR?.trim();
  if (override) {
    return override;
  }

  // bun --compile: ship a sibling `extensions/` next to the executable.
  try {
    const execDir = path.dirname(process.execPath);
    const sibling = path.join(execDir, "extensions");
    if (fs.existsSync(sibling)) {
      return sibling;
    }
  } catch {
    // ignore
  }

  // npm/dev: walk up from this module to find `extensions/` at the package root.
  try {
    // lyc: cursor指向当前文件(bundled-dir.ts)的目录
    let cursor = path.dirname(fileURLToPath(import.meta.url));
    // lyc: 在cursor目录中查找extensions目录, cusrsor会在当前位置以及向上5层的目录中查找extensions, 如果找到则返回extensions目录的路径
    for (let i = 0; i < 6; i += 1) {
      const candidate = path.join(cursor, "extensions");
      if (fs.existsSync(candidate)) {
        return candidate;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        break;
      }
      cursor = parent;
    }
  } catch {
    // ignore
  }

  return undefined;
}
