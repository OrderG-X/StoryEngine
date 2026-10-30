/**
 * history.change：撤销、整本恢复、裁剪操作历史（写作版本 P2a 片 4C，设计 8.1～8.3；收编 manage_snapshots、「撤销上一步」
 * 「撤销这次定稿」、操作历史里的「恢复」、「确认裁剪」）。
 *
 * - undo：撤一次操作（按钮带操作号；对话里、「撤销上一步」按钮撤「上一次」= 最近一次写过撤销范围、还没被撤的）。
 *   `target` 定撤哪次 → `plan`（核心 planRevert，书锁里算）→ 后来又改过的列成影响，停下等作者点「全撤」→ `apply`：书锁里重算，
 *   影响变了重新问；照算好的写回（history.apply，带整个撤销范围的摘要：算好之后哪里改过就重算），镜像和统计同一把锁里跟上。
 *   后来的接着这次改的东西（引用拦）、升级之前的、存档裁掉了：如实说，不撤。
 * - restore：只认作者点的（操作历史里的「恢复」、对话里的「撤销到此」）：`apply` 书锁里按存档树算、冻结整个范围的摘要、
 *   写回、换书的纪元（这次操作自己认得出），镜像和统计同一把锁里跟上。
 * - prune：`plan`（裁前链头、分界、确定的新链头）存检查点 → 对话里交的停下等作者点「确认裁剪」→ `apply`（只认两个号，比较交换）。
 * 撤销、恢复都是普通写命令：写前存档，再撤它就换回来。不调模型。
 */
import {
  chapterFromFileName,
  draftChapterOfPath,
  HISTORY_APPLY_COMMAND,
  historyApply,
  lastUndoableIn,
  ledgerChapterOfPath,
  planChapterOfPath,
  planRestore,
  planRevert,
  readReceipts,
  withBookLock,
  CARDS_PATH,
  DECISIONS_PATH,
  type HistoryApplyArgs,
  type CommandReceipt,
  type HistoryApplyResult,
  type ImpactItem,
  type RevertTarget,
} from "@actalk/story-core";
import { syncLegacyMirror } from "../../../book/mirror/sync.js";
import { withGitHistoryReader } from "../../../lib/history-reader.js";
import { replayedOutcome, runCommandInOperation } from "../../../lib/operations/command.js";
import { OperationObsolete } from "../../../lib/operations/context.js";
import { isOperationId, isTerminal, readOperation } from "../../../lib/operations/store.js";
import { humanizeHistoryLabel } from "../../../lib/snapshot-changes.js";
import { applyPrune, clampPruneKeep, planPrune, snapshotBackupBundlePath, snapshotInfoOf, type PrunePlanOutcome } from "../../../lib/snapshot.js";
import { resyncWordStats } from "../../../lib/word-stats.js";
import { coded } from "../../draft-change/steps.js";
import type { OperationResult, Recipe, RecipeContext } from "../executor.js";
import { operationChapter, operationWhat } from "../view.js";

export const HISTORY_CHANGE_KIND = "history.change";
/** 撤销停下等作者点「全撤」、裁剪停下等「确认裁剪」（种类给界面认卡，号给回显认是哪个按钮）。 */
export const UNDO_CONFIRM_KIND = "undo_confirm";
export const UNDO_CONFIRM_ACTION = "confirm-undo";
export const PRUNE_CONFIRM_KIND = "prune_confirm";
export const PRUNE_CONFIRM_ACTION = "confirm-prune";
/** 撤销算好之后书又变了：最多重算几轮（每轮影响变了都重新问）。 */
const MAX_UNDO_ROUNDS = 3;
/** 一轮里写的时候发现算好之后哪里改过：最多重算几次。 */
const MAX_APPLY_TRIES = 3;

export type HistoryChangeParams =
  /** target 不给 = 「上一次」。 */
  | { readonly mode: "undo"; readonly target?: { readonly opId: string } }
  /** 恢复到哪个存档点（操作历史里列的那个号）。 */
  | { readonly mode: "restore"; readonly snapshot: string }
  | { readonly mode: "prune"; readonly keep: number };

