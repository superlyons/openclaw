import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { buildLegacyBundledRootPath } from "./bundled-load-path-aliases.js";

/* lyc: EXP: "/mnt/My\040Data" -> "/mnt/My Data"
/proc/self/mountinfo 文件中，如果路径包含空格、制表符或其他特殊字符，内核不会直接显示，而是会用八进制转义序列来表示（例如，空格可能会被表示为 \040）
/\\([0-7]{3})/g 这个正则表达式会匹配反斜杠后面跟着的三位八进制数字（如 \040）
*/
function decodeMountInfoPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    // lyc: octal八进制字符串转换成对应的十进制数字，再还原成真实的字符
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

// lyc: 解析Linux的挂载点信息
export function parseLinuxMountInfoMountPoints(mountInfo: string): Set<string> {
  const mountPoints = new Set<string>();
  for (const line of mountInfo.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const fields = trimmed.split(" ");
    const mountPoint = fields[4];
    if (!mountPoint) {
      continue;
    }
    mountPoints.add(path.resolve(decodeMountInfoPath(mountPoint)));
  }
  return mountPoints;
}

// lyc: 在 Linux 系统中获取当前进程能看到的所有挂载点路径
function readLinuxMountPoints(): Set<string> {
  try {
    // lyc: 这个文件由内核实时生成，包含了当前进程能看到的所有挂载信息
    return parseLinuxMountInfoMountPoints(fs.readFileSync("/proc/self/mountinfo", "utf8"));
  } catch {
    return new Set();
  }
}

// lyc: 判断目标路径是否是一个文件系统的挂载点(代表一个新的文件系统)
function isFilesystemMountPoint(targetPath: string): boolean {
  try {
    const target = fs.statSync(targetPath);
    const parent = fs.statSync(path.dirname(targetPath));
    /* lyc: 目标路径是否在一个新的文件系统上并且不是根目录
    设备 ID (dev): 如果目标路径的设备 ID 与父目录的设备 ID 不相等，说明目标路径位于一个与父目录完全不同的文件系统上，因此它必然是一个挂载点(代表一个新的文件系统)。
    节点 ID (ino): 如果目标路径的 ino 与父目录的 ino 相等, 在同一个文件系统上不可能发生, 有一个Linux系统例外: 根目录 / 是一个特殊的挂载点，它的 dev 和 ino 与它的父目录（也就是它自己）是完全相同的。
    */
    return target.dev !== parent.dev || target.ino === parent.ino;
  } catch {
    return false;
  }
}

// lyc: 是否禁用了捆绑源覆盖 env.OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS
function sourceOverlaysDisabled(env: NodeJS.ProcessEnv): boolean {
  const raw = normalizeOptionalLowercaseString(env.OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS);
  return raw === "1" || raw === "true";
}

// lyc: 判断sourcePath是否位于一个“独立挂载的文件系统”上, 防止路径逃逸和恶意挂载
export function isBundledSourceOverlayPath(params: {
  sourcePath: string;
  mountPoints?: ReadonlySet<string>;
}): boolean {
  const resolved = path.resolve(params.sourcePath);
  // lyc: 在 Linux 系统中获取当前进程能看到的所有挂载点路径
  const mountPoints = params.mountPoints ?? readLinuxMountPoints();
  // lyc: 如果sourcePath在挂载点路径中, 则返回true
  // lyc: 如果sourcePath是一个文件系统的挂载点(代表一个新的文件系统), 则返回true
  return mountPoints.has(resolved) || isFilesystemMountPoint(resolved);
}

/* lyc: 列出捆绑|内置插件的源码覆盖目录(packageRoot/extensions/**)
这里的覆盖目录用于在其中发现插件, 并代替openclaw原本的 捆绑|内置插件
覆盖目录和遗留目录共用一个路径, 但覆盖目录代表只操作在挂载点上的目录, 如果packageRoot/extensions在挂载点上则整个目录都为覆盖目录, 否则只有子目录在挂载点上才为覆盖目录, 其它情况为遗留目录
列出覆盖目录, 即: 所有在挂载点上的覆盖插件目录(packageRoot/extensions/**)
覆盖插件目录基于 bundledRoot(捆绑|内置 插件所在目录) 生成即去掉dist-runtime|dist目录后的路径
*/
export function listBundledSourceOverlayDirs(params: {
  // lyc: 捆绑|内置 插件所在目录 | OpenClaw插件的捆绑根目录, 一般在 packageRoot/dist-runtime | dist | ""/extensions
  bundledRoot?: string;
  env?: NodeJS.ProcessEnv;
  mountPoints?: ReadonlySet<string>;
}): string[] {
  const env = params.env ?? process.env;
  // lyc: 如果禁用了捆绑源覆盖, 或者没有指定捆绑根目录, 则返回空数组
  if (sourceOverlaysDisabled(env) || !params.bundledRoot) {
    return [];
  }
  // lyc: 从 捆绑|内置 插件所在目录 中构建 覆盖|遗留的插件捆绑根目录(packageRoot/extensions)
  // lyc: 覆盖目录和遗留目录共用一个路径, 后续逻辑只操作在挂载点上的目录
  const legacyRoot = buildLegacyBundledRootPath(params.bundledRoot);
  // lyc: 如果 覆盖|遗留的插件捆绑根目录(packageRoot/extensions)不存在, 则返回空数组
  if (!legacyRoot || !fs.existsSync(legacyRoot)) {
    return [];
  }

  let entries: fs.Dirent[];
  try {
    // lyc: 读取 覆盖|遗留的插件捆绑根目录(packageRoot/extensions) 目录下的所有文件和目录
    entries = fs.readdirSync(legacyRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  // lyc: 在 Linux 系统中获取当前进程能看到的所有挂载点路径
  const mountPoints = params.mountPoints ?? readLinuxMountPoints();
  // lyc: 判断 覆盖|遗留的插件捆绑根目录(packageRoot/extensions) 是否位于一个“独立挂载的文件系统”上, 防止路径逃逸和恶意挂载
  const legacyRootMounted = isBundledSourceOverlayPath({
    sourcePath: legacyRoot,
    mountPoints,
  });
  const overlayDirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    // lyc: packageRoot/extensions/当前目录名
    const sourceDir = path.join(legacyRoot, entry.name);
    // lyc: 捆绑目录下的对等体(对等sourceDir), packageRoot/dist-runtime | dist | ""/extensions/当前目录名
    const bundledPeer = path.join(params.bundledRoot, entry.name);
    // lyc: 如果捆绑目录下的对等体不存在, 则跳过
    if (!fs.existsSync(bundledPeer)) {
      continue;
    }
    // lyc: 如果 覆盖|遗留的插件捆绑根目录(packageRoot/extensions) 不是挂载点路径, 
    // 并且 sourceDir 也是未挂载, 则跳过
    if (
      !legacyRootMounted &&
      !isBundledSourceOverlayPath({
        sourcePath: sourceDir,
        mountPoints,
      })
    ) {
      continue;
    }
    // lyc: 如果 覆盖|遗留的插件捆绑根目录(packageRoot/extensions) 是一个挂载点路径
    // lyc: 或 sourceDir 是挂载点路径, 则添加到结果数组
    // lyc: overlayDirs 代表 所有在挂载点上的覆盖插件目录(packageRoot/extensions/**)
    overlayDirs.push(sourceDir);
  }
  return overlayDirs.toSorted((left, right) => left.localeCompare(right));
}
