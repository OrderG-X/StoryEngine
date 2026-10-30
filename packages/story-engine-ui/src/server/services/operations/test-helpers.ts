/**
 * 单测：AI 写稿、撤销、整本恢复都只在操作里（写作版本 P2a 片 4C），要「AI 后来写了一版」「作者撤了 / 恢复了」的测试用这几个：
 * 交一次真操作，等它做完，回结果；没做成就抛它的原因。
 */
import { randomUUID } from "node:crypto";
import { applyAiDraft, type AiDraftInput, type AiDraftOutcome } from "../../lib/ai-draft-write.js";
import { SETTLED_STATES, untilOperation } from "../../lib/operations/test-helpers.js";
import type { OperationRecord } from "../../lib/operations/store.js";
import { recipeFor, registerRecipe, resumeOperation, submitOperation, type Recipe } from "./executor.js";
import { HISTORY_CHANGE_KIND, historyChangeRecipe, type HistoryChangeBody } from "./recipes/history-change.js";

const TEST_AI_DRAFT_KIND = "test.ai-draft";

const recipe: Recipe<AiDraftInput> = {
  kind: TEST_AI_DRAFT_KIND,
  version: 1,
  lane: "foreground",
  async prepare(_bookDir, input) {
    const params = input.params as AiDraftInput;
    return { ok: true, params, writeScope: { chapters: [params.chapter] }, budget: 0 };
  },
  async run(ctx) {
    const apply = () => applyAiDraft(ctx.bookDir, ctx.params);
    const outcome = await ctx.apply("apply", ctx.params, apply, apply);
    return { schema: "operation-result/1", summary: outcome.applied ? "换上了" : "留成候选", body: outcome };
  },
  stepBudget: () => 0,
  modelTasks: () => [],
};

async function runToEnd(bookDir: string, input: { readonly kind: string; readonly mode?: string; readonly params: unknown; readonly origin: "chat" | "button" }): Promise<OperationRecord> {
  const requestKey = randomUUID();
  const submitted = await submitOperation(bookDir, {
    kind: input.kind,
    ...(input.mode ? { mode: input.mode } : {}),
    params: input.params,
    requestKey,
    issuedAt: new Date().toISOString(),
    origin: input.origin === "chat" ? { kind: "chat", messageId: requestKey } : { kind: "button", messageId: requestKey },
  });
  if (!submitted.ok || !("record" in submitted)) throw new Error(`没交上：${JSON.stringify(submitted)}`);
  return untilOperation(bookDir, submitted.record.opId, (item) => SETTLED_STATES.includes(item.state) || item.state === "waiting_author");
}

function succeeded(record: OperationRecord): OperationRecord {
  if (record.state !== "succeeded") throw new Error(record.failure?.message ?? `操作没做成（${record.state}${record.pauseReason ? `：${record.pauseReason}` : ""}）`);
  return record;
}

export async function applyAiDraftInOperation(bookDir: string, input: AiDraftInput): Promise<AiDraftOutcome> {
  if (recipeFor(TEST_AI_DRAFT_KIND) !== recipe) registerRecipe(recipe);
  const record = succeeded(await runToEnd(bookDir, { kind: TEST_AI_DRAFT_KIND, params: input, origin: "chat" }));
  return (record.result as { readonly body: AiDraftOutcome }).body;
}

export interface HistoryChangeDone {
  readonly opId: string;
  readonly summary: string;
  readonly body: HistoryChangeBody;
}

const historyDone = (record: OperationRecord): HistoryChangeDone => {
  const result = succeeded(record).result as { readonly summary: string; readonly body: HistoryChangeBody };
  return { opId: record.opId, summary: result.summary, body: result.body };
};

const withHistoryRecipe = (): void => {
  if (recipeFor(HISTORY_CHANGE_KIND) !== historyChangeRecipe) registerRecipe(historyChangeRecipe);
};

/** 作者在操作历史里点「恢复」：整本恢复到这个存档。 */
export async function restoreInOperation(bookDir: string, snapshot: string): Promise<HistoryChangeDone> {
  withHistoryRecipe();
  return historyDone(await runToEnd(bookDir, { kind: HISTORY_CHANGE_KIND, mode: "restore", params: { snapshot }, origin: "button" }));
}

/** 作者点「撤销上一步」（或带号的「撤回来」）；后来又改过、停下等「全撤」的，照点「全撤」。 */
export async function undoInOperation(bookDir: string, opId?: string): Promise<HistoryChangeDone> {
  withHistoryRecipe();
  let record = await runToEnd(bookDir, { kind: HISTORY_CHANGE_KIND, mode: "undo", params: opId ? { opId } : {}, origin: "button" });
  while (record.state === "waiting_author") {
    const pending = record.pendingActions.find((action) => !action.decisionHash);
    if (!pending) break;
    const resumed = await resumeOperation(bookDir, record.opId, { actionId: pending.actionId, decision: "apply" });
    if (!resumed.ok) throw new Error(`没点上「全撤」：${JSON.stringify(resumed)}`);
    const seq = record.eventSeq;
    record = await untilOperation(bookDir, record.opId, (item) => item.eventSeq > seq && (SETTLED_STATES.includes(item.state) || item.state === "waiting_author"));
  }
  return historyDone(record);
}
