/**
 * 这一章还差什么（重构 P6）：写 / 核账 / 定稿三步走到哪了、下一步按哪个按钮。
 * 稿纸底下的工具条、右栏顶卡都从这里取，说法一处定，两处一致。全部从现有状态算，不另存。
 *
 * 核账结果取当前会话里这一章最新的那张核账卡（对话卡和稿纸划线共用一份，作者点「不是问题」两边一起变）。
 */
import type { ChapterMessage, ContinuityCheckData, ContinuityCheckItemData } from "../type-defs/workspace.js";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { isDraftDirty, paperStage, useDraftStore, type DraftStoreState } from "../stores/draftStore.js";
import { useChatStore } from "../stores/chatStore.js";
import { cardOf } from "../utils/messageCards.js";
import { latestDirections, type ChapterDirections } from "../utils/brainstormCard.js";
import type { ChapterButton } from "../utils/chapterButtons.js";
import { countTextWords } from "../utils/textUtils.js";

export type ContinuityItem = ContinuityCheckItemData;

/** 一条核账问题的键（「不是问题」按它记）：本章原句 + 前文原句。 */
export function continuityItemKey(item: Pick<ContinuityItem, "quote" | "earlierQuote">): string {
  return `${item.quote}#${item.earlierQuote}`;
}

/** 这条错在哪一章（对设定本的条目可能指向前文那章）；缺省＝核的这一章。 */
export function continuityFixChapter(chapter: number, item: Pick<ContinuityItem, "fixChapter">): number {
  return item.fixChapter !== undefined && item.fixChapter > 0 ? item.fixChapter : chapter;
}

export interface ContinuityResult {
  readonly messageId: string;
  readonly check: ContinuityCheckData;
  readonly dismissed: readonly string[];
  readonly checkedVersion?: string | null;
}

/** 当前会话里这一章最新的核账结果；没核过返回 null。 */
export function latestContinuityResult(messages: readonly ChapterMessage[], chapter: number): ContinuityResult | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    const card = cardOf(message, "continuity");
    if (!card || card.check.chapter !== chapter) continue;
    return {
      messageId: message.id,
      check: card.check,
      dismissed: card.dismissed ?? [],
      ...(card.checkedVersion !== undefined ? { checkedVersion: card.checkedVersion } : {}),
    };
  }
  return null;
}

/**
 * 还要作者看的条目（确定 / 可能）：没标「不是问题」的。
 * 作者核完又改了稿不在这里猜「那句还在不在」（模型引的原句未必逐字），由「核过后改过稿」统一说、请作者再核一遍。
 */
export function openContinuityItems(
  result: Pick<ContinuityResult, "check" | "dismissed">,
): { readonly sure: readonly ContinuityItem[]; readonly maybe: readonly ContinuityItem[] } {
  const dismissed = new Set(result.dismissed);
  const open = (items: readonly ContinuityItem[]) => items.filter((item) => !dismissed.has(continuityItemKey(item)));
  return { sure: open(result.check.sure), maybe: open(result.check.maybe) };
}

export type CheckState = "none" | "clean" | "issues" | "stale";
export type PrimaryKind = ChapterButton | "show_issues";

export interface ChapterProgress {
  readonly chapter: number;
  readonly words: number;
  readonly write: { readonly done: boolean; readonly text: string };
  readonly check: { readonly state: CheckState; readonly done: boolean; readonly text: string; readonly sure: number; readonly maybe: number };
  readonly commit: { readonly done: boolean; readonly text: string };
  /** 主按钮：顺序取第一个没做完的。 */
  readonly primary: { readonly kind: PrimaryKind; readonly label: string };
  /** 工具条左边那一句。 */
  readonly statusLine: string;
}

type PaperInput = Pick<DraftStoreState, "chapter" | "body" | "committed" | "baseVersion" | "savedBody" | "title" | "savedTitle" | "streaming">;

