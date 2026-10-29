/**
 * settings.change：改设定本（写作版本 P2a 片 3，契约第七节；收编 foundation_write、「确认改设定」「认下」）。
 *
 * - 对话 AI 交（`change_settings`）：`plan`（书锁里取依据、读设定卡、分 AI 能做的和碰了作者写的、试算）→
 *   全是 AI 能做的：`apply`（card.fill，存档、可撤销）→ `accept`（AI 刚写进去的那几处，给「认下」按钮备好）；
 *   碰到作者写的：**整批**停下等作者点「确认改设定」→ `apply`（card.write，作者档；提议之后书变了就不改、说哪样变了）。
 * - 「认下」：作者按钮的新操作（参数带那次改设定的号）：读那次 `accept` 步骤存的改法和依据 → `apply`（card.write）。
 *   那次已经清掉了、或之后设定又改过，如实说按钮旧了。
 * 不调模型。
 */
import { applyCardOps, MAX_OPS_PER_CHANGE, readCardsOrLegacy, splitForAi, withSettledBook, type BasisChange, type CardOp, type TruthBasis } from "@actalk/story-core";
import { describeBasisChanges, readTruthBasisForWork } from "../../../book/truth-basis.js";
import { writeCardsInOperation, type CardWriteOutcome } from "../../../lib/card-write.js";
import { readCheckpoint } from "../../../lib/operations/checkpoints.js";
import { OperationObsolete, rethrowIfStopped } from "../../../lib/operations/context.js";
import { readOperation } from "../../../lib/operations/store.js";
import { coded } from "../../draft-change/steps.js";
import { acceptOpsFor, readSettingsOps } from "../../settings-change/ops.js";
import type { OperationResult, Recipe } from "../executor.js";

export const SETTINGS_CHANGE_KIND = "settings.change";
/** 改设定停下等作者点的按钮（种类给界面认卡，号给回显认是哪个按钮）。 */
export const SETTINGS_CONFIRM_KIND = "settings_confirm";
export const SETTINGS_CONFIRM_ACTION = "confirm-settings";
export type SettingsChangeParams =
  /** 对话 AI 提的：归一、校验过的那几步，和格式不对的那几步（如实列进「没改成」）。 */
  | { readonly mode: "ai"; readonly ops: readonly CardOp[]; readonly notDone: readonly string[] }
  /** 作者点「认下」：认下哪一次改设定里 AI 刚写进去的那几处。 */
  | { readonly mode: "accept"; readonly from: string };

/** 给作者等着点的「确认改设定」卡上摆的（和「确认改账」卡同一个形状）：要改的每一处，和附带要说的（没改成的那几步）。 */
export interface SettingsConfirmPreview {
  readonly lines: readonly string[];
  readonly notes: readonly string[];
}

/** 结果的 body（界面按它挂「认下」按钮、重读设定本）。 */
export interface SettingsChangeBody {
  readonly kind: typeof SETTINGS_CHANGE_KIND;
  readonly applied: readonly string[];
  readonly notDone: readonly string[];
  readonly snapshotId?: string;
  /** AI 刚写进去、作者可以「认下」的（按钮上说的那句）。 */
  readonly accept?: { readonly label: string };
}

interface SettingsPlan {
  /** 碰到作者写的：整批等作者点。 */
  readonly needsAuthor: boolean;
  readonly ops: readonly CardOp[];
  /** 试算出来的改动（给人看的，只有名字）。 */
  readonly lines: readonly string[];
  readonly notDone: readonly string[];
  /** AI 直接写的那批对应的「认下」（在改之前的设定上算：写作规则里本来就有 AI 补的就不带整体认下）。 */
  readonly acceptOps: readonly CardOp[];
  /** 提议时书的样子（作者点的时候比）。 */
  readonly basis: TruthBasis;
  readonly at: string;
}

interface AcceptPlan {
  readonly ops: readonly CardOp[];
  readonly lines: readonly string[];
  /** AI 那批写完的样子：认下时书从那以后变了就不认。 */
  readonly basis: TruthBasis;
}

const OP_ID = /^op-[0-9a-f]{20}$/u;

