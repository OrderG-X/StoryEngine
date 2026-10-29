/**
 * draft.change write / continue：写一章、接着往下写（写作版本 P2a 3.1、第七节）。收编原来的 generate_draft 和「写这一章」按钮：
 * 对话 AI、按钮都只交意图，这里按固定步骤跑完，最后一次换上工作稿。
 *
 * - 受理前：参数归一；导入的书通读记账没完不受理；要用的模型没配好不受理；这一章按这个模式写不了（接着写没正文 / 已定稿、
 *   有稿没点重写、前一章没定稿）如实挡下，不调模型。
 * - 步骤：materials（依据、材料、稿同一次读）→ notes（章纲员、核账员先读前文：当场最多 10 章 / 2 卷，缺得更多交后台补读、
 *   停在 paused:material）→ plan（只 write，在内存里拟、审、改）→ plan-save（新拟的走核心 plan.save）→ write:n（一版一步，
 *   只出一版时正文流进稿纸）→ 选优 → extend（只 write、不到下限）→ deai → check → fix → recheck（含终稿判漏复核）→ apply。
 * - 结果：`body` 见 services/draft-change/result.ts；一版都没通过 → failed（draft_rejected），没换上 → succeeded + body.kept。
 * - 前台道（作者在等）；进程没了不自动续，停在 paused:interrupted 等作者点「接着做」。
 */
import { planDigest } from "../../../book/material-reads.js";
import { callConfiguredBrainModel, callConfiguredPlannerModel, type BrainCallModel } from "../../../editorial/index.js";
import { READER_ROLE_LABELS } from "../../../editorial/reader-progress.js";
import { rereadBlocker } from "../../../editorial/reread-state.js";
import { applyAiDraft } from "../../../lib/ai-draft-write.js";
import { savePlanInOperation } from "../../../lib/ai-plan-write.js";
import { frozenCompatAllowance, frozenModelProblem, resolveConfiguredChatModel, type FrozenModels, type ModelTaskProfileKey } from "../../../lib/llm-client.js";
import { currentOperation, rethrowIfStopped } from "../../../lib/operations/context.js";
import { pauseOperation, stoppedError } from "../../../lib/operations/fence.js";
import { emitLive } from "../../../lib/operations/live.js";
import { submitReaderBackfill } from "../../../lib/reader-backfill.js";
import type { WriterClient } from "../../../writing/fast-draft-writer.js";
import { createConfiguredWriterClient, createOpenAICompatibleWriterClient } from "../../../writing/writer-client.js";
import type { DeAiCallModel } from "../../de-ai-flavor-batch.js";
import type { ContinueCallModel } from "../../draft-pipeline/continue-draft.js";
import {
  callConfiguredBeatAdjudicationModel,
  callConfiguredContinueModel,
  callConfiguredDeAiModel,
  callConfiguredFixModel,
} from "../../draft-pipeline/production-call-models.js";
import { resolveCandidateTemperatures } from "../../draft-service.js";
import { DRAFT_CHANGE_KIND, readDraftChangeParams, versionCount, type DraftChangeMode, type DraftChangeParams } from "../../draft-change/params.js";
import { buildDraftChangeResult, rejectionMessage, type DraftApplied } from "../../draft-change/result.js";
import {
  checkDraft,
  coded,
  deAiDraft,
  draftTargetProblem,
  extendDraft,
  finalBeatFidelity,
  fixSureIssues,
  planDraft,
  planMaterial,
  prepareDraftNotes,
  readChapterDraft,
  readDraftMaterials,
  recheckDraft,
  selectVersion,
  writeVersion,
  type DraftVersion,
} from "../../draft-change/steps.js";
import type { RevisionModelCaller } from "../../revision-service.js";
import { draftChangeStepBudget, draftChangeTasks, sumBudget } from "../budgets.js";
import type { OperationResult, Recipe, RecipeContext } from "../executor.js";

export { DRAFT_CHANGE_KIND };

/** 记录里存的参数：归一好的那份 + 模式（接着做时额度按模式算）。 */
export type StoredDraftChange = DraftChangeParams & { readonly mode: DraftChangeMode };

export interface DraftChangeDeps {
  /** 章纲员（补笔记、拟纲、改纲）。 */
  readonly plannerCallModel: BrainCallModel;
  /** 核账员（补笔记、审纲、核）。 */
  readonly readerCallModel: BrainCallModel;
  /** 写手：只出一版时带 onDelta（正文流进稿纸）；多版时各版带错开的温度。 */
  readonly writer: (options: { readonly onDelta?: (delta: string) => void; readonly temperature?: number }) => Promise<WriterClient>;
  /** 多版时温度从哪儿错开（写手档案的温度）。 */
  readonly writerTemperature: () => Promise<number>;
  readonly continueCallModel: ContinueCallModel;
  readonly fixCallModel: RevisionModelCaller;
  readonly deAiCallModel: DeAiCallModel;
  readonly beatAdjudicationCallModel: (prompt: string) => Promise<string>;
  readonly modelProblem: (models: FrozenModels, task: ModelTaskProfileKey) => string | undefined;
}

