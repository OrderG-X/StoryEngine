/**
 * 编辑部（brain）对外入口（2026-10-12 第 1 步：专员底座 + 核账员；T1 收尾：四个可开关的做法；T2：记账员；T3：章纲员）。
 *
 * 新代码都在 brain/ 下，不 import 旧的 agent/tools、agent/story-agent；以后整块搬进独立包。
 * 唯一例外：记账员复用 agent/tools/chapter-delta-declaration.ts 里的纯函数（字段说明 / 解析 / 编号换算）
 * ——任务单 T2 明确要求沿用现有的声明契约函数，两条路共用一套、不另抄一份。
 * 三个专员：核账员（checker，核新稿 / 审章纲）、记账员（ledger，章节声明）、章纲员（planner，拟章纲 / 改章纲）。
 * 核账走哪一路由环境变量 STORY_CHECKER 定（reader＝核账员，带 T1 选出的默认组合，其余＝旧核账，缺省）；
 * 章节声明由 STORY_LEDGER 定（reader＝记账员，其余＝旧声明，缺省）；
 * 拟章纲由 STORY_PLANNER 定（reader＝章纲员，拟 → 核账员审 → 改一轮，其余＝旧路，缺省）。
 * T1.2（缺省切核账员）还没做：题库上「确定」查准下限 46.5% / 查全 37%，没到 40% / 50% 的过关线，
 * 差距分析见 docs/editorial-room/reports/T1-2026-10-12.md，等 Claude 定。
 */
import { DEFAULT_READER_VARIANT, callConfiguredBrainModel, checkerRoleFor } from "./checker.js";
import { LEDGER_ROLE } from "./ledger.js";
import { PLANNER_ROLE, callConfiguredPlannerModel } from "./planner.js";
import { ensureReaderWindow, type BrainCallModel, type ReaderRole } from "./reader-window.js";

export {
  CHECKER_ROLE,
  CHECKER_ROLE_STRUCTURED,
  DEFAULT_READER_VARIANT,
  callConfiguredBrainModel,
  checkChapterByReader,
  checkPlanByReader,
  checkerRoleFor,
  planCheckTask,
  parsePlanProblems,
  type PlanProblem,
  type ReaderCheckVariant,
} from "./checker.js";
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
export { ensureReaderWindow, type BrainCallModel, type BrainMessage, type ReaderRole } from "./reader-window.js";

/**
 * 需要跟读新章节的专员：各带自己的开关（没开的角色不补笔记，省得白调模型）。
 * 核账员的笔记格式跟着 T1 默认组合走（选了结构化笔记就按结构化补）。
 * 调用时才组表：planner ↔ plan-chapter 有循环引用（都是调用时才用到对方），顶层读别的模块的常量会在某些加载顺序下踩 TDZ。
 */
const readerRoles = (): readonly { readonly role: ReaderRole; readonly enabled: () => boolean }[] => [
  { role: checkerRoleFor(DEFAULT_READER_VARIANT.structuredNotes), enabled: isReaderCheckerEnabled },
  { role: LEDGER_ROLE, enabled: isReaderLedgerEnabled },
  { role: PLANNER_ROLE, enabled: isReaderPlannerEnabled },
];

/** 环境变量 STORY_CHECKER=reader：核账走核账员，定稿后后台给它补笔记。 */
export function isReaderCheckerEnabled(): boolean {
  return process.env.STORY_CHECKER === "reader";
}

/** 环境变量 STORY_LEDGER=reader：定稿预览的章节声明走记账员，定稿后后台给它补笔记。 */
export function isReaderLedgerEnabled(): boolean {
  return process.env.STORY_LEDGER === "reader";
}

/** 环境变量 STORY_PLANNER=reader：拟章纲走章纲员（核账员审章纲），定稿后后台补笔记。 */
export function isReaderPlannerEnabled(): boolean {
  return process.env.STORY_PLANNER === "reader";
}

/**
 * 后台给专员补笔记到第 upTo 章。永不抛错：补不成只 console.warn（下次核账或定稿会接着补），
 * 所以调用方可以放心 `void`。
 * roles：显式点名要补的角色（调用方自己知道刚才走的是哪一路，比如核账服务的回退路径点名 checker）；
 * 缺省补所有开关开着的角色（没开的角色不白调模型）。
 */
export async function catchUpReaders(
  projectDir: string,
  upTo: number,
  options: { readonly callModel?: BrainCallModel; readonly notesRoot?: string; readonly roles?: readonly string[] } = {},
): Promise<void> {
  const wanted = options.roles
    ? readerRoles().filter(({ role }) => options.roles!.includes(role.id))
    : readerRoles().filter(({ enabled }) => enabled());
  for (const { role } of wanted) {
    try {
      await ensureReaderWindow({
        projectDir,
        role,
        upTo,
        callModel: options.callModel ?? callConfiguredBrainModel,
        ...(options.notesRoot ? { notesRoot: options.notesRoot } : {}),
      });
    } catch (error) {
      console.warn(`[brain] ${role.id} 补读书笔记没成（不影响定稿和核账，下次接着补）`, error);
    }
  }
}

/** 定稿后预热：后台给专员补笔记到刚定稿的这一章。只在有角色开着（STORY_CHECKER / STORY_LEDGER / STORY_PLANNER = reader）时干活，不阻塞定稿。 */
export function warmUpReaders(
  projectDir: string,
  chapter: number,
  options: { readonly callModel?: BrainCallModel; readonly notesRoot?: string } = {},
): Promise<void> {
  if (!readerRoles().some(({ enabled }) => enabled())) return Promise.resolve();
  return catchUpReaders(projectDir, chapter, options);
}
