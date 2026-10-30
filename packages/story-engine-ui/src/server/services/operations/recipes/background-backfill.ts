/**
 * background.backfill：后台给专员补前文笔记（写作版本 P2a 4.5、第七节；替掉原来 catch-up.ts 的 for (;;) 追新）。
 *
 * - 受理时冻结每个角色还差的章范围 `{role, from, to}`（按交来的角色先后；读齐了的不进范围，都读齐了不受理）。
 * - 笔记都齐了、只缺卷笔记（缓存丢了、卷笔记的提示词改了）也受理：范围就是最后那一章，那一步只补卷（Astra P2a 第 9 轮第 4 条）。
 * - 一章一步（步骤号 `<角色>:<章>`）：调同一个 `ensureReaderWindow({upTo: 章, maxCatchUp: 1, maxVolumeBuilds: 上界})`——
 *   一步写这一章的笔记 + 写它、读完它的窗口要用的卷节点；卷节点数按规划的上界（volumeBuildsBound）给，额度也按它算，
 *   到了上界还没建齐就是规划出了错，如实失败（第 9 轮第 5 条：不再分段续建、拿别的章省下的额度抵）。
 * - 途中前面的章被改了（要重写的不止这一章）：这次到此为止，收尾后按新的范围重交一次。某章读不到：这个角色停在它前一章。
 * - 笔记、卷笔记是按内容键整份覆盖的缓存（过栅栏 writeBookCache）。每一步排在这本书的补读队列上（和通读记账不同时打模型）。
 * - 进程没了：开书对账时没有结果不明的调用就自动接着做。跑成了按它这几个角色再交一次：读的途中新定稿的章、
 *   跑着时这几个角色被挡下的请求（提交口按角色排，见 recipes/index.ts）都在这一次里补上；都读齐了、读不到的章还读不到
 *   就不受理，不会空转。没跑成（失败、停掉）不自动再交：等下一次开书、核账、定稿再交；停着的等作者处理。
 */
import {
  callConfiguredBrainModel,
  countCommittedChapters,
  ensureReaderWindow,
  readerNotesStatus,
  readerRoles,
  runInReaderCatchUpQueue,
  type BrainCallModel,
} from "../../../editorial/index.js";
import { frozenCompatAllowance, frozenModelProblem, type FrozenModels } from "../../../lib/llm-client.js";
import {
  BACKFILL_KIND,
  backfillStepId,
  parseBackfillStep,
  readBackfillParams,
  submitReaderBackfill,
  type BackfillParams,
  type BackfillRange,
} from "../../../lib/reader-backfill.js";
import { READER_ROLE_LABELS } from "../../../editorial/reader-progress.js";
import { backfillBudget, backfillStepSends, backfillStepVolumeBuilds } from "../budgets.js";
import type { OperationResult, Recipe } from "../executor.js";

/** 一步的输出（存进检查点）：读到哪了、还缺几份、这一步新写了几份笔记 / 卷笔记。 */
interface StepOutput {
  readonly readThrough: number;
  readonly missing: number;
  readonly built: number;
  readonly volumesBuilt: number;
  /** 卷节点到了这一步的上界还没建齐。 */
  readonly volumeLimited?: true;
}

export interface BackfillResultBody {
  /** 每个角色这次读到第几章。 */
  readonly readThrough: Readonly<Record<string, number>>;
  /** 这次真写了笔记或卷笔记。 */
  readonly progressed: boolean;
  /** 途中前面的章改过：这次停在半路，收尾后按新的范围重交。 */
  readonly restart: boolean;
  /** 读不到某章、停在它前一章的角色。 */
  readonly stuck: readonly string[];
}

/** 交来的请求：要补的角色（缺省三个都补）、补到第几章。 */
function readRequest(value: unknown): { readonly roles?: readonly string[]; readonly upTo: number } | undefined {
  const { roles, upTo } = (value ?? {}) as { roles?: unknown; upTo?: unknown };
  if (typeof upTo !== "number" || !Number.isInteger(upTo) || upTo < 0) return undefined;
  if (roles === undefined) return { upTo };
  if (!Array.isArray(roles) || roles.some((role) => typeof role !== "string")) return undefined;
  return { roles: [...new Set(roles as string[])], upTo };
}

export interface BackfillDeps {
  /** 专员写笔记的模型调用（缺省核账员那一路，按这次冻结的模型）。 */
  readonly callModel: BrainCallModel;
  /** 这次冻结的模型能不能写笔记：不能返回一句原因（不受理）。 */
  readonly modelProblem: (models: FrozenModels) => string | undefined;
}

/** 专员的笔记都用核账员那一路的模型（qualityCheck）写。 */
const BACKFILL_TASKS = ["qualityCheck"] as const;

const DEFAULT_DEPS: BackfillDeps = {
  callModel: callConfiguredBrainModel,
  modelProblem: (models) => frozenModelProblem(models, "qualityCheck"),
};

