/**
 * plan.propose：想这一章往哪走（写作版本 P2a 片 2D，设计 6.6）。收编原来的 brainstorm_chapter：对话 AI（plan_chapter）、
 * 稿纸上方「给我几种走法」「再来几种」按钮都只交意图，这里按固定步骤跑完。只读：不落章纲、不进账、不打存档点。
 *
 * - 受理前：参数归一（想法、已给过的走法名字截长）；导入的书通读记账没完不受理；章纲员、核账员的模型没配好不受理。
 * - 步骤：`notes`（两个角色当场最多补 10 章；缺得更多不补、交后台补读，不停下等）→ `propose`（章纲员出几种走法，
 *   按冷窗口也照想）→ `check`（核账员替每种对前文；没核成照给走法、如实说没核）。
 * - 结果：`body` 是原来 brainstorm_chapter 的输出形状（走法卡照用），`summary` 是一句结论。章纲员没想出来 → failed，说原因。
 * - 前台道（作者在等）；进程没了不自动续，停在 paused:interrupted 等作者点「接着做」。
 */
import {
  BRAINSTORM_OPTIONS,
  callConfiguredBrainModel,
  callConfiguredPlannerModel,
  checkDirections,
  PLANNER_ROLE,
  proposeDirections,
  type BrainCallModel,
  type BrainstormOption,
} from "../../../editorial/index.js";
import { prepareCheckerNotes, READER_MAX_VOLUME_BUILDS } from "../../../editorial/continuity/check-service.js";
import { PLANNER_MAX_CATCH_UP } from "../../../editorial/plan-chapter.js";
import { prepareReaderNotes, type ReaderNotesOutcome } from "../../../editorial/prepare-notes.js";
import { rereadBlocker } from "../../../editorial/reread-state.js";
import { frozenCompatAllowance, frozenModelProblem, type FrozenModels, type ModelTaskProfileKey } from "../../../lib/llm-client.js";
import { rethrowIfStopped } from "../../../lib/operations/context.js";
import { submitReaderBackfill } from "../../../lib/reader-backfill.js";
import { coded } from "../../draft-change/steps.js";
import { PLAN_PROPOSE_STEP_BUDGET, PLAN_PROPOSE_TASKS, sumBudget } from "../budgets.js";
import type { OperationResult, Recipe } from "../executor.js";

export const PLAN_PROPOSE_KIND = "plan.propose" as const;

/** 作者的想法最多收多长（稿纸上的输入框也是这么长）。 */
const MAX_IDEA_CHARS = 500;
/** 「再来几种」带的已给过的走法：最多几条、每条多长。 */
const MAX_AVOID = BRAINSTORM_OPTIONS * 3;
const MAX_AVOID_CHARS = 40;

export interface PlanProposeParams {
  readonly chapter: number;
  /** 作者对这章的想法原话；没有 = 按故事现状想。 */
  readonly idea?: string;
  /** 「再来几种」：已经给过的走法名字。 */
  readonly avoid?: readonly string[];
}

/** 交来的（或记录里存的）参数读回来；形状不对是 undefined。 */
export function readPlanProposeParams(value: unknown): PlanProposeParams | undefined {
  const raw = (value ?? {}) as Record<string, unknown>;
  const chapter = raw.chapter;
  if (typeof chapter !== "number" || !Number.isInteger(chapter) || chapter <= 0) return undefined;
  const idea = typeof raw.idea === "string" && raw.idea.trim() ? raw.idea.trim().slice(0, MAX_IDEA_CHARS) : undefined;
  const avoid = Array.isArray(raw.avoid)
    ? [...new Set(raw.avoid.filter((item): item is string => typeof item === "string").map((item) => item.trim().slice(0, MAX_AVOID_CHARS)).filter(Boolean))].slice(0, MAX_AVOID)
    : [];
  return { chapter, ...(idea ? { idea } : {}), ...(avoid.length > 0 ? { avoid } : {}) };
}

/** 结果体：原来 brainstorm_chapter 的输出（走法卡吃这一份）。 */
export interface PlanProposeBody {
  readonly kind: typeof PLAN_PROPOSE_KIND;
  readonly ok: true;
  readonly chapter: number;
  readonly idea?: string;
  readonly options: readonly BrainstormOption[];
  readonly checked: boolean;
  readonly checkNote?: string;
  readonly coldNote?: string;
  readonly summary: string;
}

export interface PlanProposeDeps {
  readonly plannerCallModel: BrainCallModel;
  readonly readerCallModel: BrainCallModel;
  /** 这次冻结的模型能不能做这件事：不能返回一句原因（不受理）。 */
  readonly modelProblem: (models: FrozenModels, task: ModelTaskProfileKey) => string | undefined;
}

const DEFAULT_DEPS: PlanProposeDeps = {
  plannerCallModel: callConfiguredPlannerModel,
  readerCallModel: callConfiguredBrainModel,
  modelProblem: frozenModelProblem,
};