/** 卡上摆的（和「确认改账」卡同一个形状）：要作者看的每一条，和附带要说的。 */
export interface HistoryConfirmPreview {
  readonly lines: readonly string[];
  readonly notes: readonly string[];
}

/** 结果的 body（界面按它整本重读、记下这一轮的存档点）。 */
export interface HistoryChangeBody {
  readonly kind: typeof HISTORY_CHANGE_KIND;
  readonly mode: HistoryChangeParams["mode"];
  /** 写回 / 删掉了哪些（撤销范围里的路径）；裁剪没有。 */
  readonly paths: readonly string[];
  readonly snapshotId?: string;
}

const SNAPSHOT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export function readHistoryChangeParams(origin: string, raw: unknown, mode: string | undefined): HistoryChangeParams | { readonly invalid: string } {
  const record = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  if (mode === "undo") {
    // 撤指定的哪一次只认按钮（卡上带着那次的号）；对话里撤的是「上一次」。按钮带了号却不对：不做（当成「上一次」就撤错了）。
    if (origin !== "button" || record.opId === undefined) return { mode: "undo" };
    return typeof record.opId === "string" && isOperationId(record.opId)
      ? { mode: "undo", target: { opId: record.opId } }
      : { invalid: "要撤的是哪一次没说清，刷新后再点。" };
  }
  if (mode === "restore") {
    // 整本恢复只认作者点的（操作历史里的「恢复」、「撤销到此」）。
    if (origin !== "button") return { invalid: "整本恢复要你自己在操作历史里点「恢复」。" };
    const snapshot = typeof record.snapshot === "string" ? record.snapshot.trim() : "";
    if (!SNAPSHOT_ID.test(snapshot)) return { invalid: "要恢复到哪个存档没说清，刷新操作历史再点。" };
    return { mode: "restore", snapshot };
  }
  if (mode === "prune") {
    const keep = typeof record.keep === "number" ? record.keep : undefined;
    return { mode: "prune", keep: clampPruneKeep(keep) };
  }
  return { invalid: "要做什么没说清：撤销、恢复，还是裁剪操作历史。" };
}

/* ------------------------------------------------------------------ */
/*  给作者看的字                                                        */
/* ------------------------------------------------------------------ */

const chapterOfTextPath = (path: string): number | undefined =>
  path.startsWith("chapters/") && path.endsWith(".md") ? chapterFromFileName(path.slice("chapters/".length)) : undefined;

/** 撤销范围里的一个文件（只认六种，和白名单同一份）。 */
function pathLabel(path: string): string {
  const text = chapterOfTextPath(path);
  if (text !== undefined) return `第 ${text} 章正文`;
  const ledger = ledgerChapterOfPath(path);
  if (ledger !== undefined) return `第 ${ledger} 章的账`;
  const draft = draftChapterOfPath(path);
  if (draft !== undefined) return `第 ${draft} 章工作稿`;
  const plan = planChapterOfPath(path);
  if (plan !== undefined) return `第 ${plan} 章章纲`;
  if (path === DECISIONS_PATH) return "你记的裁定";
  if (path === CARDS_PATH) return "设定本";
  return "别的资料";
}

function pathsText(paths: readonly string[]): string {
  const labels = [...new Set(paths.map(pathLabel))];
  return labels.length > 6 ? `${labels.slice(0, 5).join("、")}等 ${labels.length} 处` : labels.join("、");
}

/** 核心命令名 → 做的什么（操作记录清掉了、不是操作写的时候用）。 */
const COMMAND_LABELS: Readonly<Record<string, string>> = {
  "chapter.commit": "定稿",
  "chapter.retitle": "改章名",
  "decision.record": "改账",
  "book.import": "导入老书",
  "book.importText": "导入已写的书",
  "ledger.reread": "通读记账",
  "draft.save": "存稿",
  "draft.applyGenerated": "AI 写稿",
  "draft.adoptCandidate": "换上 AI 稿",
  "card.write": "改设定",
  "card.fill": "AI 补设定",
  "cards.import": "搬设定",
  "settle.apply": "定论改齐",
  "plan.save": "存章纲",
  [HISTORY_APPLY_COMMAND]: "撤销 / 恢复",
};