const DEFAULT_DEPS: DraftChangeDeps = {
  plannerCallModel: callConfiguredPlannerModel,
  readerCallModel: callConfiguredBrainModel,
  async writer({ onDelta, temperature }) {
    if (temperature === undefined) return createConfiguredWriterClient("fastDraft", onDelta);
    const configured = await resolveConfiguredChatModel("fastDraft");
    return createOpenAICompatibleWriterClient({ ...configured, profile: { ...configured.profile, temperature } }, onDelta);
  },
  // 和写手客户端的兜底一致。
  writerTemperature: async () => (await resolveConfiguredChatModel("fastDraft")).profile.temperature ?? 0.8,
  continueCallModel: callConfiguredContinueModel,
  fixCallModel: callConfiguredFixModel,
  deAiCallModel: callConfiguredDeAiModel,
  beatAdjudicationCallModel: callConfiguredBeatAdjudicationModel,
  modelProblem: frozenModelProblem,
};

/** 交来的（或记录里存的）参数读回来；模式以受理时定的为准。 */
export function readStoredDraftChange(mode: unknown, value: unknown): StoredDraftChange | undefined {
  const read = readDraftChangeParams(mode, value);
  return read ? { ...read.params, mode: read.mode } : undefined;
}

/** 正文流进稿纸（只出一版时）：在步骤里建，exec 是这次执行的；一步开始先换掉残稿（接着写先推本来写好的那段）。 */
function draftStream(ctx: RecipeContext<unknown>, base: string | undefined) {
  const exec = currentOperation()?.step?.exec ?? "";
  let streamSeq = 0;
  const emit = (event: { readonly text: string; readonly replace?: true; readonly base?: true }): void => {
    streamSeq += 1;
    emitLive(ctx.bookDir, ctx.record.opId, { type: "draft-delta", exec, streamSeq, ...event });
  };
  if (base) emit({ text: `${base}\n\n`, base: true });
  else emit({ text: "", replace: true });
  return {
    delta: (text: string): void => emit({ text }),
    replace: (visible: string): void => emit({ text: visible, replace: true }),
  };
}

const snapshotLabelOf = (mode: DraftChangeMode, chapter: number, hadText: boolean): string =>
  mode === "continue" ? `第${chapter}章接着写前快照` : hadText ? `第${chapter}章再次出稿前快照` : `出稿：第${chapter}章`;

