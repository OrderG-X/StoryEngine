/**
 * background.reread：导入已写的书后，记账员从第 1 章起一章一章通读记账（P8；写作版本 P2a 片 3D 替掉原来
 * editorial/reread.ts 的循环和 `agents/ledger/reread.json`）。
 *
 * - 受理时冻结要记哪几章：第 1～total 章里账单还是导入时那份空账单的（origin = import 且一条都没有；老格式书导入的账
 *   origin 也是 import，但带着老账，不重记）。都记过了也受理，跑起来直接记完。
 * - 一章两步：`read:<章>:<回>` 记账员交账单（editorial/reread.ts 的 rereadChapter，在书的补读队列里跑），
 *   `apply:<章>:<回>` 走「通读记账」命令落账（幂等键 = opId:stepId）。
 * - 依据：记账员读的那一版书记成指纹存在检查点里（不存整份依据：几百章每章一份太大）。落账时重读依据、指纹对不上，
 *   或命令核依据没过 = 书在途中改过：这章这回不记，下一回照新的样子重读重记，最多 BASIS_RETRIES 回。
 * - 一章试满还不成：这次没成（failed，原因如实）；作者点「接着记」交一次新的，已经记上的章不再记。
 *   结果不明、额度到了：停着（paused），「接着记」就是接着做这一次。
 * - 进程没了：开书对账时没有结果不明的调用就自动接着做（autoResume）。
 * - 记完：重生成一次老格式镜像（写作上下文还读它；中途不生成，几百章每章一次太费）、交三个专员的后台补读。
 * - 最新那次的记录清理时不清（keepLatest）：停着的一直挡着核账 / 定稿（rereadBlocker）。
 */
import { readAllLedgers, ledgerReread, readBookSnapshot, type LedgerRereadResult } from "@actalk/story-core";
import { syncLegacyMirror } from "../../../book/mirror/sync.js";
import { callConfiguredBrainModel, runInReaderCatchUpQueue, type BrainCallModel } from "../../../editorial/index.js";
import { awaitsReread, BASIS_RETRIES, rereadChapter, rereadFailure, rereadInputDigest, type RereadChapterOutcome } from "../../../editorial/reread.js";
import { parseRereadStep, readRereadParams, REREAD_KIND, rereadApplyStep, rereadReadStep, type RereadParams } from "../../../editorial/reread-state.js";
import { frozenCompatAllowance, frozenModelProblem, type FrozenModels } from "../../../lib/llm-client.js";
import { replayedOutcome, runCommandInOperation } from "../../../lib/operations/command.js";
import { requestReaderBackfill } from "../../../lib/reader-backfill.js";
import { rereadReadSends } from "../budgets.js";
import type { OperationResult, Recipe } from "../executor.js";

/** 一次最多记几章（导入切章的上限之内）。 */
const MAX_CHAPTERS = 5000;

/** 记账员和它写笔记都走核账员那一路的模型（qualityCheck）。 */
const REREAD_TASKS = ["qualityCheck"] as const;

/** 落账那一步的输出：记上几条、命令没收几条；changed = 途中书变了，这回没记。 */
type ApplyOutput = { readonly recorded: number; readonly rejected: number } | { readonly changed: true };

const recordedOf = (result: LedgerRereadResult): ApplyOutput => ({ recorded: result.recorded, rejected: result.rejected.length });

export interface RereadResultBody {
  readonly total: number;
  readonly recorded: number;
  readonly skipped: number;
}

export interface RereadDeps {
  readonly callModel: BrainCallModel;
  /** 这次冻结的模型能不能记账：不能返回一句原因（这次没成，配好模型点「接着记」）。 */
  readonly modelProblem: (models: FrozenModels) => string | undefined;
}

const DEFAULT_DEPS: RereadDeps = {
  callModel: callConfiguredBrainModel,
  modelProblem: (models) => frozenModelProblem(models, "qualityCheck"),
};

function oneLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim().split(/\s+/u).join(" ").slice(0, 160) || "未知错误";
}