/** 一次操作做的什么：有操作记录照它说（带章号），没有按回执的命令说。 */
async function whatOf(bookDir: string, opId: string | undefined, command: string): Promise<string> {
  if (opId) {
    const stored = await readOperation(bookDir, opId).catch(() => undefined);
    if (stored?.kind === "record") return operationWhat(stored.record.kind, stored.record.mode, operationChapter(stored.record));
  }
  return COMMAND_LABELS[command] ?? "别的改动";
}

/** 后来又改过的那几处（卡上一处一行）。 */
async function impactLines(bookDir: string, impact: readonly ImpactItem[]): Promise<string[]> {
  const lines: string[] = [];
  for (const item of impact) {
    const by = [...new Set(await Promise.all(item.by.map((write) => whatOf(bookDir, write.opId, write.command))))];
    const who = by.length > 0 ? `「${by.join("」「")}」${item.unknown ? "和别的改动" : ""}` : "别的改动";
    lines.push(`${pathLabel(item.path)}：这次之后${who}又改过`);
  }
  return lines;
}

/* ------------------------------------------------------------------ */
/*  撤销                                                                */
/* ------------------------------------------------------------------ */

/** 撤哪次、叫什么。 */
interface UndoTarget {
  readonly target: RevertTarget;
  readonly what: string;
  /** 撤的是一次撤销 / 整本恢复（结论换个说法：它退回去了，那几处回到它之前）。 */
  readonly ofHistory: boolean;
  /** 在操作之外又改过、跟操作记录接不上的这几个文件（往前找跳过的那几次、找到的这次写过的）：撤之前停下给作者看。 */
  readonly unsure?: readonly string[];
}

async function resolveUndoTarget(bookDir: string, params: Extract<HistoryChangeParams, { mode: "undo" }>): Promise<UndoTarget | undefined> {
  const receipts = await readReceipts(bookDir);
  const choice = params.target ? { target: params.target } : await lastUndoableIn(bookDir, receipts);
  if (!choice) return undefined;
  if ("ok" in choice) throw coded(choice.code, choice.message);
  const { target, unsure } = choice;
  const receipt = receipts.find((item) => ("opId" in target ? item.opId === target.opId : item.key === target.receiptKey));
  const opId = "opId" in target ? target.opId : undefined;
  if (opId) {
    const stored = await readOperation(bookDir, opId).catch(() => undefined);
    // 还没做完的那次（在跑、停着、等作者点）：撤了它还会接着写，先等它做完或停掉。
    if (stored?.kind === "record" && !isTerminal(stored.record.state)) {
      throw coded("target_active", `「${operationWhat(stored.record.kind, stored.record.mode, operationChapter(stored.record))}」还没做完，先等它做完或停掉，再撤。`);
    }
  }
  return {
    target,
    what: await whatOf(bookDir, opId, receipt?.command ?? ""),
    ofHistory: receipt?.command === HISTORY_APPLY_COMMAND,
    ...(unsure && unsure.length > 0 ? { unsure } : {}),
  };
}

type UndoCheck =
  | { readonly kind: "ready"; readonly impact: readonly string[]; readonly impactDigest: string }
  | { readonly kind: "done"; readonly paths: readonly string[]; readonly snapshotId?: string };

/** 书锁里算一次撤销（只读）。撤不了的如实失败（升级之前的、存档裁掉了、后来的接着它）。 */
async function planUndo(bookDir: string, target: RevertTarget) {
  const plan = await withBookLock(bookDir, () => withGitHistoryReader(bookDir, (reader) => planRevert(bookDir, target, reader)));
  if (!plan.ok) {
    const restoreHint = plan.code === "legacy_receipt" || plan.code === "no_tree" || plan.code === "tree_gone"
      ? "要回到那之前，到顶栏「历史」里挑那之前的存档恢复。"
      : "";
    throw coded(plan.code, `${plan.message}${restoreHint}`);
  }
  return plan;
}

