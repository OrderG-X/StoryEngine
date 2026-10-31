/**
 * inspect.run：只读检查（写作版本 P2a 第九节配方表、4.5）——核账（continuity）、硬伤检查（quality）、内容审阅（review）、查 AI 味（flavor）。
 * 收编原来的 check_continuity / quality_check / ai_review / check_ai_flavor：对话 AI、按钮都只交意图，这里按固定步骤跑完。
 *
 * - 受理前：参数归一；核账在导入的书通读记账没完时不受理；要用的模型没配好不受理；这一章没有可查的正文不受理。
 * - 步骤：`freeze` 冻结正文（接着做照这一份）→ 核账先 `notes`（当场最多补 10 章 / 2 个卷节点，缺得更多不补、0 次调用）
 *   → `check`（笔记不再当场补，缺了照冷窗口核、交后台补读，不停下等）；另外三种一步 `run`。
 * - 结果：`body` 是原来那个工具的输出形状（界面卡片照用），`summary` 是一句结论。
 * - 前台道（作者在等）；进程没了不自动续，停在 paused:interrupted 等作者点「接着做」。
 */
import { callConfiguredBrainModel, type BrainCallModel } from "../../../editorial/index.js";
import { prepareCheckerNotes } from "../../../editorial/continuity/check-service.js";
import { rereadBlocker } from "../../../editorial/reread-state.js";
import { frozenCompatAllowance, frozenModelProblem, type FrozenModels, type ModelTaskProfileKey } from "../../../lib/llm-client.js";
import { rethrowIfStopped } from "../../../lib/operations/context.js";
import {
  freezeChapterText,
  runContinuityCheck,
  runFlavorCheck,
  runQualityCheck,
  runReview,
  type FrozenChapterText,
  type InspectMode,
} from "../../inspect-service.js";
import { inspectStepBudget, inspectTasks, sumBudget } from "../budgets.js";
import type { OperationResult, Recipe } from "../executor.js";
import { modelFailureText } from "../../../lib/ai-errors.js";

export const INSPECT_KIND = "inspect.run" as const;

const MODES: readonly InspectMode[] = ["continuity", "quality", "review", "flavor"];

export interface InspectParams {
  readonly mode: InspectMode;
  readonly chapter: number;
  /** 核账：正文没改也重新核（作者说「再细核一遍」）。 */
  readonly fresh?: boolean;
  /** 内容审阅：本章目标、作者的额外要求（作为审稿参照）。 */
  readonly chapterGoal?: string;
  readonly userDirection?: string;
}

const optionalText = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

/** 交来的（或记录里存的）参数读回来；形状不对是 undefined。mode 以受理时定的为准。 */
export function readInspectParams(mode: unknown, value: unknown): InspectParams | undefined {
  if (!MODES.includes(mode as InspectMode)) return undefined;
  const raw = (value ?? {}) as Record<string, unknown>;
  const chapter = raw.chapter;
  if (typeof chapter !== "number" || !Number.isInteger(chapter) || chapter <= 0) return undefined;
  const chapterGoal = optionalText(raw.chapterGoal);
  const userDirection = optionalText(raw.userDirection);
  return {
    mode: mode as InspectMode,
    chapter,
    ...(mode === "continuity" && raw.fresh === true ? { fresh: true } : {}),
    ...(mode === "review" && chapterGoal ? { chapterGoal } : {}),
    ...(mode === "review" && userDirection ? { userDirection } : {}),
  };
}

export interface InspectDeps {
  /** 核账员（补笔记、核）的模型调用；缺省按这次冻结的 qualityCheck。 */
  readonly readerCallModel: BrainCallModel;
  /** 内容审阅、查 AI 味的模型调用（单测注入）；缺省按这次冻结的 draftReview。 */
  readonly reviewCallModel?: (prompt: string) => Promise<string>;
  readonly flavorCallModel?: (prompt: string) => Promise<string>;
  /** 这次冻结的模型能不能做这件事：不能返回一句原因（不受理）。 */
  readonly modelProblem: (models: FrozenModels, task: ModelTaskProfileKey) => string | undefined;
}

const DEFAULT_DEPS: InspectDeps = {
  readerCallModel: callConfiguredBrainModel,
  modelProblem: frozenModelProblem,
};

const coded = (code: string, message: string): Error => Object.assign(new Error(message), { code });