export function createBackgroundBackfillRecipe(deps: BackfillDeps = DEFAULT_DEPS): Recipe<BackfillParams> {
  return {
    kind: BACKFILL_KIND,
    version: 2,
    lane: "background",
    autoResume: true,

    async prepare(bookDir, input) {
      const request = readRequest(input.params);
      if (!request) return { ok: false, code: "bad_params", message: "补读的范围不对。" };
      const all = readerRoles();
      const wanted = request.roles ? request.roles.flatMap((id) => all.filter((role) => role.id === id)) : all;
      if (wanted.length === 0) return { ok: false, code: "bad_params", message: "不认识要补的专员。" };
      const upTo = Math.min(request.upTo, await countCommittedChapters(bookDir));
      if (upTo <= 0) return { ok: false, code: "nothing_to_read", message: "还没有定稿的章，没有前文要读。" };
      // 专员的笔记都用核账员那一路的模型（qualityCheck）写：没配好就不受理，免得每次开书都留一条注定失败的记录。
      const modelProblem = deps.modelProblem(input.models);
      if (modelProblem) return { ok: false, code: "model_missing", message: modelProblem };
      const ranges: BackfillRange[] = [];
      for (const role of wanted) {
        const status = await readerNotesStatus({ projectDir: bookDir, role, upTo });
        if (status.valid < status.readable) ranges.push({ role: role.id, from: status.valid + 1, to: status.readable });
        // 笔记齐了、读完最后一章的窗口还缺卷笔记：只补卷，范围就是最后那一章。
        else if (status.readable > 0 && status.volumesMissing > 0) ranges.push({ role: role.id, from: status.readable, to: status.readable });
      }
      if (ranges.length === 0) return { ok: false, code: "nothing_to_read", message: "专员的前文笔记都读齐了。" };
      return {
        ok: true,
        params: { ranges },
        writeScope: { chapters: [] },
        // 每章笔记 1 次 + 这段里最多新生成的卷节点（实际多数章一个卷节点都不用建）。
        budget: backfillBudget(ranges) + await frozenCompatAllowance(input.models, BACKFILL_TASKS),
      };
    },

    async run(ctx): Promise<OperationResult> {
      const params = readBackfillParams(ctx.params);
      if (!params) throw Object.assign(new Error("补读的范围读不出来了，这次没法接着做。"), { code: "bad_params" });
      const roles = readerRoles();
      const readThrough: Record<string, number> = {};
      const stuck: string[] = [];
      let progressed = false;
      let restart = false;
      ranges: for (const range of params.ranges) {
        const role = roles.find((candidate) => candidate.id === range.role);
        if (!role) throw Object.assign(new Error("要补的专员已经没有了，这次没法接着做。"), { code: "bad_params" });
        readThrough[range.role] = range.from - 1;
        for (let chapter = range.from; chapter <= range.to; chapter += 1) {
          ctx.progress(`${READER_ROLE_LABELS[role.id] ?? role.id}在读第 ${chapter} 章`);
          const output = await ctx.step<StepOutput>(backfillStepId(role.id, chapter), { role: role.id, chapter }, () =>
            runInReaderCatchUpQueue(ctx.bookDir, async () => {
              const ready = await ensureReaderWindow({
                projectDir: ctx.bookDir,
                role,
                upTo: chapter,
                callModel: deps.callModel,
                maxCatchUp: 1,
                maxVolumeBuilds: backfillStepVolumeBuilds(chapter),
              });
              return { readThrough: ready.readThrough, missing: ready.missing, built: ready.built, volumesBuilt: ready.volumesBuilt, ...(ready.volumeLimited ? { volumeLimited: true as const } : {}) };
            }));
          if (output.built > 0 || output.volumesBuilt > 0) progressed = true;
          // 卷节点按上界给的还没建齐：规划出了错，如实失败（已建的卷笔记按内容键留着）。
          if (output.volumeLimited) {
            throw Object.assign(new Error(`第 ${chapter} 章的卷笔记按上限建完还没建齐，这次先停下。`), { code: "volume_not_settled" });
          }
          if (output.missing > 0) {
            // 没写东西就缺：要重写的不止这一章（前面的章途中改过）。这次到此为止，收尾后按新的范围重交。
            restart = true;
            break ranges;
          }
          readThrough[range.role] = output.readThrough;
          // 这一章（或更早的）定稿读不到了：这个角色停在能读到的那章，后面的不读。
          if (output.readThrough < chapter) {
            stuck.push(range.role);
            continue ranges;
          }
        }
      }
      const body: BackfillResultBody = { readThrough, progressed, restart, stuck };
      const summary = restart
        ? "前面的章途中改过，专员接着按改过的读。"
        : `专员读完了前文（${Object.entries(readThrough).map(([role, chapter]) => `${READER_ROLE_LABELS[role] ?? role}到第 ${chapter} 章`).join("，")}）。`;
      return { schema: "operation-result/1", summary, body };
    },

    stepBudget(stepId) {
      const step = parseBackfillStep(stepId);
      return step ? backfillStepSends(step.chapter) : 0;
    },

    modelTasks() {
      return BACKFILL_TASKS;
    },

    async afterRun(bookDir, record) {
      if (record.state !== "succeeded") return;
      const params = readBackfillParams(record.params);
      if (!params) return;
      // 按这次的角色再看一眼（读的途中新定稿的章、跑着时这几个角色被挡下的请求都在这一次里）。都读齐了就不受理。
      await submitReaderBackfill(bookDir, { roles: params.ranges.map((range) => range.role), upTo: await countCommittedChapters(bookDir) });
    },
  };
}

export const backgroundBackfillRecipe = createBackgroundBackfillRecipe();