/** 一句结论：想了几种；核账员没核成、有几种和前文对不上照说（新书第一章没前文可核，不提核账）。 */
function proposeSummary(chapter: number, options: readonly BrainstormOption[], checked: boolean, nothingEarlier: boolean): string {
  const conflicted = options.filter((option) => option.problems.length > 0).length;
  const tail = nothingEarlier
    ? ""
    : !checked
      ? "核账员这次没核成，挑之前留意前文。"
      : conflicted > 0 ? `其中 ${conflicted} 种和前文有对不上的地方，卡上标了。` : "";
  return `第 ${chapter} 章想了 ${options.length} 种走法，在稿纸上挑。${tail}`;
}

export function createPlanProposeRecipe(deps: PlanProposeDeps = DEFAULT_DEPS): Recipe<PlanProposeParams> {
  return {
    kind: PLAN_PROPOSE_KIND,
    version: 1,
    lane: "foreground",

    async prepare(bookDir, input) {
      const params = readPlanProposeParams(input.params);
      if (!params) return { ok: false, code: "bad_params", message: "要想哪一章没说清：请给章号。" };
      // 导入的书还在通读记账（P8）：开着的线索、前文的账都没记全，想出来的走法对不上前文。
      const rereading = await rereadBlocker(bookDir, "想走法");
      if (rereading) return { ok: false, code: "rereading", message: rereading };
      for (const task of PLAN_PROPOSE_TASKS) {
        const problem = deps.modelProblem(input.models, task);
        if (problem) return { ok: false, code: "model_missing", message: problem };
      }
      return {
        ok: true,
        params,
        writeScope: { chapters: [] },
        budget: sumBudget(PLAN_PROPOSE_STEP_BUDGET) + await frozenCompatAllowance(input.models, PLAN_PROPOSE_TASKS),
      };
    },

    async run(ctx): Promise<OperationResult> {
      const params = readPlanProposeParams(ctx.params);
      if (!params) throw coded("bad_params", "这次想走法的参数读不出来了，没法接着做。");
      const { bookDir } = ctx;
      const { chapter } = params;

      // 当场补笔记（各最多 10 章）；缺得更多不补、交后台补读，这次按冷窗口想（只是想几种走法，不停下等）。
      await ctx.step("notes", { chapter }, async () => {
        if (chapter > 1) ctx.progress(`专员在读第 ${chapter} 章之前的前文`);
        let roles: ReaderNotesOutcome[];
        try {
          roles = [
            await prepareReaderNotes({
              projectDir: bookDir,
              role: PLANNER_ROLE,
              chapter,
              callModel: deps.plannerCallModel,
              maxCatchUp: PLANNER_MAX_CATCH_UP,
              maxVolumeBuilds: READER_MAX_VOLUME_BUILDS,
              waitingAs: "想走法",
            }),
            await prepareCheckerNotes(bookDir, chapter, deps.readerCallModel),
          ];
        } catch (error) {
          rethrowIfStopped(error);
          const message = error instanceof Error ? error.message : String(error);
          throw coded(((error as { code?: unknown }).code as string | undefined) ?? "notes_failed", `专员读前文没成：${message}`);
        }
        const behind = roles.filter((role) => role.missing > 0 && !role.pausedBackfill).map((role) => role.role);
        if (behind.length > 0) await submitReaderBackfill(bookDir, { roles: behind, upTo: chapter - 1 });
        return { behind };
      });

      // 笔记在上一步补过：这两步当场一份不补（0 次笔记调用），缺的按冷窗口。
      const windows = { projectDir: bookDir, chapter, maxCatchUp: 0, maxVolumeBuilds: 0 };
      ctx.progress(`章纲员在想第 ${chapter} 章的几种走法`);
      const proposed = await ctx.step("propose", { chapter, idea: params.idea ?? null, avoid: params.avoid ?? [] }, async () => {
        const result = await proposeDirections({
          ...windows,
          ...(params.idea ? { idea: params.idea } : {}),
          ...(params.avoid ? { avoid: params.avoid } : {}),
          callPlanner: deps.plannerCallModel,
        });
        if (!result.ok) throw coded("not_proposed", `第 ${chapter} 章的走法没想出来：${result.reason}`);
        return result;
      });

      if (chapter > 1) ctx.progress(`核账员在替几种走法对前文`);
      const checked = await ctx.step("check", { chapter }, () => checkDirections({ ...windows, options: proposed.options, callChecker: deps.readerCallModel }));

      const summary = proposeSummary(chapter, checked.options, checked.checked, checked.nothingEarlier === true);
      const coldNote = [proposed.coldNote, checked.coldNote].filter(Boolean).join("");
      const body: PlanProposeBody = {
        kind: PLAN_PROPOSE_KIND,
        ok: true,
        chapter,
        ...(proposed.idea ? { idea: proposed.idea } : {}),
        options: checked.options,
        checked: checked.checked,
        ...(checked.checkNote ? { checkNote: checked.checkNote } : {}),
        ...(coldNote ? { coldNote } : {}),
        summary,
      };
      return { schema: "operation-result/1", summary, body };
    },

    stepBudget(stepId) {
      if (stepId === undefined) return 0;
      return PLAN_PROPOSE_STEP_BUDGET[stepId] ?? 0;
    },

    modelTasks() {
      return PLAN_PROPOSE_TASKS;
    },
  };
}

export const planProposeRecipe = createPlanProposeRecipe();
