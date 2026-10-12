/**
 * 编辑部（brain）对外入口（2026-10-12 第 1 步：专员底座 + 核账员；第 3 步：章纲员）。
 *
 * 新代码都在 brain/ 下，不 import 旧的 agent/tools、agent/story-agent；以后整块搬进独立包。
 * 现在有两个专员：核账员（核新稿 / 审章纲）和章纲员（拟章纲 / 改章纲）。走哪一路由环境变量定：
 * STORY_CHECKER=reader 核账走核账员；STORY_PLANNER=reader 拟章纲走章纲员（拟 → 核账员审 → 改一轮）；缺省都走旧路。
 */
import { CHECKER_ROLE, callConfiguredBrainModel } from "./checker.js";
import { PLANNER_ROLE, callConfiguredPlannerModel } from "./planner.js";
import { ensureReaderWindow, type BrainCallModel, type ReaderRole } from "./reader-window.js";

export { CHECKER_ROLE, callConfiguredBrainModel, checkChapterByReader, checkPlanByReader, planCheckTask, parsePlanProblems, type PlanProblem } from "./checker.js";
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

/** 需要跟读新章节的专员。调用时才组表：planner ↔ plan-chapter 有循环引用（都是调用时才用到对方），顶层读别的模块的常量会在某些加载顺序下踩 TDZ。 */
const readerRoles = (): readonly ReaderRole[] => [CHECKER_ROLE, PLANNER_ROLE];

/** 环境变量 STORY_CHECKER=reader：核账走核账员，定稿后后台给它补笔记。 */
export function isReaderCheckerEnabled(): boolean {
  return process.env.STORY_CHECKER === "reader";
}

/** 环境变量 STORY_PLANNER=reader：拟章纲走章纲员（核账员审章纲），定稿后后台补笔记。 */
export function isReaderPlannerEnabled(): boolean {
  return process.env.STORY_PLANNER === "reader";
}

/**
 * 后台给各专员补笔记到第 upTo 章。永不抛错：补不成只 console.warn（下次核账或定稿会接着补），
 * 所以调用方可以放心 `void`。
 */
export async function catchUpReaders(
  projectDir: string,
  upTo: number,
  options: { readonly callModel?: BrainCallModel; readonly notesRoot?: string } = {},
): Promise<void> {
  for (const role of readerRoles()) {
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

/** 定稿后预热：后台给专员补笔记到刚定稿的这一章。核账员或章纲员任一开启就干活，不阻塞定稿。 */
export function warmUpReaders(
  projectDir: string,
  chapter: number,
  options: { readonly callModel?: BrainCallModel; readonly notesRoot?: string } = {},
): Promise<void> {
  if (!isReaderCheckerEnabled() && !isReaderPlannerEnabled()) return Promise.resolve();
  return catchUpReaders(projectDir, chapter, options);
}