export function createInspectRunRecipe(deps: InspectDeps = DEFAULT_DEPS): Recipe<InspectParams> {
  return {
    kind: INSPECT_KIND,
    version: 1,
    lane: "foreground",

    async prepare(bookDir, input) {
      if (!MODES.includes(input.mode as InspectMode)) return { ok: false, code: "bad_params", message: "不认识要做哪种检查。" };
      const params = readInspectParams(input.mode, input.params);
      if (!params) return { ok: false, code: "bad_params", message: "要检查哪一章没说清：请给章号。" };
      if (params.mode === "continuity") {
        // 导入的书还在通读记账（P8）：前文的账没记全，核出来的「对不上」靠不住。
        const rereading = await rereadBlocker(bookDir, "核账");
        if (rereading) return { ok: false, code: "rereading", message: rereading };
      }
      for (const task of inspectTasks(params.mode)) {
        const problem = deps.modelProblem(input.models, task);
        if (problem) return { ok: false, code: "model_missing", message: problem };
      }
      const frozen = await freezeChapterText(bookDir, params.chapter, params.mode);
      if ("missing" in frozen) return { ok: false, code: "no_text", message: frozen.missing };
      return {
        ok: true,
        params,
        mode: params.mode,
        writeScope: { chapters: [] },
        budget: sumBudget(inspectStepBudget(params.mode)) + await frozenCompatAllowance(input.models, inspectTasks(params.mode)),
      };
    },

    async run(ctx): Promise<OperationResult> {
      const params = readInspectParams(ctx.record.mode, ctx.params);
      if (!params) throw coded("bad_params", "这次检查的参数读不出来了，没法接着做。");
      const { chapter } = params;
      const frozen = await ctx.step<FrozenChapterText>("freeze", { chapter, mode: params.mode }, async () => {
        const read = await freezeChapterText(ctx.bookDir, chapter, params.mode);
        if ("missing" in read) throw coded("no_text", read.missing);
        return read;
      });
      switch (params.mode) {
        case "continuity": {
          ctx.progress(`核账员在读第 ${chapter} 章之前的前文`);
          const notes = await ctx.step("notes", { chapter }, async () => {
            try {
              return await prepareCheckerNotes(ctx.bookDir, chapter, deps.readerCallModel);
            } catch (error) {
              rethrowIfStopped(error);
              throw coded(((error as { code?: unknown }).code as string | undefined) ?? "notes_failed", `核账员读前文没成：${modelFailureText(error)}`);
            }
          });
          ctx.progress(`核账员在核第 ${chapter} 章`);
          const output = await ctx.step("check", { chapter, fresh: params.fresh === true }, () =>
            runContinuityCheck(ctx.bookDir, frozen, {
              ...(params.fresh ? { fresh: true } : {}),
              readerCallModel: deps.readerCallModel,
              notesReady: notes.waited ? { waited: notes.waited } : {},
            }));
          return { schema: "operation-result/1", summary: output.headline ?? output.summary, body: output, ...(output.coverage ? { coverage: output.coverage } : {}) };
        }
        case "quality": {
          const output = await ctx.step("run", { chapter }, () => runQualityCheck(ctx.bookDir, frozen));
          return { schema: "operation-result/1", summary: output.summary, body: output };
        }
        case "review": {
          ctx.progress(`在审第 ${chapter} 章`);
          const output = await ctx.step("run", { chapter, chapterGoal: params.chapterGoal ?? null, userDirection: params.userDirection ?? null }, () =>
            runReview(ctx.bookDir, frozen, {
              ...(params.chapterGoal ? { chapterGoal: params.chapterGoal } : {}),
              ...(params.userDirection ? { userDirection: params.userDirection } : {}),
              ...(deps.reviewCallModel ? { callModel: deps.reviewCallModel } : {}),
            }));
          return { schema: "operation-result/1", summary: output.summary, body: output };
        }
        case "flavor": {
          ctx.progress(`在查第 ${chapter} 章的 AI 味`);
          const output = await ctx.step("run", { chapter }, () => runFlavorCheck(ctx.bookDir, frozen, deps.flavorCallModel));
          return { schema: "operation-result/1", summary: output.summary, body: output };
        }
      }
    },

    stepBudget(stepId, params) {
      if (stepId === undefined) return 0;
      return inspectStepBudget(params.mode)[stepId] ?? 0;
    },

    modelTasks(params) {
      return inspectTasks(params.mode);
    },
  };
}

export const inspectRunRecipe = createInspectRunRecipe();
