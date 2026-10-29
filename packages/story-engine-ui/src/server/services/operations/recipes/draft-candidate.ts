/**
 * draft.adopt / draft.discard：作者挑的 AI 稿换上 / 不要了（写作版本 P2a 片 2D，设计 6.6）。收编原来的
 * `POST /api/draft/apply-candidate`（抽卡选用）和 `POST /api/working-draft/pending` 的 AI 候选那一种。
 *
 * - 只认按钮交（稿纸提示条「换成 AI 这版 / 不要了」、「另外几版」卡「用这版」）：对话 AI 交的不受理。不调模型。
 * - 参数：章、候选号、作者看到的那一份的指纹；换上还带作者眼前那份工作稿的版本号。
 * - draft.adopt：`candidate`（读出那一份进检查点：还在、没处理过、内容对得上）→ `apply`（核心 draft.adoptCandidate：工作稿还是
 *   作者眼前那版才换，存档、可撤销；之后这份立墓碑）。生成时的依据只提示、不挡。
 * - draft.discard：`discard`（核过立墓碑）；已经不在、处理过了也算做成了。不写工作稿，不占这一章的写位。
 * 对不上 → obsolete，说哪样变了；作者那份不动。
 */
import { adoptCandidateInOperation, discardCandidateLocked, readAdoptable } from "../../../lib/candidate-adopt.js";
import {
  DRAFT_ADOPT_KIND,
  DRAFT_DISCARD_KIND,
  readCandidateDecisionParams,
  type CandidateDecisionKind,
  type CandidateDecisionParams,
} from "../../draft-change/params.js";
import type { OperationResult, Recipe } from "../executor.js";

function candidateRecipe(kind: CandidateDecisionKind): Recipe<CandidateDecisionParams> {
  const adopting = kind === DRAFT_ADOPT_KIND;
  return {
    kind,
    version: 1,
    lane: "foreground",

    async prepare(_bookDir, input) {
      // 换上 / 不要哪一版是作者的事：只认作者点的按钮。
      if (input.origin.kind !== "button") return { ok: false, code: "author_only", message: "换上还是不要 AI 写的那一版，要你在稿纸上自己点。" };
      const params = readCandidateDecisionParams(kind, input.params);
      if (!params) return { ok: false, code: "bad_params", message: "这个按钮缺了标记，请刷新后再点。" };
      return { ok: true, params, writeScope: { chapters: adopting ? [params.chapter] : [] }, budget: 0 };
    },

    async run(ctx): Promise<OperationResult> {
      const { bookDir, params } = ctx;
      const pick = { chapter: params.chapter, candidateId: params.candidateId, sha: params.sha };
      if (!adopting) {
        const { already } = await ctx.publish("discard", pick, () => discardCandidateLocked(bookDir, pick));
        return {
          schema: "operation-result/1",
          summary: already ? `第 ${params.chapter} 章那一版已经处理过了，不用再管。` : `第 ${params.chapter} 章 AI 那一版不要了，稿子没动。`,
          body: { kind, chapter: params.chapter, applied: false },
        };
      }
      const candidate = await ctx.step("candidate", pick, () => readAdoptable(bookDir, pick));
      const baseVersion = params.baseVersion ?? null;
      const adopted = await ctx.apply("apply", { ...pick, baseVersion }, () => adoptCandidateInOperation(bookDir, { ...pick, ...candidate, baseVersion }));
      const hint = adopted.basisMoved ? "这一版写好之后前文或设定改过，可以再核一遍账。" : "";
      return {
        schema: "operation-result/1",
        summary: `第 ${params.chapter} 章${adopted.unchanged ? "稿纸上已经是这一版了。" : "换上了 AI 这一版（可撤销）。"}${hint}`,
        body: {
          kind,
          chapter: params.chapter,
          applied: !adopted.unchanged,
          version: adopted.version,
          ...(adopted.snapshotId ? { snapshotId: adopted.snapshotId } : {}),
          ...(adopted.basisMoved ? { basisMoved: true } : {}),
        },
        ...(adopted.warnings ? { warnings: adopted.warnings } : {}),
      };
    },

    stepBudget: () => 0,
    modelTasks: () => [],
  };
}

export const draftAdoptRecipe = candidateRecipe(DRAFT_ADOPT_KIND);
export const draftDiscardRecipe = candidateRecipe(DRAFT_DISCARD_KIND);
