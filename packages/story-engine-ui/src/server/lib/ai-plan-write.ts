/**
 * 出稿操作里写本章章纲（写作版本 P2a 3.1 的 `plan-save` 步骤）：拟纲那一步只在内存里拟、审、改，最终那份由这里走核心
 * `plan.save` 落盘一次——有回执（幂等键 = opId:stepId，崩了重来回放、不再写）、打存档、栅栏过了才写。
 * 只在操作的应用步骤里用；栅栏不过（停了、书没了、纪元换了）抛 OperationStopped，别的没写成如实抛错。
 */
import { resolve } from "node:path";
import { planSave, runCommand } from "@actalk/story-core";
import { chapterPlanFileText, type ChapterPlan } from "../book/chapter-plan.js";
import { currentOperation, OperationStopped } from "./operations/context.js";
import { checkFence } from "./operations/fence.js";
import { runWithLazySnapshot } from "./snapshot.js";

const FENCE_CODES: ReadonlySet<string> = new Set(["operation_stopped", "book_gone", "book_epoch_changed"]);

export class PlanSaveError extends Error {
  readonly code = "plan_save_failed";
  constructor(message: string) {
    super(message);
    this.name = "PlanSaveError";
  }
}

/** 落盘这份章纲；返回盘上原来是不是就是这一份、写前打的存档点（原来就是这一份不打）。 */
export async function savePlanInOperation(projectDir: string, plan: ChapterPlan): Promise<{ readonly unchanged: boolean; readonly snapshotId?: string }> {
  const operation = currentOperation();
  const stepId = operation?.step?.id;
  if (!operation || !stepId) throw new PlanSaveError("章纲只在操作的应用步骤里写。");
  if (resolve(operation.bookDir) !== resolve(projectDir)) throw new OperationStopped("cross_book_write", "这次操作只写它自己那本书，别的书没有写。");
  const { result, snapshotId } = await runWithLazySnapshot(projectDir, (snapshot) =>
    runCommand(projectDir, planSave, { chapter: plan.chapter, content: chapterPlanFileText(plan) }, {
      caller: "ai",
      snapshot,
      op: { opId: operation.opId, stepId },
      precondition: () => checkFence(operation),
    }));
  if (!result.ok) {
    if (FENCE_CODES.has(result.code)) throw new OperationStopped(result.code, result.message);
    throw new PlanSaveError(`第 ${plan.chapter} 章的章纲没存上：${result.message}`);
  }
  return { unchanged: result.result.unchanged, ...(snapshotId ? { snapshotId } : {}) };
}
