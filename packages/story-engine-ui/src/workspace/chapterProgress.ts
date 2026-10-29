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
import { nextUncommittedChapter, type ChapterButton } from "../utils/chapterButtons.js";
import { useBookStore } from "../stores/bookStore.js";
import { countTextWords } from "../utils/textUtils.js";

export type ContinuityItem = ContinuityCheckItemData;

/**
 * 三步和各按钮的悬停说明（2026-10-22 好上手走查：新作者不知道「核账」「定稿」是干什么的、点了会怎样）。
 * 顶卡、稿纸工具条共用。
 */
export const STEP_HINTS = {
  write: "AI 照设定和前文写这一章的工作稿，要几分钟；写之前存档，能撤销。也可以直接在稿纸上自己写。",
  write_next: "AI 写下一章的工作稿，要几分钟；写之前存档，能撤销。",
  continuity: "拿这一章对一遍前文和设定，找前后对不上的地方（人名、日子、谁知道什么……）。只看不改。",
  commit_preview: "这章写完了就定稿：先出一张清单给你过目（这章记进账本的人、事、线索），你点确认才定；能撤销。",
  show_issues: "在稿纸上看划线的那几句。",
} as const satisfies Partial<Record<ChapterButton | "show_issues", string>>;

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
}

type SettledEdit = { readonly chapter: number; readonly from: string };
/** 一张改齐了的定论卡真改了什么（划掉没改的不算）；resolves = 核账卡上点「以本章为准」的那条。 */
type Settled = { readonly edits: readonly SettledEdit[]; readonly fieldsChanged: boolean; readonly resolves?: string };

function settledOf(message: ChapterMessage): Settled | undefined {
  const card = cardOf(message, "settle");
  if (!card?.applied) return undefined;
  const skip = new Set(card.excluded ?? []);
  return {
    edits: card.settle.edits.filter((edit) => !skip.has(edit.key)).map((edit) => ({ chapter: edit.chapter, from: edit.from })),
    fieldsChanged: card.settle.fields.some((field) => !skip.has(field.key)),
    ...(card.settle.resolves ? { resolves: card.settle.resolves } : {}),
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

export type CheckState = "none" | "clean" | "issues" | "stale";
/** show_issues＝滚到稿纸上第一条划线；open_next＝已定稿的章去后面第一个没定稿的章（只换章，不出稿）。 */
export type PrimaryKind = ChapterButton | "show_issues" | "open_next";

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
  /** 已定稿时：后面第一个没定稿的章（「去第 N 章」去这里）。 */
  readonly next?: number;
}

type PaperInput = Pick<DraftStoreState, "chapter" | "body" | "committed" | "baseVersion" | "savedBody" | "title" | "savedTitle" | "streaming">;

export function chapterProgress(input: {
  readonly paper: PaperInput;
  readonly result: ContinuityResult | null;
  readonly targetWords: number | null;
  /** 后面第一个没定稿的章（章表算的）；已定稿时主按钮去这一章。 */
  readonly nextChapter?: number;
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
  const check = committed ? {
    // 已定稿的章不再要求核账；定稿前核出来的那几处作者已经看过（改了或认了），不再标红催。
    state: "none" as const, done: true, sure: 0, maybe: 0, text: result ? "定稿前核过" : "—",
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
    ? { kind: "write", label: "AI 写这一章" }
    : committed
      // 已定稿：去后面第一个没定稿的章（那章有稿就接着弄，没稿就在那儿挑走法或写），不在这儿直接出稿。
      ? input.nextChapter ? { kind: "open_next", label: `去第 ${input.nextChapter} 章` } : { kind: "write_next", label: "AI 写下一章" }
      : checkState === "none" || checkState === "stale"
        ? { kind: "continuity", label: checkState === "stale" ? "再核一遍" : "核账" }
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

  return { chapter: paper.chapter, words, write, check, commit, primary, statusLine, ...(committed && input.nextChapter ? { next: input.nextChapter } : {}) };
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
  const chapters = useBookStore((s) => s.workspace.chapters);
  const nextChapter = useMemo(() => (paper.chapter > 0 ? nextUncommittedChapter(paper.chapter, chapters) : undefined), [paper.chapter, chapters]);
  return useMemo(() => chapterProgress({ paper, result, targetWords, ...(nextChapter ? { nextChapter } : {}) }), [paper, result, targetWords, nextChapter]);
}
