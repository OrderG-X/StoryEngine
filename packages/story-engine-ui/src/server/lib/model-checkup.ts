/**
 * 模型体检（P10）：把 6 个功能实际在用的模型（去重）各真发一句极短的对话，回耗时或人话错误。
 * 比「测试连接」（只列 /models）更接近真用：密钥、模型名、额度、网关格式哪个不对都会在这里露出来。
 *
 * 体检不是写作调用：每个模型最多等 CHECKUP_IDLE_MS 没动静就判不通（写作路径的「不设总时长」铁律不适用于这里）。
 */
import { resolveConfiguredChatModel, resolveFallbackChatModel, streamChatModelToText, type ModelTaskProfileKey, type ResolvedChatModel } from "./llm-client.js";

export const CHECKUP_TASKS: readonly ModelTaskProfileKey[] = ["triage", "fastDraft", "repair", "chapterSteering", "draftReview", "qualityCheck"];
const CHECKUP_IDLE_MS = 30_000;

/** 体检里「备用模型」占的功能名（不是真任务，只在体检结果里出现）。 */
export const FALLBACK_TASK = "fallback";
export type CheckupTask = ModelTaskProfileKey | typeof FALLBACK_TASK;
const CHECKUP_MAX_CHARS = 400;

export interface CheckupModel {
  /** provider id + 模型名。 */
  readonly key: string;
  readonly providerLabel: string;
  readonly model: string;
  /** 哪些功能在用它（备用模型记作 fallback）。 */
  readonly tasks: readonly CheckupTask[];
  readonly ok: boolean;
  readonly ms?: number;
  readonly error?: string;
}

export interface CheckupResult {
  readonly models: readonly CheckupModel[];
  /** 解析不出模型的功能（没分配、档案没了、缺密钥）。 */
  readonly unresolved: readonly { readonly task: CheckupTask; readonly error: string }[];
}

interface Target {
  readonly configured: ResolvedChatModel;
  readonly tasks: CheckupTask[];
}

/** 列出在用的模型（去重）。 */
export async function resolveModelsInUse(): Promise<{ readonly targets: ReadonlyMap<string, Target>; readonly unresolved: CheckupResult["unresolved"] }> {
  const targets = new Map<string, Target>();
  const unresolved: { task: CheckupTask; error: string }[] = [];
  const add = (configured: ResolvedChatModel, task: CheckupTask) => {
    const key = `${configured.provider.id}|${configured.profile.model}`;
    const existing = targets.get(key);
    if (existing) existing.tasks.push(task);
    else targets.set(key, { configured, tasks: [task] });
  };
  const failed = (task: CheckupTask, error: unknown) => unresolved.push({ task, error: error instanceof Error ? error.message : String(error) });
  for (const task of CHECKUP_TASKS) {
    try {
      add(await resolveConfiguredChatModel(task), task);
    } catch (error) {
      failed(task, error);
    }
  }
  try {
    const fallback = await resolveFallbackChatModel();
    if (fallback) add(fallback, FALLBACK_TASK);
  } catch (error) {
    failed(FALLBACK_TASK, error);
  }
  return { targets, unresolved };
}

async function pingModel(configured: ResolvedChatModel): Promise<{ readonly ok: boolean; readonly ms: number; readonly error?: string }> {
  const started = Date.now();
  try {
    const { content, thinking } = await streamChatModelToText({
      // 关思考：体检只看通不通，不让模型想半天。不带备用：主模型不通就是不通，不能让备用顶上冒充。
      configured: { ...configured, thinking: false, fallback: undefined },
      messages: [{ role: "user", content: "只回一个字：好" }],
      idleTimeoutMs: CHECKUP_IDLE_MS,
      maxThinkingMs: CHECKUP_IDLE_MS,
      maxContentChars: CHECKUP_MAX_CHARS,
    });
    const ms = Date.now() - started;
    if (!content.trim() && !thinking.trim()) return { ok: false, ms, error: "连上了，但模型什么也没回。" };
    return { ok: true, ms };
  } catch (error) {
    return { ok: false, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 体检：在用的模型并发各发一句。 */
export async function runModelCheckup(): Promise<CheckupResult> {
  const { targets, unresolved } = await resolveModelsInUse();
  const models = await Promise.all([...targets.entries()].map(async ([key, target]) => {
    const result = await pingModel(target.configured);
    return {
      key,
      providerLabel: target.configured.provider.label || target.configured.provider.id,
      model: target.configured.profile.model,
      tasks: target.tasks,
      ...result,
    };
  }));
  return { models, unresolved };
}
