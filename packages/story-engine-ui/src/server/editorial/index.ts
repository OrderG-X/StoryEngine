/**
 * 编辑部（brain）对外入口（2026-10-12 第 1 步：专员底座 + 核账员；T1 收尾：四个可开关的做法；T2：记账员；T3：章纲员；T5 长书：后台补读）。
 *
 * 编辑部在服务端第 4 层（见 tools/guards/boundaries.json）：不引流程、对话 AI、HTTP 出口；模型经基础设施调用。
 * 三个专员：核账员（checker，核新稿 / 审章纲）、记账员（ledger，章节声明）、章纲员（planner，拟章纲 / 改章纲）。
 *
 * R3（2026-10-12）删旧路后三个专员就是仅有的路（combo 核账 / 旧声明 / 旧拟纲已删，STORY_CHECKER / STORY_LEDGER /
 * STORY_PLANNER 三个开关随之删除）。
 * 核账员默认带 T1 选出的 A 自复核 + R2.1 赢下的 F 时间线只进自复核（DEFAULT_READER_VARIANT，check-service 的产品路传它）。
 * 预热和后台补读对三个角色都生效：都交给执行器的 background.backfill（lib/reader-backfill.ts 的提交口），每本书一条补读队列、按角色依次补。
 */
import { DEFAULT_READER_VARIANT, checkerRoleFor } from "./checker.js";
import { LEDGER_ROLE } from "./ledger-keeper.js";
import { PLANNER_ROLE } from "./planner.js";
import { countCommittedChapters, type BrainCallModel, type ReaderRole } from "./reader-window.js";
import { beginReread, runReread } from "./reread.js";
import { readRereadState } from "./reread-state.js";
import { requestReaderBackfill, submitReaderBackfill } from "../lib/reader-backfill.js";
import { withUsageBook } from "../lib/usage-scope.js";

export {
  CHECKER_ROLE,
  CHECKER_ROLE_STRUCTURED,
  DEFAULT_READER_VARIANT,
  callConfiguredBrainModel,
  checkChapterByReader,
  checkPlanByReader,
  checkerRoleFor,
  dropMisdirectedBySetting,
  keywordTask,
  parseKeywords,
  planCheckTask,
  parsePlanProblems,
  parseSettingChecks,
  parseSettingIssues,
  recheckChangesByReader,
  recheckTask,
  selfReviewTask,
  settingCheckTask,
  type ChangedSentence,
  type PlanProblem,
  type ReaderCheckVariant,
} from "./checker.js";
export { foundationMessage, readFoundationDigest, settingQuoteSource, type FoundationDigest, type SettingSource } from "./foundation-digest.js";
export {
  readReadersCatchUpStatus,
  runInReaderCatchUpQueue,
  READER_ROLE_IDS,
  type ReaderCatchUpRoleState,
  type ReadersCatchUpStatus,
  type RereadStatus,
} from "./catch-up.js";
export { isRereadActive, REREAD_ATTEMPTS } from "./reread.js";
export { formatRereadEta, readRereadState, rereadBlocker, rereadEtaMinutes, type RereadState } from "./reread-state.js";
export {
  describeReaderWait,
  readerWaitingHandlers,
  READER_ROLE_LABELS,
  type ReaderWaited,
} from "./reader-progress.js";
export { LEDGER_ROLE };
export { MAX_REVIEW_THREADS, reviewOpenThreads, type ThreadCloseSuggestion, type ThreadReviewOutcome } from "./thread-review.js";
export {
  BRAINSTORM_OPTIONS,
  checkDirections,
  PROPOSE_CALLS,
  proposeDirections,
  type BrainstormOption,
  type BrainstormProblem,
  type CheckedDirections,
  type ProposeResult,
} from "./brainstorm.js";
export {
  PLANNER_ROLE,
  callConfiguredPlannerModel,
  planChapterByPlanner,
  revisePlanByPlanner,
  plannerTask,
  reviseTask,
  type PlanChapterByPlannerResult,
  type RevisePlanResult,
} from "./planner.js";
export {
  assembleReaderWindow,
  buildColdReaderWindow,
  coldPausedNote,
  COLD_PAUSED_TEXT,
  COLD_RECENT_CHAPTERS,
  COLD_RECENT_MAX_CHARS,
  countCommittedChapters,
  ensureReaderWindow,
  readerNotesStatus,
  READER_WINDOW_MAX_CHARS,
  volumeBuildsBound,
  writeAtomically,
  type BrainCallModel,
  type BrainMessage,
  type ColdCoverage,
  type ColdReaderWindow,
  type ReaderRole,
  type VolumeNoteEntry,
} from "./reader-window.js";

