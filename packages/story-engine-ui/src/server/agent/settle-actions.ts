/**
 * 定论的两个按钮（P12「前文一次定死」）：
 *  - 核账卡上「以第 N 章为准 / 以本章为准 / 以设定为准」、设定本定论页「查前文」→ settle_preview：算出定论和前文要改的几处，出一张定论卡（只读，不改书）；
 *  - 定论卡上「确认」→ settle_apply：按票号一次改齐（作者档，改前存档、能撤销；同一票号点两次只做一次）。
 * 都不经模型判断（按钮点击就是授权），事件协议和 agent 回合一样（tool-call / tool-result / text-delta）。
 * 对话里作者说「X 以这个为准」时，对话 AI 调 settle_fact 工具，出的是同一张卡（见 tools/settle-fact.ts）。
 */
import { CANON_TEXT_MAX, type SettleApplyResult } from "@actalk/story-core";
import { callConfiguredBrainModel } from "../editorial/checker.js";
import type { BrainCallModel } from "../editorial/reader-window.js";
import { proposeSettle, type SettleRequest, type SettleSide } from "../editorial/settle/propose.js";
import { applySettleProposal, saveSettleProposal, type StoredSettleProposal } from "../editorial/settle/store.js";

const MAX_QUOTE = 800;
const MAX_EXCLUDED = 200;

export type SettleUserAction =
  | {
      readonly toolName: "settle_preview";
      readonly chapter: number;
      readonly truth: SettleSide;
      readonly other?: SettleSide;
      readonly reason?: string;
    }
  /** 设定本「定论」页上「查前文」：拿已记下（或作者刚写的）定论查全书。 */
  | { readonly toolName: "settle_preview"; readonly statement: string; readonly chapter?: number }
  | { readonly toolName: "settle_apply"; readonly token: string; readonly excluded: readonly string[] };

function readSide(value: unknown): SettleSide | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const quote = typeof record.quote === "string" ? record.quote.trim() : "";
  if (!quote || quote.length > MAX_QUOTE) return undefined;
  if (record.where === "setting") {
    const label = typeof record.label === "string" ? record.label.trim().slice(0, 40) : "";
    const card = typeof record.card === "string" ? record.card.trim().slice(0, 40) : "";
    return label ? { where: "setting", quote, label, ...(card ? { card } : {}) } : undefined;
  }
  const chapter = typeof record.chapter === "number" ? record.chapter : Number.NaN;
  return record.where === "chapter" && Number.isInteger(chapter) && chapter > 0 ? { where: "chapter", chapter, quote } : undefined;
}

/** body.action 里的两个定论按钮；形状不对返回原因（路由回 400，不当普通对话）。 */
export function parseSettleAction(record: Record<string, unknown>): { readonly action: SettleUserAction } | { readonly invalid: string } {
  if (record.toolName === "settle_apply") {
    const token = typeof record.token === "string" ? record.token.trim() : "";
    if (!/^[0-9a-f]{16}$/u.test(token)) return { invalid: "定论按钮缺少有效标识。" };
    const excluded = Array.isArray(record.excluded)
      ? [...new Set(record.excluded.filter((key): key is string => typeof key === "string" && key.length <= 20))].slice(0, MAX_EXCLUDED)
      : [];
    return { action: { toolName: "settle_apply", token, excluded } };
  }
  const chapter = typeof record.chapter === "number" ? record.chapter : Number.NaN;
  if (record.statement !== undefined) {
    const statement = typeof record.statement === "string" ? record.statement.trim() : "";
    if (!statement || statement.length > CANON_TEXT_MAX) return { invalid: "定论的内容不对。" };
    return { action: { toolName: "settle_preview", statement, ...(Number.isInteger(chapter) && chapter > 0 ? { chapter } : {}) } };
  }
  const truth = readSide(record.truth);
  if (!Number.isInteger(chapter) || chapter <= 0 || !truth) return { invalid: "定论按钮的内容不对。" };
  const other = readSide(record.other);
  const reason = typeof record.reason === "string" ? record.reason.trim().slice(0, 400) : "";
  return { action: { toolName: "settle_preview", chapter, truth, ...(other ? { other } : {}), ...(reason ? { reason } : {}) } };
}