export function createBackgroundRereadRecipe(deps: RereadDeps = DEFAULT_DEPS): Recipe<RereadParams> {
  return {
    kind: REREAD_KIND,
    version: 1,
    lane: "background",
    autoResume: true,
    keepLatest: true,

    async prepare(bookDir, input) {
      const total = (input.params as { total?: unknown } | null)?.total;
      if (typeof total !== "number" || !Number.isInteger(total) || total <= 0 || total > MAX_CHAPTERS) {
        return { ok: false, code: "bad_params", message: "通读的章数不对。" };
      }
      const chapters = (await readAllLedgers(bookDir))
        .filter((ledger) => ledger.chapter <= total && awaitsReread(ledger))
        .map((ledger) => ledger.chapter)
        .sort((a, b) => a - b);
      // 没配模型也受理：这次跑起来如实失败，进度行上一直挂着「停下了」和原因，不会让账没记全的书悄悄放行。
      return {
        ok: true,
        params: { total, chapters },
        writeScope: { chapters: [] },
        budget: chapters.reduce((sum, chapter) => sum + rereadReadSends(chapter), 0) + await frozenCompatAllowance(input.models, REREAD_TASKS),
      };
    },

    async run(ctx): Promise<OperationResult> {
      const params = readRereadParams(ctx.params);
      if (!params) throw Object.assign(new Error("通读的范围读不出来了，这次没法接着做。"), { code: "bad_params" });
      const problem = params.chapters.length > 0 && ctx.operation.models ? deps.modelProblem(ctx.operation.models) : undefined;
      if (problem) throw rereadFailure(problem);
      let recorded = 0;
      let skipped = 0;
      chapters: for (const chapter of params.chapters) {
        ctx.progress(`记账员在记第 ${chapter} 章`);
        for (let round = 0; round <= BASIS_RETRIES; round += 1) {
          const read = await ctx.step<RereadChapterOutcome>(rereadReadStep(chapter, round), { chapter }, () =>
            runInReaderCatchUpQueue(ctx.bookDir, () => rereadChapter(ctx.bookDir, chapter, deps.callModel)));
          if (read.kind === "settled") continue chapters;
          if (read.kind === "changed") continue;
          const applied = await ctx.apply<ApplyOutput>(rereadApplyStep(chapter, round), { chapter, digest: read.digest }, async () => {
            // 依据是落账这一刻重读的：记账员读的那一版（指纹）和现在不一样就不记；读完到落账之间再有写，命令核依据挡下。
            const snapshot = await readBookSnapshot(ctx.bookDir);
            if (snapshot.unsettled || rereadInputDigest(snapshot.basis, chapter) !== read.digest) return { changed: true };
            const { result } = await runCommandInOperation(ctx.bookDir, ledgerReread, { chapter, entries: [...read.entries] }, {
              what: `通读记账：第 ${chapter} 章`,
              caller: "author",
              basis: snapshot.basis,
              intent: { chapter },
            });
            if (result.ok) return recordedOf(result.result);
            if (result.code === "basis_changed") return { changed: true };
            throw rereadFailure(`第 ${chapter} 章没记上：${result.message}`);
          }, async (receipt) => recordedOf(replayedOutcome<LedgerRereadResult>(receipt, ledgerReread).result));
          if ("changed" in applied) continue;
          recorded += applied.recorded;
          skipped += read.skipped + applied.rejected;
          continue chapters;
        }
        throw rereadFailure(`记第 ${chapter} 章的途中书一直在改`);
      }
      const body: RereadResultBody = { total: params.total, recorded, skipped };
      return { schema: "operation-result/1", summary: `记账员通读记完了（${params.total} 章）。`, body };
    },

    stepBudget(stepId) {
      const step = parseRereadStep(stepId);
      return step?.phase === "read" ? rereadReadSends(step.chapter) : 0;
    },

    modelTasks() {
      return REREAD_TASKS;
    },

    async afterRun(bookDir, record) {
      if (record.state !== "succeeded") return;
      const params = readRereadParams(record.params);
      if (!params) return;
      // 没成只记日志，下次开书会重生成。
      const mirror = await syncLegacyMirror(bookDir).catch((error: unknown) => ({ ok: false as const, reason: oneLine(error) }));
      if (!mirror.ok) console.warn(`[reread] 记完了，老格式镜像没生成：${mirror.reason}`);
      // 记账员只差最后一章的笔记，核账员、章纲员从头读。
      requestReaderBackfill(bookDir, { upTo: params.total });
    },
  };
}

export const backgroundRereadRecipe = createBackgroundRereadRecipe();
