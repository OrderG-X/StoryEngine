/**
 * 编辑部（brain）对外入口（2026-10-12 第 1 步：专员底座 + 核账员；T1 收尾：四个可开关的做法；T2：记账员；T3：章纲员；T5 长书：后台补读）。
 *
 * 新代码都在 brain/ 下，不 import 旧的 agent/tools、agent/story-agent；以后整块搬进独立包。
 * 唯一例外：记账员复用 agent/tools/chapter-delta-declaration.ts 里的纯函数（字段说明 / 解析 / 编号换算）
 * ——任务单 T2 明确要求沿用现有的声明契约函数，两条路共用一套、不另抄一份。
 * 三个专员：核账员（checker，核新稿 / 审章纲）、记账员（ledger，章节声明）、章纲员（planner，拟章纲 / 改章纲）。
 *
 * R1（2026-10-12）起三个专员都是默认：STORY_CHECKER / STORY_LEDGER / STORY_PLANNER 没设（或设成 reader）走新路；
 * 显式设成 legacy（核账也认 combo）才走旧路——回退只留到 R3 删旧路为止，作排查用。
 * 核账员默认带 T1 选出的 A 自复核（DEFAULT_READER_VARIANT，check-service 的产品路传它）。
 * 预热和后台补读对三个角色都生效，且共用同一条补读队列、按角色依次补（见 catch-up.ts）。
 */
import {
  isReaderCatchUpQueued,
  markReaderCatchUpQueued,
  readReaderProgress,
  runInReaderCatchUpQueue,
  startReaderCatchUp,
  unmarkReaderCatchUpQueued,
} from "./catch-up.js";
import { DEFAULT_READER_VARIANT, callConfiguredBrainModel, checkerRoleFor } from "./checker.js";
import { LEDGER_ROLE } from "./ledger.js";
import { PLANNER_ROLE, callConfiguredPlannerModel } from "./planner.js";
import { countCommittedChapters, ensureReaderWindow, type BrainCallModel, type ReaderRole } from "./reader-window.js";

export {
  CHECKER_ROLE,
  CHECKER_ROLE_STRUCTURED,
  DEFAULT_READER_VARIANT,
  callConfiguredBrainModel,
  checkChapterByReader,
  checkPlanByReader,
  checkerRoleFor,
  keywordTask,
  parseKeywords,
  planCheckTask,
  parsePlanProblems,
  selfReviewTask,
  type PlanProblem,
  type ReaderCheckVariant,
} from "./checker.js";
export { isReaderCatchUpQueued, readReaderProgress, runInReaderCatchUpQueue, startReaderCatchUp, type ReaderProgress } from "./catch-up.js";
export { LEDGER_ROLE, declareChapterDeltaByLedger, type LedgerDeclareInput, type LedgerDeclareResult } from "./ledger.js";
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
  countCommittedChapters,
  ensureReaderWindow,
  READER_WINDOW_MAX_CHARS,
  writeAtomically,
  type BrainCallModel,
  type BrainMessage,
  type ReaderRole,
  type VolumeNoteEntry,
} from "./reader-window.js";

/**
 * 需要跟读新章节的专员：各带自己的开关（R1 起缺省都开，显式 legacy 才关——没开的角色不补笔记，省得白调模型）。
 * 核账员的笔记格式跟着 T1 默认组合走（选了结构化笔记就按结构化补）。
 * 调用时才组表：planner ↔ plan-chapter 有循环引用（都是调用时才用到对方），顶层读别的模块的常量会在某些加载顺序下踩 TDZ。
 */
const readerRoles = (): readonly { readonly role: ReaderRole; readonly enabled: () => boolean }[] => [
  { role: checkerRoleFor(DEFAULT_READER_VARIANT.structuredNotes), enabled: isReaderCheckerEnabled },
  { role: LEDGER_ROLE, enabled: isReaderLedgerEnabled },
  { role: PLANNER_ROLE, enabled: isReaderPlannerEnabled },
];