export function chapterProgress(input: {
  readonly paper: PaperInput;
  readonly result: ContinuityResult | null;
  readonly targetWords: number | null;
}): ChapterProgress {
  const { paper, result, targetWords } = input;
  const stage = paperStage(paper);
  const words = paper.body.trim() ? countTextWords(paper.body) : 0;
  const committed = stage === "committed";

  const short = targetWords && words < targetWords ? targetWords - words : 0;
  const write = stage === "empty"
    ? { done: false, text: "还没写" }
    : { done: true, text: short > 0 ? `写了 ${words.toLocaleString()} 字 · 比目标少 ${short.toLocaleString()} 字` : `写了 ${words.toLocaleString()} 字` };

  const open = result ? openContinuityItems(result) : { sure: [], maybe: [] };
  // 结果到的那一版之后稿子又变了（作者改了、AI 改了，或还有没存的字）＝核过后改过稿。定稿了就以定稿为准。
  const stale = Boolean(result) && !committed
    && (result!.checkedVersion !== undefined && (result!.checkedVersion !== paper.baseVersion || isDraftDirty(paper)));
  const checkState: CheckState = stage === "empty" || !result ? "none" : stale ? "stale" : open.sure.length > 0 ? "issues" : "clean";
  const check = committed && checkState === "none" ? {
    // 已定稿的章不再要求核账（核过的照实显示核的结果）。
    state: checkState, done: true, sure: 0, maybe: 0, text: "—",
  } : {
    state: checkState,
    done: checkState === "clean" || checkState === "issues",
    sure: open.sure.length,
    maybe: open.maybe.length,
    text: checkState === "none"
      ? "还没核"
      : checkState === "stale"
        ? "核过后改过稿"
        : checkState === "issues"
          ? `有 ${open.sure.length} 处要你看${open.maybe.length > 0 ? `，${open.maybe.length} 处可能` : ""}`
          : open.maybe.length > 0 ? `没发现确定的问题，${open.maybe.length} 处可能` : "没发现问题",
  };

  const commit = stage === "committed"
    ? { done: true, text: "已定稿" }
    : stage === "edited"
      ? { done: false, text: "定稿后又改过" }
      : { done: false, text: "还没定稿" };

  const primary: ChapterProgress["primary"] = stage === "empty"
    ? { kind: "write", label: "写这一章" }
    : committed
      ? { kind: "write_next", label: "写下一章" }
      : checkState === "none" || checkState === "stale"
        ? { kind: "check_continuity", label: checkState === "stale" ? "再核一遍" : "核账" }
        : checkState === "issues"
          ? { kind: "show_issues", label: `去看那 ${open.sure.length} 处` }
          : { kind: "commit_preview", label: "定稿" };

  const statusLine = stage === "empty"
    ? "这一章还没写"
    : committed
      ? "已定稿"
      : checkState === "none"
        ? "还没核账"
        : checkState === "stale"
          ? "核过后改过稿，要再核一遍"
          : checkState === "issues"
            ? `核过了：${open.sure.length} 处对不上${open.maybe.length > 0 ? `，${open.maybe.length} 处可能` : ""}`
            : open.maybe.length > 0 ? `核过了：没有确定对不上的，${open.maybe.length} 处可能` : "核过了，没发现对不上的地方";

  return { chapter: paper.chapter, words, write, check, commit, primary, statusLine };
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

/** 组件用：稿纸 + 当前会话的核账结果 → 这一章还差什么。 */
export function useChapterProgress(targetWords: number | null): ChapterProgress {
  const paper = useDraftStore(useShallow((s) => ({
    chapter: s.chapter, body: s.body, committed: s.committed, baseVersion: s.baseVersion,
    savedBody: s.savedBody, title: s.title, savedTitle: s.savedTitle, streaming: s.streaming,
  })));
  const result = useContinuityResult(paper.chapter);
  return useMemo(() => chapterProgress({ paper, result, targetWords }), [paper, result, targetWords]);
}