/** 写回之后（同一把书锁里）：老格式镜像按新的账重生成、写作统计重数。没成只记日志（下次取依据时补）。 */
async function followUp(bookDir: string): Promise<void> {
  const mirror = await syncLegacyMirror(bookDir).catch((error: unknown) => ({ ok: false as const, reason: error instanceof Error ? error.message : String(error) }));
  if (!mirror.ok) console.warn(`[history.change] 写回后重生成老格式镜像没成（下次取依据时补）：${mirror.reason}`);
  await resyncWordStats(bookDir);
}

/** 照算好的写回（核心 history.apply）；回放过的、写成的都按回执报。 */
async function runApply(bookDir: string, args: HistoryApplyArgs, caller: "author" | "ai"): Promise<{ readonly done?: { readonly paths: readonly string[]; readonly snapshotId?: string }; readonly retry?: true }> {
  return withBookLock(bookDir, async () => {
    const { result, snapshotId } = await runCommandInOperation(bookDir, historyApply, args, { what: args.kind === "restore" ? "整本恢复" : "撤销", caller });
    if (!result.ok) {
      if (result.code === "range_changed" || result.code === "changed_since_plan") return { retry: true as const };
      throw coded(result.code, result.message);
    }
    if (!result.replayed) await followUp(bookDir);
    return { done: { paths: result.result.paths, ...(snapshotId ? { snapshotId } : {}) } };
  });
}

/** 这一步的回执已经在了（崩在写完、记检查点之前，ctx.apply 照回执回放）：照回执报，不再算、不再写。 */
function appliedPaths(receipt: CommandReceipt): readonly string[] {
  return replayedOutcome<HistoryApplyResult>(receipt, historyApply).result.paths;
}

/** 撤销的应用一步：书锁里重算；影响变了（或第一次算没有、这次有了）交回去重新问；照算好的写回，写的时候算好之后又改过就重算。 */
async function applyUndo(bookDir: string, undo: UndoTarget, confirmed: string | null, caller: "author" | "ai"): Promise<UndoCheck> {
  for (let attempt = 0; attempt < MAX_APPLY_TRIES; attempt += 1) {
    const plan = await planUndo(bookDir, undo.target);
    if (plan.impact.length > 0 && plan.impactDigest !== confirmed) {
      return { kind: "ready", impact: await impactLines(bookDir, plan.impact), impactDigest: plan.impactDigest };
    }
    if (plan.changes.length === 0) return { kind: "done", paths: [] };
    const outcome = await runApply(bookDir, {
      kind: "revert",
      label: `撤销：${undo.what}`,
      target: "opId" in undo.target ? { opId: undo.target.opId } : { receiptKey: undo.target.receiptKey },
      changes: plan.changes.map((change) => ({ ...change })),
      rangeDigest: plan.rangeDigest,
    }, caller);
    if (outcome.done) return { kind: "done", ...outcome.done };
  }
  throw coded("keeps_changing", "书一直在改，撤销算不稳，这次没撤。过一会儿再撤。");
}

const UNDO_NOTES = ["全撤会把这几处一起退回这次之前的样子：之后那几次在这几处的改动也跟着没了。"];
const UNSURE_NOTE = "这几处现在的样子跟操作记录接不上，撤了会不会动到之后改的说不准，你看过再撤。";

