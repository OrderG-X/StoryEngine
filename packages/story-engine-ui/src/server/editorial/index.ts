/**
 * 编辑部（brain）对外入口（2026-10-12 第 1 步：专员底座 + 核账员；T1 收尾：四个可开关的做法；T2：记账员；T3：章纲员；T5 长书：后台补读）。
 *
 * 编辑部在服务端第 4 层（见 tools/guards/boundaries.json）：不引流程、对话 AI、HTTP 出口；模型经基础设施调用。
 * 三个专员：核账员（checker，核新稿 / 审章纲）、记账员（ledger，章节声明）、章纲员（planner，拟章纲 / 改章纲）。
 *
 * R3（2026-10-12）删旧路后三个专员就是仅有的路（combo 核账 / 旧声明 / 旧拟纲已删，STORY_CHECKER / STORY_LEDGER /
 * STORY_PLANNER 三个开关随之删除）。
 * 核账员默认带 T1 选出的 A 自复核 + R2.1 赢下的 F 时间线只进自复核（DEFAULT_READER_VARIANT，check-service 的产品路传它）。
 * 预热和后台补读对三个角色都生效，且共用同一条补读队列、按角色依次补（见 catch-up.ts）。
 */
import {
  isReaderCatchUpQueued,
  markReaderCatchUpQueued,
  readReaderProgress,
  runInReaderCatchUpQueue,
  startReaderCatchUp,
  unmarkReaderCatchUpQueued,
  writeReaderReadingProgress,
} from "./catch-up.js";
import { DEFAULT_READER_VARIANT, callConfiguredBrainModel, checkerRoleFor } from "./checker.js";
import { LEDGER_ROLE } from "./ledger-keeper.js";
import { PLANNER_ROLE, callConfiguredPlannerModel } from "./planner.js";
import { countCommittedChapters, ensureReaderWindow, type BrainCallModel, type ReaderRole } from "./reader-window.js";
import { beginReread, runReread } from "./reread.js";
import { readRereadState } from "./reread-state.js";

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
  selfReviewTask,
  settingCheckTask,
  type PlanProblem,
  type ReaderCheckVariant,
} from "./checker.js";
export { foundationMessage, readFoundationDigest, settingQuoteLabel, type FoundationDigest } from "./foundation-digest.js";
export {
  isReaderCatchUpQueued,
  readReaderProgress,
  readReadersCatchUpStatus,
  runInReaderCatchUpQueue,
  startReaderCatchUp,
  writeReaderReadingProgress,
  READER_ROLE_IDS,
  type ReaderCatchUpRoleState,
  type ReaderProgress,
  type ReadersCatchUpStatus,
  type RereadStatus,
} from "./catch-up.js";
export { isRereadActive, REREAD_ATTEMPTS } from "./reread.js";
export { formatRereadEta, readRereadState, rereadBlocker, rereadEtaMinutes, type RereadState } from "./reread-state.js";
export {
  describeReaderWait,
  formatReaderWaitDuration,
  readerWaitingHandlers,
  READER_ROLE_LABELS,
  type ReaderWaited,
} from "./reader-progress.js";
export { LEDGER_ROLE };
export {
  brainstormChapter,
  BRAINSTORM_OPTIONS,
  type BrainstormOption,
  type BrainstormProblem,
  type BrainstormResult,
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
  COLD_RECENT_CHAPTERS,
  COLD_RECENT_MAX_CHARS,
  countCommittedChapters,
  ensureReaderWindow,
  READER_WINDOW_MAX_CHARS,
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
const readerRoles = (): readonly ReaderRole[] => [
  checkerRoleFor(DEFAULT_READER_VARIANT.structuredNotes),
  LEDGER_ROLE,
  PLANNER_ROLE,
];

/**
 * 后台给各专员补笔记到第 upTo 章（每个角色带进度落盘，见 catch-up.ts）。永不抛错：补不成只 console.warn
 * （下次核账或定稿会接着补），所以调用方可以放心 `void`。
 * 三个角色共用同一条补读队列（每本书一条），按 checker → ledger → planner 依次补，不同时并发打服务商；
 * 同一本书、同一组角色已有一轮要读到 ≥ upTo 的补读在队里时，这次不重排（角色不同不算，照排）。
 * R5.3：一轮读的途中作者又定稿了新章的话，这轮自己追到新末尾（见 catch-up.ts 的追新），不靠后面的预热补漏。
 * roles：显式点名要补的角色（调用方自己知道刚才等的是哪个角色，比如核账服务点名 checker）；缺省补全部三个角色。
 */
export async function catchUpReaders(
  projectDir: string,
  upTo: number,
  options: { readonly callModel?: BrainCallModel; readonly notesRoot?: string; readonly roles?: readonly string[] } = {},
): Promise<void> {
  const wanted = options.roles
    ? readerRoles().filter((role) => options.roles!.includes(role.id))
    : readerRoles();
  if (wanted.length === 0) return;
  const root = options.notesRoot ?? projectDir;
  const roleIds = wanted.map((role) => role.id);
  if (isReaderCatchUpQueued(root, roleIds, upTo)) return;
  markReaderCatchUpQueued(root, roleIds, upTo);
  try {
    await runInReaderCatchUpQueue(root, async () => {
      // R5.3 追新的基线：这轮真正开跑那一刻的已定稿章数，三个角色共用——读的途中新定稿的章，没轮到的角色也要追。
      const chaseFrom = await countCommittedChapters(projectDir).catch(() => 0);
      for (const role of wanted) await startReaderCatchUp(projectDir, role, upTo, { ...options, chaseFrom });
    });
  } finally {
    unmarkReaderCatchUpQueued(root, roleIds, upTo);
  }
}

/** 定稿后预热：后台给三个专员补笔记到刚定稿的这一章（走同一条队列依次补），不阻塞定稿。 */
export function warmUpReaders(
  projectDir: string,
  chapter: number,
  options: { readonly callModel?: BrainCallModel; readonly notesRoot?: string } = {},
): Promise<void> {
  return catchUpReaders(projectDir, chapter, options);
}

/**
 * 打开书（state-overview）时看一眼：哪个专员的笔记还没读齐 → 后台按共用队列接着补。
 * 已经在读（队列里去重）/ 已经读齐就不再排；没有定稿章节的书不排。永不抛错。
 * R4.3：排进队后、返回之前，先把第一个要读的角色标成 reading（done 接着已有的），
 * 这样路由紧接着建的开书概况就带得上进度，不用刷新页面才看到。
 */
export async function maybeStartReadersCatchUp(
  projectDir: string,
  options: { readonly callModel?: BrainCallModel } = {},
): Promise<void> {
  try {
    // P8：导入的书还在通读记账（进程重启前在记）→ 接着记；记完它自己排后台补读。停下的等作者点「接着记」。
    const reread = await readRereadState(projectDir);
    if (reread && reread.status !== "done") {
      if (reread.status === "running") void runBookReread(projectDir, options);
      return;
    }
    const wanted = readerRoles();
    const total = await countCommittedChapters(projectDir);
    if (total <= 0) return;
    for (const role of wanted) {
      const progress = await readReaderProgress(projectDir, role.id);
      if (!progress || progress.reading || progress.done < total) {
        // 队列按 checker → ledger → planner 依次补，第一个没读齐的就是第一个要读的；
        // 它已经在读（上次开着开着又刷新了页面）就不用重写，盘上的进度本来就是真的。
        await writeReaderReadingProgress(projectDir, role.id, total).catch(() => undefined);
        void catchUpReaders(projectDir, total, options);
        return;
      }
    }
  } catch (error) {
    console.warn("[brain] 看要不要后台补读时出错（不影响开书）", error);
  }
}

/**
 * 跑（或接着跑）导入的书的通读记账（P8）。记完排三个专员的后台补读（记账员只差最后一章的笔记，核账员、章纲员从头读）。
 * 永不抛错，调用方放心 `void`。
 */
export function runBookReread(projectDir: string, options: { readonly callModel?: BrainCallModel } = {}): Promise<void> {
  return runReread(projectDir, {
    ...options,
    onDone: (total) => void catchUpReaders(projectDir, total, options),
  });
}

/** 导入后开一轮新的通读：先落状态（开书那次概况就带得上进度），再在后台跑。 */
export async function startBookReread(projectDir: string, total: number, options: { readonly callModel?: BrainCallModel } = {}): Promise<void> {
  await beginReread(projectDir, total);
  void runBookReread(projectDir, options);
}