export function readSettingsChangeParams(origin: string, raw: unknown): SettingsChangeParams | { readonly invalid: string } {
  const record = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  if (typeof record.accept === "string") {
    // 认下是作者的事：只认作者点的按钮。
    if (origin !== "button") return { invalid: "认下要你自己点按钮。" };
    return OP_ID.test(record.accept) ? { mode: "accept", from: record.accept } : { invalid: "这个按钮缺了标记，请刷新后再点。" };
  }
  const ops = Array.isArray(record.ops) ? record.ops.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item)) : [];
  if (ops.length === 0) return { invalid: "没有要改的。" };
  if (ops.length > MAX_OPS_PER_CHANGE) return { invalid: `一次最多改 ${MAX_OPS_PER_CHANGE} 步，这次有 ${ops.length} 步，分几次提。` };
  const { valid, notDone } = readSettingsOps(ops);
  if (valid.length === 0) return { invalid: `设定没改：${notDone.join("；")}。` };
  return { mode: "ai", ops: valid, notDone };
}

function basisMovedMessage(outcome: CardWriteOutcome & { readonly ok: false }, what: string): string {
  const changes = (outcome.details as { readonly changes?: readonly BasisChange[] } | undefined)?.changes ?? [];
  return `${what}之后${describeBasisChanges(changes)}改过，这份改动是照改之前提的，没改。`;
}

/** 写失败：依据变了是过时（obsolete，说哪样变了），别的如实失败。 */
function throwIfFailed(outcome: CardWriteOutcome, what: string): asserts outcome is CardWriteOutcome & { readonly ok: true } {
  if (outcome.ok) return;
  if (outcome.code === "basis_changed") throw new OperationObsolete("basis_moved", basisMovedMessage(outcome, what));
  throw coded(outcome.code, outcome.message);
}

/** 书锁里取依据、读设定卡、分拆和试算（同一把锁里，中间插不进作者的改动）。 */
async function planSettings(bookDir: string, ops: readonly CardOp[], notDone: readonly string[]): Promise<SettingsPlan> {
  const settled = await withSettledBook(bookDir, async (): Promise<SettingsPlan> => {
    const at = new Date().toISOString();
    const basis = await readTruthBasisForWork(bookDir);
    const base = await readCardsOrLegacy(bookDir, at);
    const split = splitForAi(base, ops, at);
    const wrong = new Set(split.invalid.map((item) => item.op));
    const reasons = [...notDone, ...split.invalid.map((item) => item.reason)];
    if (split.needsAuthor.length === 0) {
      return { needsAuthor: false, ops: split.direct, lines: [], notDone: reasons, acceptOps: acceptOpsFor(split.direct, base), basis, at };
    }
    // 整批交给作者（契约：碰到作者写的整批出预览、等作者）：按作者身份试一遍，拿到卡上的人话；作者身份也做不了的如实说。
    const authorOps = ops.filter((op) => !wrong.has(op));
    const dry = applyCardOps(base, authorOps, { by: "author", at });
    if (!dry.ok) return { needsAuthor: true, ops: [], lines: [], notDone: [...reasons, `要你点头的那几处也做不了：${dry.message}`], acceptOps: [], basis, at };
    return { needsAuthor: true, ops: authorOps, lines: dry.lines, notDone: reasons, acceptOps: [], basis, at };
  });
  if (!settled.ok) throw coded("book_unsettled", settled.message);
  return settled.value;
}

/**
 * AI 刚写进去的那几处对应的「认下」：在写完的样子上按作者身份试一遍，有变化才给。
 * 设定已经写进去了：备不成（书一时收拾不了、镜像没跟上）只是这次不给「认下」，不把这次改设定报成没做成。
 */
async function planAccept(bookDir: string, ops: readonly CardOp[], at: string): Promise<AcceptPlan | null> {
  if (ops.length === 0) return null;
  try {
    const settled = await withSettledBook(bookDir, async () => {
      const basis = await readTruthBasisForWork(bookDir);
      const dry = applyCardOps(await readCardsOrLegacy(bookDir, at), ops, { by: "author", at });
      return dry.ok && dry.lines.length > 0 ? { ops, lines: dry.lines, basis } : null;
    });
    return settled.ok ? settled.value : null;
  } catch (error) {
    rethrowIfStopped(error);
    return null;
  }
}

const notDoneLine = (notDone: readonly string[]): string => (notDone.length > 0 ? `没改成：${notDone.join("；")}。` : "");

/** 一处都没改成：如实失败（格式不对、指错卡的说清第几步；要写的和现在一样也说）。 */
const nothingDone = (notDone: readonly string[]): Error => (notDone.length > 0
  ? coded("nothing_applied", `${notDone.join("；")}。`)
  : coded("no_change", "要写的和现在的一样，设定本没有变化。"));

