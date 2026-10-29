/**
 * 额度算式（写作版本 P2a 4.5）：每个配方按代码里的常数算最坏情况，只数可能计费的物理发送。
 * 常数都从各专员 import：改了常数，额度跟着变。兼容改参按这次冻结的模型另加（frozenCompatAllowance），受理时算、接着做时再算。
 */
import { DEFAULT_READER_VARIANT, READER_CALL_MAX_SENDS, readerCheckCalls, readerRecheckCalls } from "../../editorial/checker.js";
import { READER_MAX_CATCH_UP, READER_MAX_VOLUME_BUILDS } from "../../editorial/continuity/check-service.js";
import { volumeBuildsBound } from "../../editorial/reader-window.js";
import { PLANNER_MAX_CATCH_UP } from "../../editorial/plan-chapter.js";
import { PLANNER_DRAFT_CALLS, PLANNER_REVISE_CALLS, PLANNER_THINKING_CALL_MAX_SENDS } from "../../editorial/planner.js";
import { MODEL_CALL_MAX_SENDS, type ModelTaskProfileKey } from "../../lib/llm-client.js";
import { WRITER_MAX_CALLS } from "../../writing/fast-draft-writer.js";
import { CONTINUE_MAX_ROUNDS } from "../draft-pipeline/continue-draft.js";
import { CONTINUE_CALL_MAX_SENDS } from "../draft-pipeline/production-call-models.js";
import type { DraftChangeMode } from "../draft-change/params.js";
import type { InspectMode } from "../inspect-service.js";
import { UNIT_FIX_MAX_CALLS } from "../unit-fix.js";

/** 核账员当场补读那一步：章上限 × 每次 + 卷节点上限 × 每次。 */
export const READER_NOTES_SENDS = (READER_MAX_CATCH_UP + READER_MAX_VOLUME_BUILDS) * READER_CALL_MAX_SENDS;

/** 核一次：整章核和只核改过的取大的（走哪条开工时不知道）。 */
export const READER_CHECK_SENDS = Math.max(readerCheckCalls(DEFAULT_READER_VARIANT), readerRecheckCalls(DEFAULT_READER_VARIANT)) * READER_CALL_MAX_SENDS;

/** 审稿、查 AI 味：各一次调用（draftReview 槽，主 + 备用）。 */
export const SINGLE_CALL_SENDS = MODEL_CALL_MAX_SENDS;

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

/**
 * 后台补读整次（Astra P2a 第 9 轮第 5 条）：每个角色冻结的章数 + 这段里最多新生成的卷节点（volumeBuildsBound：
 * 窗口从写第 from 章那一刻涨到读完第 to 章；同一次里同一个卷节点只生成一次），× 每次。
 */
export function backfillBudget(ranges: readonly { readonly from: number; readonly to: number }[]): number {
  return ranges.reduce((sum, range) => sum + (range.to - range.from + 1 + volumeBuildsBound(range.from - 1, range.to)) * READER_CALL_MAX_SENDS, 0);
}

/** 后台补读第 chapter 章那一步最多新生成几个卷节点（写它时的窗口 + 读完它的窗口）：这一步的上限，到了就是规划出了错。 */
export const backfillStepVolumeBuilds = (chapter: number): number => volumeBuildsBound(chapter - 1, chapter);

/** 后台补读第 chapter 章那一步最多发几次：这一章的笔记 1 次 + 这一步的卷节点上限（接着做时按它加额度）。 */
export const backfillStepSends = (chapter: number): number => (1 + backfillStepVolumeBuilds(chapter)) * READER_CALL_MAX_SENDS;

export const sumBudget = (steps: Readonly<Record<string, number>>): number => Object.values(steps).reduce((sum, value) => sum + value, 0);

/** 章纲员补笔记：写笔记关思考，一次调用 = 主 + 备用。 */
const PLANNER_NOTES_SENDS = (PLANNER_MAX_CATCH_UP + READER_MAX_VOLUME_BUILDS) * MODEL_CALL_MAX_SENDS;

/** 拟纲：拟（含自动重拟）× 每次 + 核账员审一次 + 改一轮。 */
const PLAN_SENDS = PLANNER_DRAFT_CALLS * PLANNER_THINKING_CALL_MAX_SENDS + READER_CALL_MAX_SENDS + PLANNER_REVISE_CALLS * PLANNER_THINKING_CALL_MAX_SENDS;

/** 写一版：写手最多几次调用（按要点分两半写最多；接着写分两半）× 每次 + 这一版的判漏复核一次。 */
const writeSends = (mode: DraftChangeMode): number =>
  (mode === "continue" ? WRITER_MAX_CALLS.continue : Math.max(WRITER_MAX_CALLS.whole, WRITER_MAX_CALLS.halves)) * MODEL_CALL_MAX_SENDS + SINGLE_CALL_SENDS;

/**
 * draft.change 每一步最多发几次（设计 4.5、3.1）：write 有 notes（两个角色）、plan、extend；continue 只有核账员的 notes、没有拟纲和补字数。
 * 写一版一步（`write:<n>`），多版按版数各算一份。select、plan-save、bundle、apply 不调模型。
 */
export function draftChangeStepBudget(mode: DraftChangeMode, versions: number): Readonly<Record<string, number>> {
  const steps: Record<string, number> = {
    notes: (mode === "write" ? PLANNER_NOTES_SENDS : 0) + READER_NOTES_SENDS,
    deai: SINGLE_CALL_SENDS,
    check: READER_CHECK_SENDS,
    fix: UNIT_FIX_MAX_CALLS * MODEL_CALL_MAX_SENDS,
    // 改完再核 + 终稿判漏复核。
    recheck: READER_CHECK_SENDS + SINGLE_CALL_SENDS,
  };
  if (mode === "write") {
    steps.plan = PLAN_SENDS;
    steps.extend = CONTINUE_MAX_ROUNDS * CONTINUE_CALL_MAX_SENDS;
  }
  for (let version = 1; version <= versions; version += 1) steps[`write:${version}`] = writeSends(mode);
  return steps;
}

/** draft.change 用到的模型任务：写手（写、补字数）、章纲员、核账员、改句和去味、判漏复核。 */
export function draftChangeTasks(mode: DraftChangeMode): readonly ModelTaskProfileKey[] {
  return mode === "write"
    ? ["fastDraft", "chapterSteering", "qualityCheck", "repair", "triage"]
    : ["fastDraft", "qualityCheck", "repair", "triage"];
}
