/**
 * draft-change-kit —— 写稿（draft.change）测试的公共基建（非测试文件，无断言）。
 *
 * 真配方、真执行器、真核心写盘，只换模型：章纲员、核账员、写手、补字数、按核账改、去 AI 味、判漏都给假的，
 * 缺省是「拟一份纲、核出没问题、写手照给的写」。交一次写稿、等它跑完，拿回记录和结果体。
 * 各测试要在写的途中插一手（作者存稿、改纲、改账……）就在写手里做。
 */
import type { BrainCallModel } from "../../../editorial/index.js";
import type { WriterClient } from "../../../writing/fast-draft-writer.js";
import { readOperation, type OperationRecord } from "../../../lib/operations/store.js";
import type { DraftEditBody } from "../../draft-change/edit.js";
import { DRAFT_CHANGE_KIND, type DraftChangeMode, type DraftEditMode } from "../../draft-change/params.js";
import type { DraftChangeBody } from "../../draft-change/result.js";
import { __drainOperationsForTests, registerRecipe, submitOperation, type OperationResult, type SubmitOutcome } from "../executor.js";
import { createDraftChangeRecipe, type DraftChangeDeps } from "./draft-change.js";

/** 一份能用的章纲（JSON）。 */
export const planJson = (summary: string): string =>
  JSON.stringify({ summary, beats: [summary], characters: [], newInformation: [summary], scene: { location: "河岸", time: "上午" }, dayOffset: 0 });

/** 假章纲员：拟纲回 summary 那份，写笔记回一句。 */
export const fakePlanner = (summary = "照故事往下推"): BrainCallModel => async (_messages, options) => (options?.json ? planJson(summary) : "笔记。");

/** 假核账员：审纲、核账都说没问题，写笔记回一句。 */
export const quietReader: BrainCallModel = async (_messages, options) =>
  (options?.json ? JSON.stringify({ problems: [], checks: [], contradictions: [] }) : "笔记。");

/** 写手照给的写（每次调都回同一份；要在途中插一手就自己写 generateDraft）。 */
export const writerOf = (content: string, title?: string): WriterClient => ({
  async generateDraft() {
    return { ...(title ? { title } : {}), content };
  },
});

/** 假模型全套：缺省都是「没事」，给了的换上。writerClient 给了就不管流式和温度。 */
export function fakeDraftDeps(overrides: Partial<DraftChangeDeps> & { readonly writerClient?: WriterClient } = {}): DraftChangeDeps {
  const { writerClient, ...rest } = overrides;
  return {
    plannerCallModel: fakePlanner(),
    readerCallModel: quietReader,
    writer: async () => writerClient ?? writerOf("林远沿着河岸走了很久。"),
    writerTemperature: async () => 0.8,
    continueCallModel: async () => "",
    fixCallModel: async () => "{}",
    deAiCallModel: async () => "{}",
    beatAdjudicationCallModel: async () => "{}",
    modelProblem: () => undefined,
    ...rest,
  };
}

let keySeq = 0;

/** 用这套假模型登记写稿配方，交一次（不等它跑）。改稿三种也走它。 */
export function submitDraftChange(
  bookDir: string,
  mode: DraftChangeMode | DraftEditMode,
  params: Record<string, unknown>,
  deps: DraftChangeDeps = fakeDraftDeps(),
): Promise<SubmitOutcome> {
  registerRecipe(createDraftChangeRecipe(deps));
  keySeq += 1;
  return submitOperation(bookDir, {
    kind: DRAFT_CHANGE_KIND,
    mode,
    params,
    requestKey: `draft-kit-${keySeq}`,
    issuedAt: new Date().toISOString(),
    origin: { kind: "button", ...(typeof params.chapter === "number" ? { chapter: params.chapter } : {}) },
  });
}

/** 等这次写稿跑完（停着的也算停下了），读回记录。 */
export async function settledDraftChange(bookDir: string, opId: string): Promise<OperationRecord> {
  await __drainOperationsForTests();
  const stored = await readOperation(bookDir, opId);
  if (stored.kind !== "record") throw new Error("记录没了");
  return stored.record;
}

/** 交一次写稿、等它跑完：记录 + 结果体（没做成的结果体是 undefined）。没受理就抛（测试里写错了）。 */
export async function runDraftChange(
  bookDir: string,
  mode: DraftChangeMode,
  params: Record<string, unknown>,
  deps: DraftChangeDeps = fakeDraftDeps(),
): Promise<{ readonly record: OperationRecord; readonly body?: DraftChangeBody; readonly summary?: string }> {
  const outcome = await submitDraftChange(bookDir, mode, params, deps);
  if (!outcome.ok || !("record" in outcome)) throw new Error(`没受理：${JSON.stringify(outcome)}`);
  const record = await settledDraftChange(bookDir, outcome.record.opId);
  const result = record.result as (OperationResult & { readonly body?: DraftChangeBody }) | undefined;
  return { record, ...(result?.body ? { body: result.body } : {}), ...(result?.summary ? { summary: result.summary } : {}) };
}

/** 交一次改稿（revise / fix / deai）、等它停下：记录 + 结果体（没做成、在等作者的结果体是 undefined）。没受理就抛。 */
export async function runDraftEdit(
  bookDir: string,
  mode: DraftEditMode,
  params: Record<string, unknown>,
  deps: DraftChangeDeps = fakeDraftDeps(),
): Promise<{ readonly record: OperationRecord; readonly body?: DraftEditBody; readonly summary?: string }> {
  const outcome = await submitDraftChange(bookDir, mode, params, deps);
  if (!outcome.ok || !("record" in outcome)) throw new Error(`没受理：${JSON.stringify(outcome)}`);
  const record = await settledDraftChange(bookDir, outcome.record.opId);
  const result = record.result as (OperationResult & { readonly body?: DraftEditBody }) | undefined;
  return { record, ...(result?.body ? { body: result.body } : {}), ...(result?.summary ? { summary: result.summary } : {}) };
}
