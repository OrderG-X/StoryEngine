/**
 * 额度算式（写作版本 P2a 4.5）：每个配方按代码里的常数算最坏情况，只数可能计费的物理发送。
 * 常数都从各专员 import：改了常数，额度跟着变。兼容改参按这次冻结的模型另加（frozenCompatAllowance），受理时算、接着做时再算。
 */
import { DEFAULT_READER_VARIANT, READER_CALL_MAX_SENDS, readerCheckCalls, readerRecheckCalls } from "../../editorial/checker.js";
import { READER_MAX_CATCH_UP, READER_MAX_VOLUME_BUILDS } from "../../editorial/continuity/check-service.js";
import { MODEL_CALL_MAX_SENDS } from "../../lib/llm-client.js";

/** 核账员当场补读那一步：章上限 × 每次 + 卷节点上限 × 每次。 */
export const READER_NOTES_SENDS = (READER_MAX_CATCH_UP + READER_MAX_VOLUME_BUILDS) * READER_CALL_MAX_SENDS;

/** 核一次：整章核和只核改过的取大的（走哪条开工时不知道）。 */
export const READER_CHECK_SENDS = Math.max(readerCheckCalls(DEFAULT_READER_VARIANT), readerRecheckCalls(DEFAULT_READER_VARIANT)) * READER_CALL_MAX_SENDS;

/** 审稿、查 AI 味：各一次调用（draftReview 槽，主 + 备用）。 */
export const SINGLE_CALL_SENDS = MODEL_CALL_MAX_SENDS;

export type InspectMode = "continuity" | "quality" | "review" | "flavor";

/** inspect.run 每一步最多发几次（不含兼容改参）。质检是确定性检查，0。 */
export function inspectStepBudget(mode: InspectMode): Readonly<Record<string, number>> {
  switch (mode) {
    case "continuity":
      return { notes: READER_NOTES_SENDS, check: READER_CHECK_SENDS };
    case "review":
    case "flavor":
      return { run: SINGLE_CALL_SENDS };
    case "quality":
      return {};
  }
}

/** inspect.run 用到的模型任务（兼容改参按它们冻结的模型去重算）。 */
export function inspectTasks(mode: InspectMode): readonly ("qualityCheck" | "draftReview")[] {
  if (mode === "continuity") return ["qualityCheck"];
  if (mode === "review" || mode === "flavor") return ["draftReview"];
  return [];
}

/** 后台补读：冻结的章数 × 每次 + 卷节点上限 × 每次（每一步一章；卷笔记按每步的上限算，见 background.backfill）。 */
export function backfillBudget(chapters: number, volumeBuilds: number): number {
  return (chapters + volumeBuilds) * READER_CALL_MAX_SENDS;
}

export const sumBudget = (steps: Readonly<Record<string, number>>): number => Object.values(steps).reduce((sum, value) => sum + value, 0);