/** 定论卡要的东西（给界面；只有名字和原句，不带编号）。 */
export interface SettleCardOutput {
  readonly token: string;
  readonly canon: string;
  readonly canonExists: boolean;
  readonly chapter?: number;
  readonly edits: readonly { readonly key: string; readonly chapter: number; readonly draft: boolean; readonly from: string; readonly to: string; readonly why?: string }[];
  readonly facts: readonly { readonly chapter: number; readonly before: string; readonly after?: string }[];
  readonly fields: readonly { readonly key: string; readonly card?: string; readonly label: string; readonly from: string; readonly to: string }[];
  readonly searched: readonly number[];
  readonly otherMissed?: { readonly chapter: number; readonly quote: string };
  readonly failures: readonly string[];
}

export function settleCardOf(stored: StoredSettleProposal): SettleCardOutput {
  return {
    token: stored.token,
    canon: stored.canon,
    canonExists: stored.canonExists,
    ...(stored.chapter !== undefined ? { chapter: stored.chapter } : {}),
    edits: stored.edits.map((edit) => ({ key: edit.key, chapter: edit.chapter, draft: edit.target === "draft", from: edit.from, to: edit.to, ...(edit.why ? { why: edit.why } : {}) })),
    facts: stored.facts.map((fact) => ({ chapter: fact.chapter, before: fact.before, ...(fact.after ? { after: fact.after } : {}) })),
    fields: stored.fields.map((field) => ({ key: field.key, ...(field.card ? { card: field.card } : {}), label: field.label, from: field.from, to: field.to })),
    searched: stored.searched,
    ...(stored.otherMissed ? { otherMissed: stored.otherMissed } : {}),
    failures: stored.failures,
  };
}

const chapterList = (chapters: readonly number[]): string => [...new Set(chapters)].sort((a, b) => a - b).map((chapter) => `第 ${chapter} 章`).join("、");

/** 预览卡上面那句话：定论 + 前文几处要改（在哪几章）+ 没查成的。 */
export function settlePreviewSummary(card: SettleCardOutput): string {
  const head = card.canonExists ? `这条定论设定本里已经有了：「${card.canon}」。` : `定论：「${card.canon}」。`;
  const where = card.edits.length > 0 ? `（${chapterList(card.edits.map((edit) => edit.chapter))}）` : "";
  const fields = card.fields.length > 0 ? `设定本 ${card.fields.length} 栏也和它对不上。` : "";
  const body = card.edits.length > 0
    ? `前文有 ${card.edits.length} 句和它对不上${where}，${fields}点「确认」一起改齐，改前存档、能撤销。`
    : card.fields.length > 0
      ? `${fields}点「确认」一起改。`
      : card.canonExists ? "前文没查出和它对不上的。" : "前文没查出和它对不上的，点「记下定论」记进设定本。";
  const missed = card.otherMissed ? `你点的那句（第 ${card.otherMissed.chapter} 章「${card.otherMissed.quote}」）这次没查出改法，可以重新查一遍。` : "";
  const failed = card.failures.length > 0 ? `没查全：${card.failures.join("；")}。` : "";
  return [head, body, missed, failed].filter(Boolean).join("");
}

/** 改齐之后那句话：记了什么、改了哪几章几处、账里跟着改了 / 作废了什么。 */
export function settleAppliedSummary(result: SettleApplyResult): string {
  const parts: string[] = [];
  if (result.cardLines.length > 0) parts.push(`设定本：${result.cardLines.join("；")}`);
  const changes = [
    ...result.chapters.map((item) => `第 ${item.chapter} 章 ${item.edits} 句`),
    ...result.drafts.map((item) => `第 ${item.chapter} 章工作稿 ${item.edits} 句`),
  ];
  if (changes.length > 0) parts.push(`改了${changes.join("、")}`);
  const updated = result.chapters.flatMap((item) => item.factsUpdated.map((text) => `第 ${item.chapter} 章「${text}」`));
  if (updated.length > 0) parts.push(`账里跟着改了${updated.join("、")}`);
  const retracted = result.chapters.flatMap((item) => item.factsRetracted.map((text) => `第 ${item.chapter} 章「${text}」`));
  if (retracted.length > 0) parts.push(`账里${retracted.join("、")}原句改了，作废了`);
  const dropped = result.chapters.flatMap((item) => item.presenceDropped.map((name) => `第 ${item.chapter} 章的「${name}」`));
  if (dropped.length > 0) parts.push(`${dropped.join("、")}改后找不到了，出场去掉了`);
  return parts.length > 0 ? `改齐了。${parts.join("；")}。` : "这次什么都没改。";
}