/** 旧路的显式值：设成这些才走旧路（R1 起没设 = 新路；回退留到 R3 删旧路为止，作排查用）。核账的旧路值 combo 也认。 */
const LEGACY_SWITCH_VALUES = new Set(["legacy", "combo"]);

/** STORY_CHECKER：没设（或 reader）＝核账员，显式 legacy / combo ＝旧核账。 */
export function isReaderCheckerEnabled(): boolean {
  return !LEGACY_SWITCH_VALUES.has(process.env.STORY_CHECKER ?? "");
}

/** STORY_LEDGER：没设（或 reader）＝记账员，显式 legacy ＝旧声明。 */
export function isReaderLedgerEnabled(): boolean {
  return !LEGACY_SWITCH_VALUES.has(process.env.STORY_LEDGER ?? "");
}

/** STORY_PLANNER：没设（或 reader）＝章纲员，显式 legacy ＝旧路拟纲。 */
export function isReaderPlannerEnabled(): boolean {
  return !LEGACY_SWITCH_VALUES.has(process.env.STORY_PLANNER ?? "");
}

/**
 * 后台给各专员补笔记到第 upTo 章（每个角色带进度落盘，见 catch-up.ts）。永不抛错：补不成只 console.warn
 * （下次核账或定稿会接着补），所以调用方可以放心 `void`。
 * R1 起：三个角色共用同一条补读队列（每本书一条），按 checker → ledger → planner 依次补，不同时并发打服务商；
 * 同一本书、同一组角色已有一轮要读到 ≥ upTo 的补读在队里时，这次不重排（角色不同不算，照排）。
 * roles：显式点名要补的角色（调用方自己知道刚才走的是哪一路，比如核账服务的回退路径点名 checker）；
 * 缺省补所有开着的角色（没开的角色不白调模型）。
 */
export async function catchUpReaders(
  projectDir: string,
  upTo: number,
  options: { readonly callModel?: BrainCallModel; readonly notesRoot?: string; readonly roles?: readonly string[] } = {},
): Promise<void> {
  const wanted = options.roles
    ? readerRoles().filter(({ role }) => options.roles!.includes(role.id))
    : readerRoles().filter(({ enabled }) => enabled());
  if (wanted.length === 0) return;
  const root = options.notesRoot ?? projectDir;
  const roleIds = wanted.map(({ role }) => role.id);
  if (isReaderCatchUpQueued(root, roleIds, upTo)) return;
  markReaderCatchUpQueued(root, roleIds, upTo);
  try {
    await runInReaderCatchUpQueue(root, async () => {
      for (const { role } of wanted) await startReaderCatchUp(projectDir, role, upTo, options);
    });
  } finally {
    unmarkReaderCatchUpQueued(root, roleIds, upTo);
  }
}

/** 定稿后预热：后台给专员补笔记到刚定稿的这一章（缺省三个角色都补，走同一条队列依次补），不阻塞定稿。 */
export function warmUpReaders(
  projectDir: string,
  chapter: number,
  options: { readonly callModel?: BrainCallModel; readonly notesRoot?: string } = {},
): Promise<void> {
  if (!readerRoles().some(({ enabled }) => enabled())) return Promise.resolve();
  return catchUpReaders(projectDir, chapter, options);
}

/**
 * 打开书（state-overview）时看一眼：开着的专员里谁的笔记还没读齐 → 后台按共用队列接着补。
 * 已经在读（队列里去重）/ 已经读齐就不再排；没有定稿章节的书不排。永不抛错。
 */
export async function maybeStartReadersCatchUp(
  projectDir: string,
  options: { readonly callModel?: BrainCallModel } = {},
): Promise<void> {
  try {
    const wanted = readerRoles().filter(({ enabled }) => enabled());
    if (wanted.length === 0) return;
    const total = await countCommittedChapters(projectDir);
    if (total <= 0) return;
    for (const { role } of wanted) {
      const progress = await readReaderProgress(projectDir, role.id);
      if (!progress || progress.reading || progress.done < total) {
        void catchUpReaders(projectDir, total, options);
        return;
      }
    }
  } catch (error) {
    console.warn("[brain] 看要不要后台补读时出错（不影响开书）", error);
  }
}