async function runUndo(ctx: RecipeContext<HistoryChangeParams>, params: Extract<HistoryChangeParams, { mode: "undo" }>): Promise<OperationResult> {
  const { bookDir } = ctx;
  const caller = ctx.record.origin.kind === "chat" ? "ai" : "author";
  const resolved = await ctx.step("target", { target: params.target ?? null }, async () => (await resolveUndoTarget(bookDir, params)) ?? null);
  if (!resolved) return succeeded("undo", "没有能撤的改动了。", []);
  const first = await ctx.step("plan", { target: resolved.target }, async () => {
    const plan = await planUndo(bookDir, resolved.target);
    // 跟操作记录接不上的文件：后来又改过的那几处已经一处一行列着，不再列第二遍。
    const unsure = (resolved.unsure ?? []).filter((path) => !plan.impact.some((item) => item.path === path));
    return { impact: await impactLines(bookDir, plan.impact), impactDigest: plan.impactDigest, unsure };
  });
  let confirmed: string | null = null;
  let impact: readonly string[] = first.impact;
  let digest = first.impactDigest;
  // 在操作之外改过、跟操作记录接不上的文件：撤得对不对说不准，第一回就停下给作者看（Astra 第 13 轮第 1 条、第 14 轮第 1 条）。
  const unsure = first.unsure.map((path) => `${pathLabel(path)}：在操作之外改过，跟操作记录接不上`);
  for (let round = 1; round <= MAX_UNDO_ROUNDS; round += 1) {
    if (impact.length > 0 || (round === 1 && unsure.length > 0)) {
      const notes = impact.length > 0 ? UNDO_NOTES : [UNSURE_NOTE];
      const preview: HistoryConfirmPreview = {
        lines: round === 1 ? [...impact, ...unsure] : impact,
        notes: round === 1 ? [`要撤的是「${resolved.what}」。`, ...notes] : ["算好之后书又改过，这是重新算的。", ...notes],
      };
      await ctx.waitForAuthor({ actionId: round === 1 ? UNDO_CONFIRM_ACTION : `${UNDO_CONFIRM_ACTION}-${round}`, kind: UNDO_CONFIRM_KIND, decisions: ["apply"], preview });
      confirmed = digest;
    }
    const outcome = await ctx.apply(round === 1 ? "apply" : `apply-${round}`, { target: resolved.target, confirmed }, () => applyUndo(bookDir, resolved, confirmed, caller),
      async (receipt): Promise<UndoCheck> => ({ kind: "done", paths: appliedPaths(receipt) }));
    if (outcome.kind === "done") {
      const summary = outcome.paths.length === 0
        ? `「${resolved.what}」改的那几处现在已经是那之前的样子，没什么要撤的。`
        : resolved.ofHistory
          ? `撤好了：「${resolved.what}」退回去了，${pathsText(outcome.paths)}回到它之前的样子。`
          : `撤好了：「${resolved.what}」改的退回去了（${pathsText(outcome.paths)}）。`;
      return succeeded("undo", summary, outcome.paths, outcome.snapshotId);
    }
    impact = outcome.impact;
    digest = outcome.impactDigest;
  }
  throw coded("keeps_changing", "书一直在改，撤销算不稳，这次没撤。过一会儿再撤。");
}

/* ------------------------------------------------------------------ */
/*  整本恢复                                                            */
/* ------------------------------------------------------------------ */

const SNAPSHOT_GONE = "这个存档已经不在了（裁剪过操作历史会换号），刷新操作历史再挑。";

async function applyRestore(bookDir: string, snapshot: string, label: string): Promise<{ readonly paths: readonly string[]; readonly snapshotId?: string }> {
  const info = await snapshotInfoOf(bookDir, snapshot);
  if (!info) throw coded("snapshot_gone", SNAPSHOT_GONE);
  for (let attempt = 0; attempt < MAX_APPLY_TRIES; attempt += 1) {
    const plan = await withBookLock(bookDir, () => withGitHistoryReader(bookDir, (reader) => planRestore(bookDir, info.tree, reader)));
    if (!plan.ok) throw coded(plan.code, plan.message);
    if (plan.changes.length === 0) return { paths: [] };
    const outcome = await runApply(bookDir, {
      kind: "restore",
      label: `恢复到「${label}」之前`,
      target: { snapshot },
      changes: plan.changes.map((change) => ({ ...change })),
      rangeDigest: plan.rangeDigest,
    }, "author");
    if (outcome.done) return outcome.done;
  }
  throw coded("keeps_changing", "书一直在改，恢复算不稳，这次没恢复。过一会儿再点。");
}