export function createDraftChangeRecipe(deps: DraftChangeDeps = DEFAULT_DEPS): Recipe<StoredDraftChange> {
  return {
    kind: DRAFT_CHANGE_KIND,
    version: 1,
    lane: "foreground",

    async prepare(bookDir, input) {
      const params = readStoredDraftChange(input.mode, input.params);
      if (!params) return { ok: false, code: "bad_params", message: "要写哪一章没说清：请给章号。" };
      const { mode } = params;
      // 导入的书还在通读记账（P8）：账没记全，章纲员、核账员对照的前文是缺的，记完再出稿。
      const rereading = await rereadBlocker(bookDir, "出稿");
      if (rereading) return { ok: false, code: "rereading", message: rereading };
      for (const task of draftChangeTasks(mode)) {
        const problem = deps.modelProblem(input.models, task);
        if (problem) return { ok: false, code: "model_missing", message: problem };
      }
      const draft = await readChapterDraft(bookDir, params.chapter);
      const problem = await draftTargetProblem(bookDir, mode, params, { hasText: draft.body !== "" });
      if (problem) return { ok: false, ...problem };
      return {
        ok: true,
        params,
        mode,
        writeScope: { chapters: [params.chapter] },
        budget: sumBudget(draftChangeStepBudget(mode, versionCount(mode, params))) + await frozenCompatAllowance(input.models, draftChangeTasks(mode)),
      };
    },

    async run(ctx): Promise<OperationResult> {
      const params = readStoredDraftChange(ctx.record.mode, ctx.params);
      if (!params) throw coded("bad_params", "这次出稿的参数读不出来了，没法接着做。");
      const { mode, chapter } = params;
      const continuing = mode === "continue";
      const { bookDir } = ctx;

      const materials = await ctx.step("materials", { mode, chapter }, () => readDraftMaterials(bookDir, mode, params));

      const notes = await ctx.step("notes", { chapter, readers: materials.readers }, async () => {
        if (materials.readers.planner || materials.readers.checker) ctx.progress(`专员在读第 ${chapter} 章之前的前文`);
        let outcome;
        try {
          outcome = await prepareDraftNotes({
            projectDir: bookDir,
            chapter,
            readers: materials.readers,
            plannerCallModel: deps.plannerCallModel,
            readerCallModel: deps.readerCallModel,
          });
        } catch (error) {
          rethrowIfStopped(error);
          const message = error instanceof Error ? error.message : String(error);
          throw coded(((error as { code?: unknown }).code as string | undefined) ?? "notes_failed", `专员读前文没成：${message}`);
        }
        // 缺得更多：交后台补读，停下等（读完点「接着做」从这一步接着）。这个角色的后台补读停着等作者的不等，照冷窗口往下走。
        const behind = outcome.roles.filter((role) => role.missing > 0 && !role.pausedBackfill);
        if (behind.length > 0) {
          await submitReaderBackfill(bookDir, { roles: behind.map((role) => role.role), upTo: chapter - 1 });
          ctx.progress(`${behind.map((role) => `${READER_ROLE_LABELS[role.role] ?? "专员"}还在读前文（第 ${role.readThrough} / ${chapter - 1} 章）`).join("，")}，读完点「接着做」`);
          await pauseOperation(bookDir, ctx.record.opId, ctx.operation.runEpoch, "material");
          throw stoppedError(ctx.operation);
        }
        return outcome;
      });

      const planned = continuing
        ? undefined
        : await ctx.step("plan", { chapter, direction: params.direction ?? null }, () => {
          ctx.progress(`章纲员在拟第 ${chapter} 章的章纲`);
          return planDraft({
            projectDir: bookDir,
            chapter,
            ...(params.direction ? { direction: params.direction } : {}),
            plannerCallModel: deps.plannerCallModel,
            readerCallModel: deps.readerCallModel,
          });
        });
      const usedPlan = continuing ? materials.continuePlan : planned?.plan;
      const planToSave = planned?.save ? planned.plan : undefined;
      const planSaved = planToSave
        ? await ctx.apply("plan-save", { digest: planDigest(planToSave) }, () => savePlanInOperation(bookDir, planToSave))
        : undefined;

      const count = versionCount(mode, params);
      const temperatures = count > 1 ? resolveCandidateTemperatures(await deps.writerTemperature(), count) : undefined;
      const versions: DraftVersion[] = [];
      for (let n = 1; n <= count; n += 1) {
        const temperature = temperatures?.[n - 1];
        versions.push(await ctx.step(`write:${n}`, { chapter, mode, plan: planDigest(usedPlan), continueText: materials.continueText ?? null, temperature: temperature ?? null }, async () => {
          ctx.progress(count > 1 ? `在写第 ${chapter} 章（第 ${n} / ${count} 版）` : continuing ? `在接着写第 ${chapter} 章` : `在写第 ${chapter} 章`);
          // 只出一版时正文流进稿纸；多版不流（几版串进同一章稿纸会花屏）。
          const stream = count === 1 ? draftStream(ctx as RecipeContext<unknown>, materials.continueText) : undefined;
          const writerClient = await deps.writer({ ...(stream ? { onDelta: stream.delta } : {}), ...(temperature !== undefined ? { temperature } : {}) });
          return writeVersion({
            projectDir: bookDir,
            mode,
            params,
            index: n - 1,
            ...(usedPlan ? { plan: usedPlan } : {}),
            ...(materials.continueText ? { continueText: materials.continueText } : {}),
            writerClient,
            ...(temperature !== undefined ? { temperature } : {}),
            ...(stream ? { onStreamReset: stream.replace } : {}),
            // 多版时选优前逐版复核判漏（选优吃复核后的数）；只出一版留到终稿复核一次。
            ...(count > 1 ? { beatAdjudicationCallModel: deps.beatAdjudicationCallModel } : {}),
          });
        }));
      }

      // 选优：确定性、不调模型，按检查点里的几版算。
      const select = selectVersion(versions);
      if (select.chosen === undefined) throw coded("draft_rejected", rejectionMessage(chapter, versions, select));
      const chosen = versions[select.chosen]!;
      const chosenReport = chosen.report!;
      let body = chosenReport.draftBody!;
      // 整份稿的章名开工时就定下：新写的用 AI 起的，AI 没起名、接着写的都沿用开写时那份的。
      const title = continuing ? materials.title : chosenReport.title ?? materials.title;

      const extend = continuing
        ? undefined
        : await ctx.step("extend", { body }, () => {
          ctx.progress("在补字数");
          return extendDraft({ chapter, draftBody: body, lengthTarget: chosen.context.lengthTarget, ...(usedPlan ? { plan: usedPlan } : {}), callModel: deps.continueCallModel });
        });
      if (extend?.changed) body = extend.draftBody;

      const deai = await ctx.step("deai", { body, autoDeAi: params.autoDeAi !== false }, () => {
        ctx.progress("在查机器腔");
        return deAiDraft({
          projectDir: bookDir,
          draftBody: body,
          ...(materials.continueText ? { continueText: materials.continueText } : {}),
          ...(params.mustHitBeats ? { mustHitBeats: params.mustHitBeats } : {}),
          autoDeAi: params.autoDeAi !== false,
          callModel: deps.deAiCallModel,
        });
      });
      if (deai.changed) body = deai.draftBody;

      // 核账排在改正文的几步后面：核的、记进核账记忆的都是最后落盘的这一版。
      const checkedBody = body;
      const first = await ctx.step("check", { body }, () => {
        ctx.progress(`核账员在核第 ${chapter} 章`);
        return checkDraft({ projectDir: bookDir, chapter, draftBody: checkedBody, callModel: deps.readerCallModel });
      });
      const fix = await ctx.step("fix", { body }, () => {
        if (first.ok && first.sure.length > 0) ctx.progress("在按核账改");
        return fixSureIssues({
          chapter,
          draftBody: checkedBody,
          check: first,
          callModel: deps.fixCallModel,
          ...(materials.continueText ? { keepPrefix: materials.continueText } : {}),
        });
      });
      if (fix.changed) body = fix.draftBody;
      const finalBody = body;
      const final = await ctx.step("recheck", { body: finalBody, fixed: fix.applied }, async () => {
        if (fix.applied > 0) ctx.progress("改完再核一遍");
        const recheck = fix.applied > 0
          ? await recheckDraft({ projectDir: bookDir, chapter, draftBody: finalBody, changes: fix.changes, callModel: deps.readerCallModel })
          : undefined;
        const beats = await finalBeatFidelity({
          draftBody: finalBody,
          ...(params.mustHitBeats ? { mustHitBeats: params.mustHitBeats } : {}),
          ...(count > 1
            ? {
              ...(chosenReport.draftBody ? { chosenBody: chosenReport.draftBody } : {}),
              ...(chosen.adjudication ? { chosenAdjudication: chosen.adjudication } : {}),
              ...(chosenReport.beatFidelity ? { chosenReport: chosenReport.beatFidelity } : {}),
            }
            : {}),
          callModel: deps.beatAdjudicationCallModel,
        });
        return { ...(recheck ? { recheck } : {}), beats };
      });

      // 换上：照哪份章纲写的、开写时别的材料，换上前在书锁里核；对不上就留成候选，作者那份不动。
      const materialReads = [planMaterial(chapter, usedPlan, materials.startPlan), ...materials.world];
      const applied = await ctx.apply("apply", { body: finalBody, title, baseVersion: materials.baseVersion, basis: materials.basis.digest, fixes: fix.changes.length }, async (): Promise<DraftApplied> => {
        ctx.progress("在换上工作稿");
        const outcome = await applyAiDraft(bookDir, {
          chapter,
          title,
          body: finalBody,
          baseVersion: materials.baseVersion,
          basis: materials.basis,
          materials: materialReads,
          source: continuing ? "continue" : "draft",
          snapshotLabel: snapshotLabelOf(mode, chapter, materials.hadText),
          fixes: fix.changes,
        });
        if (!outcome.applied) {
          return { applied: false, reason: outcome.reason, candidateId: outcome.candidateId, message: outcome.message, ...(outcome.handled ? { handled: true as const } : {}) };
        }
        return {
          applied: true,
          version: outcome.version,
          unchanged: outcome.unchanged,
          ...(outcome.snapshotId ? { snapshotId: outcome.snapshotId } : {}),
          ...(outcome.warnings ? { warnings: outcome.warnings } : {}),
        };
      });

      return buildDraftChangeResult({
        mode,
        params,
        notes,
        ...(planned ? { plan: planned } : {}),
        ...(usedPlan ? { usedPlan } : {}),
        versions,
        select: { ...select, chosen: select.chosen },
        ...(extend ? { extend } : {}),
        deai,
        checkedBody,
        first,
        fix,
        ...(final.recheck ? { recheck: final.recheck } : {}),
        beats: final.beats,
        finalBody,
        ...(materials.continueText ? { continueText: materials.continueText } : {}),
        ...(planSaved?.snapshotId ? { planSnapshotId: planSaved.snapshotId } : {}),
        applied,
      });
    },

    stepBudget(stepId, params) {
      if (stepId === undefined) return 0;
      return draftChangeStepBudget(params.mode, versionCount(params.mode, params))[stepId] ?? 0;
    },

    modelTasks(params) {
      return draftChangeTasks(params.mode);
    },
  };
}

export const draftChangeRecipe = createDraftChangeRecipe();
