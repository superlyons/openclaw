/* lyc:ai
Crestodian对话管理器——负责将用户的自然语言输入解析为CrestodianOperation
解析策略分两级:
1. 正则匹配: parseCrestodianOperation (operations.ts) 支持 "status"/"doctor"/"gateway restart" 等关键词
2. AI助手备选: 当正则无法匹配时(operation.kind==="none"), 调用planCrestodianCommand
   (assistant.ts) 利用AI模型理解用户意图，将模糊请求转换为结构化命令
   AI助手先尝试使用用户已配置的模型(simple-completion)，失败则回退到本地runtime推理
*/
import type { RuntimeEnv } from "../runtime.js";
import type { CrestodianAssistantPlan, CrestodianAssistantPlanner } from "./assistant.js";
import {
  describeCrestodianPersistentOperation,
  parseCrestodianOperation,
  type CrestodianOperation,
} from "./operations.js";
import { loadCrestodianOverview, type CrestodianOverview } from "./overview.js";

export type CrestodianDialogueOptions = {
  loadOverview?: typeof loadCrestodianOverview;
  planWithAssistant?: CrestodianAssistantPlanner;
};

export function approvalQuestion(operation: CrestodianOperation): string {
  return `Apply this operation: ${describeCrestodianPersistentOperation(operation)}?`;
}

export function isYes(input: string): boolean {
  return /^(y|yes|apply|do it|approved?)$/i.test(input.trim());
}

/* lyc:ai
核心解析函数: 将用户输入文本转为CrestodianOperation
1. 先调用parseCrestodianOperation进行关键词/正则匹配快速解析
2. 如果无法识别(kind==="none")，则调用AI助手(planCrestodianCommand)做语义理解
3. AI助手返回的plan.command会经过第二次parseCrestodianOperation转为最终操作
4. 输出日志记录AI助手的推理信息(modelLabel, reply, interpreted command)
*/
export async function resolveCrestodianOperation(
  input: string,
  runtime: RuntimeEnv,
  opts: CrestodianDialogueOptions,
): Promise<CrestodianOperation> {
  const operation = parseCrestodianOperation(input);
  if (!shouldAskAssistant(input, operation)) {
    return operation;
  }
  const overview = await (opts.loadOverview ?? loadCrestodianOverview)();
  const planner = opts.planWithAssistant ?? (await import("./assistant.js")).planCrestodianCommand;
  const plan = await planner({ input, overview });
  if (!plan) {
    return operation;
  }
  const planned = parseCrestodianOperation(plan.command);
  if (planned.kind === "none") {
    return operation;
  }
  logAssistantPlan(runtime, plan, overview);
  return planned;
}

function shouldAskAssistant(input: string, operation: CrestodianOperation): boolean {
  if (operation.kind !== "none") {
    return false;
  }
  const trimmed = input.trim().toLowerCase();
  if (!trimmed || trimmed === "quit" || trimmed === "exit") {
    return false;
  }
  return true;
}

function logAssistantPlan(
  runtime: RuntimeEnv,
  plan: CrestodianAssistantPlan,
  overview: CrestodianOverview,
): void {
  const modelLabel = plan.modelLabel ?? overview.defaultModel ?? "configured model";
  runtime.log(`[crestodian] planner: ${modelLabel}`);
  if (plan.reply) {
    runtime.log(plan.reply);
  }
  runtime.log(`[crestodian] interpreted: ${plan.command}`);
}
