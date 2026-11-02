/**
 * 这一章的核账结果和稿纸底下那一个按钮（安静账房 2026-11-03：底栏只留「定稿」，别的在对话里说）。全部从现有状态算，不另存。
 *
 * 核账结果取当前会话里这一章最新的那张核账卡（对话卡和稿纸划线共用一份，作者点「不是问题」两边一起变）。
 */
import type { ChapterMessage, ContinuityCheckData, ContinuityCheckItemData } from "../type-defs/workspace.js";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { paperStage, useDraftStore, type DraftStoreState } from "../stores/draftStore.js";
import { useChatStore } from "../stores/chatStore.js";
import { cardOf } from "../utils/messageCards.js";
import { latestDirections, type ChapterDirections } from "../utils/brainstormCard.js";
import { useBookStore } from "../stores/bookStore.js";

export type ContinuityItem = ContinuityCheckItemData;

/** 稿纸底下那个按钮的悬停说明（新作者不知道点了会怎样）。 */
export const STEP_HINTS = {
  commit: "这章写完了就定稿：先对一遍前文，有对不上的才停下给你看；定了能撤销。",
  fill: "这章定稿时账没记上（或没记全）：照定稿的正文再记一次；正文不动，能撤销。",
} as const;

/** 一条核账问题的键（「不是问题」按它记）：本章原句 + 前文原句。 */
export function continuityItemKey(item: Pick<ContinuityItem, "quote" | "earlierQuote">): string {
  return `${item.quote}#${item.earlierQuote}`;
}

/** 这条错在哪一章（对设定本的条目可能指向前文那章）；缺省＝核的这一章。 */
export function continuityFixChapter(chapter: number, item: Pick<ContinuityItem, "fixChapter">): number {
  return item.fixChapter !== undefined && item.fixChapter > 0 ? item.fixChapter : chapter;
}

/**
 * 核账原句还在不在这份稿子里（不计空白；「A……B」两截按顺序都找到才算在）。和稿纸划线找原句是同一个口径：
 * 不在 = 那句已经改掉了（改这处、定论改齐、作者自己改），核账卡上这条不再给改的按钮。
 */
export function quoteInPaper(body: string, quote: string): boolean {
  const squeeze = (text: string): string => [...text].filter((ch) => ch.trim() !== "").join("");
  const fragments = quote.split("…").map(squeeze).filter(Boolean);
  if (fragments.length === 0) return true;
  const text = squeeze(body);
  let from = 0;
  for (const fragment of fragments) {
    const at = text.indexOf(fragment, from);
    if (at < 0) return false;
    from = at + fragment.length;
  }
  return true;
}

export interface ContinuityResult {
  readonly messageId: string;
  readonly check: ContinuityCheckData;
  readonly dismissed: readonly string[];
  /** 核账之后定论改齐时改掉的条目键（见 settledContinuityKeys）。 */
  readonly settled?: readonly string[];
  readonly checkedVersion?: string | null;
  readonly checkedBodyHash?: string;
}

type SettledEdit = { readonly chapter: number; readonly from: string };
/** 一次改齐了的定论真改了什么（划掉没改的不算）；resolves = 核账卡上点「以本章为准」的那条。 */
type Settled = { readonly edits: readonly SettledEdit[]; readonly fieldsChanged: boolean; readonly resolves?: string };

function settledOf(message: ChapterMessage): Settled | undefined {
  const op = cardOf(message, "operation")?.op;
  const canon = op?.state === "succeeded" ? op.canon : undefined;
  if (!canon?.applied) return undefined;
  const skip = new Set(canon.excluded);
  return {
    edits: canon.card.edits.filter((edit) => !skip.has(edit.key)).map((edit) => ({ chapter: edit.chapter, from: edit.from })),
    fieldsChanged: canon.card.fields.some((field) => !skip.has(field.key)),
    ...(canon.card.resolves ? { resolves: canon.card.resolves } : {}),
  };
}

/** 改掉的那句和核账原句是同一处：一个含着另一个（核账原句是整句，可能连着两三句；定论按句改）。 */
const overlaps = (changed: string, quote: string): boolean => quoteInPaper(changed, quote) || quoteInPaper(quote, changed);

/**
 * 哪几条被定论改掉了：这条原句就在那章被改的句子里（或改的句子就在这条原句里）；或者作者点的就是这条「以本章为准」、另一边真改了
 * （对设定的＝设定本改了栏，对前文的＝那章被改的句子里有前文原句）。
 */
