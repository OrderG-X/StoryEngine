/**
 * 通读记账的状态（P8 导入连载；写作版本 P2a 片 3D 起通读本身是执行器的 background.reread 操作，
 * 配方在 services/operations/recipes/background-reread.ts，原来的 `agents/ledger/reread.json` 删了）。纯读 + 文案，谁都能 import（不成环）。
 *
 * 状态从这本书最新那次 background.reread 的记录算：排着 / 跑着 = running；停着、没成、停掉、作废 = stopped（等作者点「接着记」）；
 * 成了 = done。记完几章也从记录算（受理时冻结了要记哪几章，落了账的步骤记在 appliedEffects 里），不读每章账单
 * （进度行要轮询，几百章不能每次都读一遍）。最新那次的记录清理时不清（配方 keepLatest）：停着的通读一直挡着，不会过了三十天悄悄放行。
 * 进度行、核账 / 定稿 / 拟纲前的那道闸都读它。
 */
import { listOperations, type OperationRecord, type PauseReason } from "../lib/operations/store.js";

export const REREAD_KIND = "background.reread" as const;

/** 受理时冻结的：要记到第几章（导入时的章数）、这次要记哪几章（那时账单还是导入时那份空账单的，按章号排）。 */
export interface RereadParams {
  readonly total: number;
  readonly chapters: readonly number[];
}

const positiveInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0;

export function readRereadParams(value: unknown): RereadParams | undefined {
  const { total, chapters } = (value ?? {}) as { total?: unknown; chapters?: unknown };
  if (!positiveInt(total) || !Array.isArray(chapters)) return undefined;
  if (chapters.some((chapter) => !positiveInt(chapter) || chapter > total)) return undefined;
  return { total, chapters: chapters as number[] };
}

/** 步骤号：第 chapter 章第 round 回（记的途中书变了，照新的样子再来一回）的「读」和「记」。 */
export const rereadReadStep = (chapter: number, round: number): string => `read:${chapter}:${round}`;
export const rereadApplyStep = (chapter: number, round: number): string => `apply:${chapter}:${round}`;

export function parseRereadStep(stepId: string | undefined): { readonly phase: "read" | "apply"; readonly chapter: number; readonly round: number } | undefined {
  const matched = stepId ? /^(read|apply):(\d+):(\d+)$/u.exec(stepId) : null;
  return matched ? { phase: matched[1] as "read" | "apply", chapter: Number(matched[2]), round: Number(matched[3]) } : undefined;
}

export interface RereadState {
  /** running = 在记（排着、跑着）；stopped = 停下了，等作者点「接着记」；done = 记完了。 */
  readonly status: "running" | "stopped" | "done";
  readonly opId: string;
  readonly total: number;
  /** 记完了几章。 */
  readonly done: number;
  /** 停下的原因（status = stopped）。 */
  readonly stoppedReason?: string;
}

/** 停着的通读为什么停（进度行「记账员记到第 x/y 章停下了：…」后面那句）。 */
const PAUSED: Readonly<Record<PauseReason, string>> = {
  interrupted: "软件关过",
  attempt_unknown: "有一次调用发出去了、结果没收到（可能已经计费），接着记会把这一次重发",
  budget: "这次能用的调用次数用完了",
  material: "专员还在读前文",
};

function stoppedReasonOf(record: OperationRecord): string {
  if (record.state === "paused") return PAUSED[record.pauseReason ?? "interrupted"];
  if (record.state === "cancelled") return "停掉了";
  return record.failure?.message ?? "没记上";
}

/** 这次落了账的章（应用步骤记进了 appliedEffects 的）。 */
function appliedChapters(record: OperationRecord): Set<number> {
  const chapters = new Set<number>();
  for (const effect of record.appliedEffects ?? []) {
    const step = parseRereadStep(effect.stepId);
    if (step?.phase === "apply") chapters.add(step.chapter);
  }
  return chapters;
}

