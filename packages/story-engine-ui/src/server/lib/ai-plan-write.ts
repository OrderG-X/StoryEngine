/**
 * 出稿操作里写本章章纲（写作版本 P2a 3.1 的 `plan-save` 步骤）：拟纲那一步只在内存里拟、审、改，最终那份由这里走核心
 * `plan.save` 落盘一次——有回执（幂等键 = opId:stepId，崩了重来回放、不再写）、打存档、栅栏过了才写。
 * 只在操作的应用步骤里用；栅栏不过（停了、书没了、纪元换了）抛 OperationStopped，别的没写成如实抛错。
 */
import { planSave } from "@actalk/story-core";
import { chapterPlanFileText, type ChapterPlan } from "../book/chapter-plan.js";
import { runCommandInOperation } from "./operations/command.js";

export class PlanSaveError extends Error {
  readonly code = "plan_save_failed";
  constructor(message: string) {
    super(message);
    this.name = "PlanSaveError";
  }
}

/** 落盘这份章纲；返回盘上原来是不是就是这一份、写前打的存档点（原来就是这一份不打）。 */
export async function savePlanInOperation(projectDir: string, plan: ChapterPlan): Promise<{ readonly unchanged: boolean; readonly snapshotId?: string }> {
  const { result, snapshotId } = await runCommandInOperation(projectDir, planSave, { chapter: plan.chapter, content: chapterPlanFileText(plan) }, { what: "章纲", caller: "ai" });
  if (!result.ok) throw new PlanSaveError(`第 ${plan.chapter} 章的章纲没存上：${result.message}`);
  return { unchanged: result.result.unchanged, ...(snapshotId ? { snapshotId } : {}) };
}
