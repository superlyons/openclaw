import process from "node:process";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";

export type RuntimeKind = "node" | "unknown";

type Semver = {
  major: number;
  minor: number;
  patch: number;
};

const MIN_NODE: Semver = { major: 22, minor: 14, patch: 0 };
const MINIMUM_ENGINE_RE = /^\s*>=\s*v?(\d+\.\d+\.\d+)\s*$/i;

export type RuntimeDetails = {
  kind: RuntimeKind;
  version: string | null;
  execPath: string | null;
  pathEnv: string;
};

const SEMVER_RE = /(\d+)\.(\d+)\.(\d+)/;

// lyc: 解析 Semver(语义化版本号版本号的定义规范和规则) 版本字符串, Major主版本, Minor次版本, Patch修订版本
export function parseSemver(version: string | null): Semver | null {
  if (!version) {
    return null;
  }
  const match = version.match(SEMVER_RE);
  if (!match) {
    return null;
  }
  const [, major, minor, patch] = match;
  return {
    major: Number.parseInt(major, 10),
    minor: Number.parseInt(minor, 10),
    patch: Number.parseInt(patch, 10),
  };
}

export function isAtLeast(version: Semver | null, minimum: Semver): boolean {
  if (!version) {
    return false;
  }
  if (version.major !== minimum.major) {
    return version.major > minimum.major;
  }
  if (version.minor !== minimum.minor) {
    return version.minor > minimum.minor;
  }
  return version.patch >= minimum.patch;
}

// lyc: 检测当前运行时环境
export function detectRuntime(): RuntimeDetails {
  /* lyc:
  console.log(process.versions);
  {
    node: '20.11.0',        // Node.js 版本
    v8: '11.3.244.8-node.20', // V8 引擎版本
    uv: '1.77.0',           // libuv 版本
    zlib: '1.2.13',
    brotli: '1.0.9',
    ares: '1.19.1',
    modules: '115',         // ABI 版本号
    nghttp2: '1.57.0',
    napi: '9',
    llhttp: '8.1.1',
    // ... 更多依赖
  }
  */
  const kind: RuntimeKind = process.versions?.node ? "node" : "unknown";
  const version = process.versions?.node ?? null;

  return {
    kind,
    version,
    execPath: process.execPath ?? null,
    pathEnv: process.env.PATH ?? "(not set)",
  };
}

// lyc: 检查运行时是否受支持
export function runtimeSatisfies(details: RuntimeDetails): boolean {
  const parsed = parseSemver(details.version);
  // lyc: 如果是node环境则检查版本号是否大于等于22.14.0
  if (details.kind === "node") {
    return isAtLeast(parsed, MIN_NODE);
  }
  return false;
}

export function isSupportedNodeVersion(version: string | null): boolean {
  return isAtLeast(parseSemver(version), MIN_NODE);
}

export function parseMinimumNodeEngine(engine: string | null): Semver | null {
  if (!engine) {
    return null;
  }
  const match = engine.match(MINIMUM_ENGINE_RE);
  if (!match) {
    return null;
  }
  return parseSemver(match[1] ?? null);
}

export function nodeVersionSatisfiesEngine(
  version: string | null,
  engine: string | null,
): boolean | null {
  const minimum = parseMinimumNodeEngine(engine);
  if (!minimum) {
    return null;
  }
  return isAtLeast(parseSemver(version), minimum);
}

// lyc: 断言运行时是否受支持
export function assertSupportedRuntime(
  runtime: RuntimeEnv = defaultRuntime,
  details: RuntimeDetails = detectRuntime(),
): void {
  // lyc: 如果是node环境且版本号大于等于22.14.0, 则返回成功
  if (runtimeSatisfies(details)) {
    return;
  }

  const versionLabel = details.version ?? "unknown";
  const runtimeLabel =
    details.kind === "unknown" ? "unknown runtime" : `${details.kind} ${versionLabel}`;
  const execLabel = details.execPath ?? "unknown";

  runtime.error(
    [
      "openclaw requires Node >=22.14.0.",
      `Detected: ${runtimeLabel} (exec: ${execLabel}).`,
      `PATH searched: ${details.pathEnv}`,
      "Install Node: https://nodejs.org/en/download",
      "Upgrade Node and re-run openclaw.",
    ].join("\n"),
  );
  runtime.exit(1);
}