/** 这本书最新那次通读的记录（没有 = 这本书没通读过，或是升级前就记完了的）。 */
export function latestReread(records: readonly OperationRecord[]): OperationRecord | undefined {
  let latest: OperationRecord | undefined;
  for (const record of records) {
    if (record.kind === REREAD_KIND && (!latest || record.createdAt > latest.createdAt)) latest = record;
  }
  return latest;
}

export function rereadStateOf(record: OperationRecord): RereadState | undefined {
  const params = readRereadParams(record.params);
  if (!params) return undefined;
  if (record.state === "succeeded") return { status: "done", opId: record.opId, total: params.total, done: params.total };
  const done = Math.min(params.total, params.total - params.chapters.length + appliedChapters(record).size);
  const running = record.state === "queued" || record.state === "running";
  return { status: running ? "running" : "stopped", opId: record.opId, total: params.total, done, ...(running ? {} : { stoppedReason: stoppedReasonOf(record) }) };
}

export async function readRereadState(root: string): Promise<RereadState | undefined> {
  const latest = latestReread(await listOperations(root).catch(() => [] as OperationRecord[]));
  return latest ? rereadStateOf(latest) : undefined;
}

/**
 * 还要多久（分钟）：按这次相邻两章落账的间隔取中位数估（停过的那一段不会把估计拉长）；在跑才估，落账不到 2 章不估。
 */
export function rereadEtaMinutes(record: OperationRecord, state: RereadState): number | undefined {
  if (state.status !== "running") return undefined;
  const times = (record.appliedEffects ?? []).filter((effect) => parseRereadStep(effect.stepId)?.phase === "apply").map((effect) => Date.parse(effect.at)).filter(Number.isFinite).sort((a, b) => a - b);
  if (times.length < 2) return undefined;
  const gaps = times.slice(1).map((time, index) => time - times[index]!).sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)]!;
  return Math.max(1, Math.round((median * (state.total - state.done)) / 60_000));
}

/** 「大约还要 25 分钟」/「大约还要 2 小时」。 */
export function formatRereadEta(minutes: number): string {
  if (minutes < 60) return `大约还要 ${minutes} 分钟`;
  const hours = Math.round(minutes / 60);
  return `大约还要 ${hours} 小时`;
}

/** 状态 + 估的剩余时间（进度行、那道闸共用一次读）。 */
export async function readRereadProgress(root: string): Promise<(RereadState & { readonly etaMinutes?: number }) | undefined> {
  const latest = latestReread(await listOperations(root).catch(() => [] as OperationRecord[]));
  const state = latest ? rereadStateOf(latest) : undefined;
  if (!latest || !state) return undefined;
  const eta = rereadEtaMinutes(latest, state);
  return eta !== undefined ? { ...state, etaMinutes: eta } : state;
}

/**
 * 通读没完成时，核账 / 定稿 / 拟纲这些要读全书账的动作挡在这里：账还没记全，核出来的「对不上」会是假的。
 * 返回给作者看的一句话；通读完了（或这本书没有通读）返回 undefined。action 是这次被挡的动作（核账 / 定稿 / 想走法 / 出稿）。
 */
export async function rereadBlocker(root: string, action: string): Promise<string | undefined> {
  const state = await readRereadProgress(root);
  if (!state || state.status === "done") return undefined;
  const waiting = "核账、定稿、想走法、AI 写稿都要等它记完，你自己写不受影响。";
  if (state.status === "stopped") {
    return `这次没能${action}：记账员通读前文停在了第 ${Math.min(state.done + 1, state.total)} 章（${state.stoppedReason ?? "没记上"}），点右栏进度行的「接着记」。${waiting}`;
  }
  return `这次没能${action}：记账员还在通读前文、逐章记账（记完 ${state.done}/${state.total} 章${state.etaMinutes ? `，${formatRereadEta(state.etaMinutes)}` : ""}）。${waiting}`;
}