/** 算一份定论预览并存盘（按钮和对话工具共用）。 */
export async function previewSettle(
  projectDir: string,
  request: SettleRequest,
  callModel: BrainCallModel = callConfiguredBrainModel,
): Promise<{ readonly ok: true; readonly card: SettleCardOutput; readonly summary: string } | { readonly ok: false; readonly summary: string }> {
  const outcome = await proposeSettle({ projectDir, request, callModel });
  if (!outcome.ok) return { ok: false, summary: outcome.message };
  const stored = await saveSettleProposal(projectDir, outcome.proposal);
  const card = settleCardOf(stored);
  return { ok: true, card, summary: settlePreviewSummary(card) };
}

interface SettleActionArgs {
  readonly projectDir?: string;
  readonly sendEvent: (event: string, data: unknown) => void;
  readonly scrubber: { push(text: string): string; flush(): string };
  readonly scrubError: (error: unknown) => string;
  /** 测试注入。 */
  readonly callModel?: BrainCallModel;
}

function emitter(args: SettleActionArgs): (text: string) => void {
  return (text) => {
    const scrubbed = args.scrubber.push(text);
    if (scrubbed) args.sendEvent("text-delta", { text: scrubbed });
    const rest = args.scrubber.flush();
    if (rest) args.sendEvent("text-delta", { text: rest });
  };
}

export async function runSettleAction(args: SettleActionArgs & { readonly action: SettleUserAction }): Promise<void> {
  const { action } = args;
  const emitText = emitter(args);
  const toolName = action.toolName;
  const toolCallId = `user-action-${toolName}-${Date.now()}`;
  args.sendEvent("tool-call", { toolCallId, toolName, args: {} });
  if (!args.projectDir) {
    const summary = "没做成：没拿到书的位置，请重新打开这本书再点。";
    args.sendEvent("tool-result", { toolCallId, toolName, output: { ok: false, summary } });
    emitText(summary);
    return;
  }
  try {
    if (action.toolName === "settle_preview") {
      const request: SettleRequest = "statement" in action
        ? { kind: "statement", text: action.statement, ...(action.chapter !== undefined ? { chapter: action.chapter } : {}) }
        : {
          kind: "pick",
          chapter: action.chapter,
          truth: action.truth,
          ...(action.other ? { other: action.other } : {}),
          ...(action.reason ? { reason: action.reason } : {}),
        };
      const preview = await previewSettle(args.projectDir, request, args.callModel);
      args.sendEvent("tool-result", {
        toolCallId,
        toolName,
        output: preview.ok ? { ok: true, summary: preview.summary, settle: preview.card } : { ok: false, summary: preview.summary },
      });
      emitText(preview.summary);
      return;
    }
    const outcome = await applySettleProposal(args.projectDir, action.token, action.excluded);
    if (!outcome.ok) {
      const summary = `没改：${outcome.message}`;
      args.sendEvent("tool-result", { toolCallId, toolName, output: { ok: false, summary, settleToken: action.token } });
      emitText(summary);
      return;
    }
    const summary = outcome.replayed ? "这一步刚才已经做过了，没再改。" : settleAppliedSummary(outcome.result);
    args.sendEvent("tool-result", {
      toolCallId,
      toolName,
      output: {
        ok: true,
        summary,
        settleToken: action.token,
        // 正文、账、设定本都可能变了：整屏重读（useChat 对 settle_apply 也重读设定本）。
        refreshScope: "full",
        // 不带 chapter：改的是好几章，不能让界面当成「操作的不是当前章」跳过刷新。
        ...(outcome.snapshotId ? { snapshotId: outcome.snapshotId } : {}),
      },
    });
    emitText(summary);
    if (outcome.chapter !== undefined && !outcome.replayed) {
      const nextCallId = `${toolCallId}-next`;
      args.sendEvent("tool-call", { toolCallId: nextCallId, toolName: "suggest_next_steps", args: {} });
      args.sendEvent("tool-result", {
        toolCallId: nextCallId,
        toolName: "suggest_next_steps",
        output: {
          ok: true,
          question: "改齐了，接下来？",
          choices: [{
            label: `再核第 ${outcome.chapter} 章`,
            intent: `重新核第 ${outcome.chapter} 章的账`,
            recommended: true,
            action: { toolName: "check_continuity", chapter: outcome.chapter, fresh: true },
          }],
        },
      });
    }
  } catch (error) {
    const message = args.scrubError(error);
    args.sendEvent("tool-error", { toolCallId, toolName, error: message, retryable: true });
    emitText(`${action.toolName === "settle_preview" ? "没查成" : "没改"}：${message}。可以再点一次重试。`);
  }
}