async function runRestore(ctx: RecipeContext<HistoryChangeParams>, params: Extract<HistoryChangeParams, { mode: "restore" }>): Promise<OperationResult> {
  // 存档叫什么先记下：恢复写成了、崩在记检查点之前，之后存档被裁掉换了号，接着做照回执报时还说得出恢复到哪（Astra 第 13 轮第 3 条）。
  const { label } = await ctx.step("snapshot", { snapshot: params.snapshot }, async () => {
    const info = await snapshotInfoOf(ctx.bookDir, params.snapshot);
    if (!info) throw coded("snapshot_gone", SNAPSHOT_GONE);
    return { label: humanizeHistoryLabel(info.label) };
  });
  const done = await ctx.apply("apply", { snapshot: params.snapshot }, () => applyRestore(ctx.bookDir, params.snapshot, label),
    async (receipt) => ({ paths: appliedPaths(receipt) }));
  const summary = done.paths.length > 0
    ? `已恢复到「${label}」之前（${pathsText(done.paths)}）。`
    : `书现在就是「${label}」之前的样子，没什么要恢复的。`;
  return succeeded("restore", summary, done.paths, done.snapshotId);
}

/* ------------------------------------------------------------------ */
/*  裁剪                                                                */
/* ------------------------------------------------------------------ */

async function runPrune(ctx: RecipeContext<HistoryChangeParams>, params: Extract<HistoryChangeParams, { mode: "prune" }>): Promise<OperationResult> {
  const { bookDir } = ctx;
  const planned: PrunePlanOutcome = await ctx.step("plan", { keep: params.keep }, () => planPrune(bookDir, params.keep));
  if (planned.kind === "noop") return succeeded("prune", `操作历史一共 ${planned.totalBefore} 条，不到 ${planned.keep} 条，不用裁。`, []);
  const { plan } = planned;
  // 裁剪是作者的决定：对话里交的停下等作者点。
  if (ctx.record.origin.kind !== "button") {
    const preview: HistoryConfirmPreview = {
      lines: [`把更早的 ${plan.prunedCount} 条存档折成一条，留最近 ${plan.keep} 条`],
      notes: ["正文和资料不动；裁前的完整历史另存一份备份。", "折掉的那些存档之后不能再恢复，那之前的改动也撤不了了。"],
    };
    await ctx.waitForAuthor({ actionId: PRUNE_CONFIRM_ACTION, kind: PRUNE_CONFIRM_KIND, decisions: ["apply"], preview });
  }
  const done = await ctx.publish("apply", { plan }, () => applyPrune(bookDir, plan, snapshotBackupBundlePath(bookDir, ctx.record.opId)));
  if (done.kind === "moved") throw new OperationObsolete("history_moved", "算好裁剪之后操作历史又变了，这次没裁；要裁再说一次。");
  return {
    schema: "operation-result/1",
    summary: `操作历史裁好了：更早的 ${plan.prunedCount} 条折成了一条，留了最近 ${plan.keep} 条。裁前的完整历史另存了一份备份。`,
    body: { kind: HISTORY_CHANGE_KIND, mode: "prune", paths: [] } satisfies HistoryChangeBody,
    ...(done.warnings.length > 0 ? { warnings: done.warnings } : {}),
  };
}

function succeeded(mode: HistoryChangeParams["mode"], summary: string, paths: readonly string[], snapshotId?: string): OperationResult {
  const body: HistoryChangeBody = { kind: HISTORY_CHANGE_KIND, mode, paths, ...(snapshotId ? { snapshotId } : {}) };
  return { schema: "operation-result/1", summary, body };
}

export const historyChangeRecipe: Recipe<HistoryChangeParams> = {
  kind: HISTORY_CHANGE_KIND,
  version: 1,
  lane: "foreground",

  async prepare(_bookDir, input) {
    const params = readHistoryChangeParams(input.origin.kind, input.params, input.mode);
    if ("invalid" in params) return { ok: false, code: "bad_params", message: params.invalid };
    return { ok: true, params, mode: params.mode, writeScope: { chapters: [] }, budget: 0 };
  },

  run(ctx) {
    const { params } = ctx;
    if (params.mode === "undo") return runUndo(ctx, params);
    if (params.mode === "restore") return runRestore(ctx, params);
    return runPrune(ctx, params);
  },

  stepBudget() {
    return 0;
  },

  modelTasks() {
    return [];
  },
};