function settledKeysOf(check: ContinuityCheckData, later: readonly Settled[]): readonly string[] {
  if (later.length === 0) return [];
  return [...check.sure, ...check.maybe, ...(check.earlierOpen ?? [])]
    .filter((item) => {
      const chapter = continuityFixChapter(check.chapter, item);
      const key = continuityItemKey(item);
      return later.some((settled) =>
        settled.edits.some((edit) => edit.chapter === chapter && overlaps(edit.from, item.quote))
        || (settled.resolves === key && (item.againstSetting
          ? settled.fieldsChanged
          : settled.edits.some((edit) => edit.chapter === item.earlierChapter && overlaps(edit.from, item.earlierQuote)))));
    })
    .map(continuityItemKey);
}

/**
 * 每张核账卡之后、对话里改齐了的定论改掉了哪几条（messageId → 条目键）：条目原句就在定论改过的那句里 = 改掉了。
 * 只认核账卡之后的定论（对话是记录：之后操作历史里撤回了也照记录说，和别的卡一样）。
 */
export function settledContinuityByMessage(messages: readonly ChapterMessage[]): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  const later: Settled[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    const card = cardOf(message, "continuity");
    if (card) {
      const keys = settledKeysOf(card.check, later);
      if (keys.length > 0) out.set(message.id, keys);
    }
    const settled = settledOf(message);
    if (settled) later.push(settled);
  }
  return out;
}

/** 当前会话里这一章最新的核账结果；没核过返回 null。 */
export function latestContinuityResult(messages: readonly ChapterMessage[], chapter: number): ContinuityResult | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    const card = cardOf(message, "continuity");
    if (!card || card.check.chapter !== chapter) continue;
    const settled = settledKeysOf(card.check, messages.slice(index + 1).flatMap((later) => settledOf(later) ?? []));
    return {
      messageId: message.id,
      check: card.check,
      dismissed: card.dismissed ?? [],
      ...(settled.length > 0 ? { settled } : {}),
      ...(card.checkedVersion !== undefined ? { checkedVersion: card.checkedVersion } : {}),
      ...(card.checkedBodyHash !== undefined ? { checkedBodyHash: card.checkedBodyHash } : {}),
    };
  }
  return null;
}

/**
 * 还要作者看的条目（确定 / 可能）：没标「不是问题」、没被定论改掉的。
 * 作者核完又改了稿不在这里猜「那句还在不在」（模型引的原句未必逐字），由「核过后改过稿」统一说、请作者再核一遍。
 */
export function openContinuityItems(
  result: Pick<ContinuityResult, "check" | "dismissed" | "settled">,
): { readonly sure: readonly ContinuityItem[]; readonly maybe: readonly ContinuityItem[] } {
  const closed = new Set([...result.dismissed, ...(result.settled ?? [])]);
  const open = (items: readonly ContinuityItem[]) => items.filter((item) => !closed.has(continuityItemKey(item)));
  return { sure: open(result.check.sure), maybe: open(result.check.maybe) };
}

/** 稿纸底下那一个按钮：写了没定稿（或定稿后又改过）是「定稿」；已定稿、账没记上 / 没记全是「补记账」；别的时候没有。 */
export interface PaperAction {
  readonly button: "commit" | "fill";
  readonly label: string;
}

export function paperAction(input: {
  readonly paper: Pick<DraftStoreState, "body" | "committed">;
  /** 这章定稿时账没记上（pending）/ 没记全（partial）。 */
  readonly ledger?: "pending" | "partial";
}): PaperAction | undefined {
  const stage = paperStage(input.paper);
  if (stage === "empty") return undefined;
  if (stage === "committed") return input.ledger ? { button: "fill", label: "补记账" } : undefined;
  return { button: "commit", label: "定稿" };
}

/** 组件用：当前会话里这一章最新的核账结果。 */
export function useContinuityResult(chapter: number): ContinuityResult | null {
  const messages = useChatStore((s) => s.messages);
  return useMemo(() => latestContinuityResult(messages, chapter), [messages, chapter]);
}

/** 组件用：当前会话里这一章最新的走法卡（头脑风暴）。 */
export function useChapterDirections(chapter: number): ChapterDirections | undefined {
  const messages = useChatStore((s) => s.messages);
  return useMemo(() => latestDirections(messages, chapter), [messages, chapter]);
}

/** 组件用：稿纸 + 章节账的现状 → 底下那一个按钮。 */
export function usePaperAction(): PaperAction | undefined {
  const paper = useDraftStore(useShallow((s) => ({ chapter: s.chapter, body: s.body, committed: s.committed })));
  const ledger = useBookStore((s) => s.currentOverview?.ledgerShort?.find((item) => item.chapter === paper.chapter)?.status);
  return useMemo(() => paperAction({ paper, ...(ledger ? { ledger } : {}) }), [paper, ledger]);
}