export const settingsChangeRecipe: Recipe<SettingsChangeParams> = {
  kind: SETTINGS_CHANGE_KIND,
  version: 1,
  lane: "foreground",

  async prepare(bookDir, input) {
    const params = readSettingsChangeParams(input.origin.kind, input.params);
    if ("invalid" in params) return { ok: false, code: "bad_params", message: params.invalid };
    if (params.mode === "accept") {
      const source = await readOperation(bookDir, params.from);
      const body = source.kind === "record" ? (source.record.result as { readonly body?: Partial<SettingsChangeBody> } | undefined)?.body : undefined;
      if (source.kind !== "record" || source.record.kind !== SETTINGS_CHANGE_KIND || !body?.accept) {
        return { ok: false, code: "stale_button", message: "这个「认下」按钮旧了（那次改设定的记录已经清掉了），要认下请让 AI 再写一次。" };
      }
    }
    return { ok: true, params, mode: params.mode, writeScope: { chapters: [] }, budget: 0 };
  },

  async run(ctx): Promise<OperationResult> {
    const { bookDir, params } = ctx;
    if (params.mode === "accept") {
      const accept = await ctx.step("materials", { from: params.from }, async () => {
        const stored = await readCheckpoint(bookDir, params.from, "accept");
        const plan = stored?.output as AcceptPlan | null | undefined;
        if (!plan) throw new OperationObsolete("stale_button", "这个「认下」按钮旧了（那次改设定的记录已经清掉了），要认下请让 AI 再写一次。");
        return plan;
      });
      const outcome = await ctx.apply("apply", { ops: accept.ops }, () => writeCardsInOperation(bookDir, { by: "author", ops: accept.ops, basis: accept.basis }));
      throwIfFailed(outcome, "AI 写完");
      const body: SettingsChangeBody = { kind: SETTINGS_CHANGE_KIND, applied: outcome.lines, notDone: [], ...(outcome.snapshotId ? { snapshotId: outcome.snapshotId } : {}) };
      return { schema: "operation-result/1", summary: outcome.lines.length > 0 ? `${outcome.lines.join("；")}。` : "这几处已经是你写的了。", body };
    }

    const plan = await ctx.step("plan", { ops: params.ops }, () => planSettings(bookDir, params.ops, params.notDone));
    if (plan.needsAuthor) {
      if (plan.lines.length === 0) throw nothingDone(plan.notDone);
      const preview: SettingsConfirmPreview = { lines: plan.lines, notes: plan.notDone.length > 0 ? [notDoneLine(plan.notDone)] : [] };
      await ctx.waitForAuthor({ actionId: SETTINGS_CONFIRM_ACTION, kind: SETTINGS_CONFIRM_KIND, decisions: ["apply"], preview });
      const outcome = await ctx.apply("apply", { ops: plan.ops }, () => writeCardsInOperation(bookDir, { by: "author", ops: plan.ops, basis: plan.basis }));
      throwIfFailed(outcome, "提议");
      const body: SettingsChangeBody = { kind: SETTINGS_CHANGE_KIND, applied: outcome.lines, notDone: plan.notDone, ...(outcome.snapshotId ? { snapshotId: outcome.snapshotId } : {}) };
      if (outcome.lines.length === 0) throw nothingDone(plan.notDone);
      return { schema: "operation-result/1", summary: `改好了：${outcome.lines.join("；")}（可撤销）。${notDoneLine(plan.notDone)}`, body };
    }

    if (plan.ops.length === 0) throw nothingDone(plan.notDone);
    const outcome = await ctx.apply("apply", { ops: plan.ops }, () => writeCardsInOperation(bookDir, { by: "ai", ops: plan.ops, basis: plan.basis }));
    throwIfFailed(outcome, "提议");
    if (outcome.lines.length === 0) throw nothingDone(plan.notDone);
    const accept = await ctx.step("accept", { ops: plan.acceptOps }, () => planAccept(bookDir, plan.acceptOps, plan.at));
    const body: SettingsChangeBody = {
      kind: SETTINGS_CHANGE_KIND,
      applied: outcome.lines,
      notDone: plan.notDone,
      ...(outcome.snapshotId ? { snapshotId: outcome.snapshotId } : {}),
      ...(accept ? { accept: { label: "刚写的这几处" } } : {}),
    };
    const parts = [
      `改好了：${outcome.lines.join("；")}。`,
      accept ? "标着「AI 补」，点「认下」就算你写的。" : "",
      notDoneLine(plan.notDone),
    ];
    return { schema: "operation-result/1", summary: parts.join(""), body };
  },

  stepBudget: () => 0,
  modelTasks: () => [],
};