/**
 * 需要跟读新章节的专员（三个都在，R3 起没有开关）。
 * 核账员的笔记格式跟着 T1 默认组合走（选了结构化笔记就按结构化补）。
 * 调用时才组表：planner ↔ plan-chapter 有循环引用（都是调用时才用到对方），顶层读别的模块的常量会在某些加载顺序下踩 TDZ。
 */
export const readerRoles = (): readonly ReaderRole[] => [
  checkerRoleFor(DEFAULT_READER_VARIANT.structuredNotes),
  LEDGER_ROLE,
  PLANNER_ROLE,
];

/**
 * 定稿后预热：后台给三个专员补笔记到刚定稿的这一章（交给执行器的 background.backfill），不阻塞定稿。
 * 章纲员排最前：定稿后作者多半接着写下一章，头一步就是拟纲（换题材长篇实跑：拟纲前当场补笔记中位 22 秒）；
 * 核账员接着（审纲、核新稿要它），记账员最后（下次定稿才用）。
 */
export function warmUpReaders(projectDir: string, chapter: number): void {
  const checker = checkerRoleFor(DEFAULT_READER_VARIANT.structuredNotes);
  requestReaderBackfill(projectDir, { roles: [PLANNER_ROLE.id, checker.id, LEDGER_ROLE.id], upTo: chapter });
}

/**
 * 打开书（state-overview）时：导入的书还在通读记账（进程重启前在记）→ 接着记，记完它自己交后台补读；停下的等作者点「接着记」。
 * 其余交一次后台补读到已定稿的最后一章，等交上再返回（开书概况带得上「在读」）。三个专员都读齐了就不受理、什么都不起。永不抛错。
 */
export async function resumeBackgroundReading(projectDir: string, options: { readonly callModel?: BrainCallModel } = {}): Promise<void> {
  try {
    const reread = await readRereadState(projectDir);
    if (reread && reread.status !== "done") {
      if (reread.status === "running") void runBookReread(projectDir, options);
      return;
    }
    const total = await countCommittedChapters(projectDir);
    if (total > 0) await submitReaderBackfill(projectDir, { upTo: total });
  } catch (error) {
    console.warn("[brain] 看要不要后台补读时出错（不影响开书）", error);
  }
}

/**
 * 跑（或接着跑）导入的书的通读记账（P8）。记完排三个专员的后台补读（记账员只差最后一章的笔记，核账员、章纲员从头读）。
 * 永不抛错，调用方放心 `void`。
 */
export function runBookReread(projectDir: string, options: { readonly callModel?: BrainCallModel } = {}): Promise<void> {
  return withUsageBook(projectDir, () => runReread(projectDir, {
    ...options,
    onDone: (total) => requestReaderBackfill(projectDir, { upTo: total }),
  }));
}

/** 导入后开一轮新的通读：先落状态（开书那次概况就带得上进度），再在后台跑。 */
export async function startBookReread(projectDir: string, total: number, options: { readonly callModel?: BrainCallModel } = {}): Promise<void> {
  await beginReread(projectDir, total);
  void runBookReread(projectDir, options);
}
