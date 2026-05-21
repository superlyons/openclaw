import { readCliStartupMetadata } from "./startup-metadata.js";

let precomputedRootHelpText: string | null | undefined;
let precomputedBrowserHelpText: string | null | undefined;

// lyc: 加载预计算的帮助文本, 从 openclaw/src/cli-startup-metadata.json.[rootHelpText|browserHelpText] 中读取
// lyc: 或 上一级目录/cli-startup-metadata.json.[rootHelpText|browserHelpText] 中读取
function loadPrecomputedHelpText(
  key: "rootHelpText" | "browserHelpText",
  cache: string | null | undefined,
  setCache: (value: string | null) => void,
): string | null {
  if (cache !== undefined) {
    return cache;
  }
  try {
    const parsed = readCliStartupMetadata(import.meta.url);
    if (parsed) {
      const value = parsed[key];
      if (typeof value === "string" && value.length > 0) {
        setCache(value);
        return value;
      }
    }
  } catch {
    // Fall back to live help rendering.
  }
  setCache(null);
  return null;
}

// lyc: 加载预计算的根帮助文本, 从 openclaw/src/cli-startup-metadata.json.rootHelpText 或 上一级目录/cli-startup-metadata.json.rootHelpText 中读取
export function loadPrecomputedRootHelpText(): string | null {
  return loadPrecomputedHelpText("rootHelpText", precomputedRootHelpText, (value) => {
    precomputedRootHelpText = value;
  });
}

// lyc: 加载预计算的浏览器帮助文本, 从 openclaw/src/cli-startup-metadata.json.browserHelpText 或 上一级目录/cli-startup-metadata.json.browserHelpText 中读取
export function loadPrecomputedBrowserHelpText(): string | null {
  return loadPrecomputedHelpText("browserHelpText", precomputedBrowserHelpText, (value) => {
    precomputedBrowserHelpText = value;
  });
}

// lyc: 输出预计算的根帮助文本, 如果存在, 则写入 stdout返回 true, 否则返回 false
export function outputPrecomputedRootHelpText(): boolean {
  const rootHelpText = loadPrecomputedRootHelpText();
  if (!rootHelpText) {
    return false;
  }
  process.stdout.write(rootHelpText);
  return true;
}

// lyc: 输出预计算的浏览器帮助文本, 如果存在, 则写入 stdout返回 true, 否则返回 false
export function outputPrecomputedBrowserHelpText(): boolean {
  const browserHelpText = loadPrecomputedBrowserHelpText();
  if (!browserHelpText) {
    return false;
  }
  process.stdout.write(browserHelpText);
  return true;
}

export const __testing = {
  resetPrecomputedRootHelpTextForTests(): void {
    precomputedRootHelpText = undefined;
    precomputedBrowserHelpText = undefined;
  },
};
