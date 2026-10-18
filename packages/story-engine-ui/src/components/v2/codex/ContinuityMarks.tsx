/**
 * ContinuityMarks —— 核账问题画在稿纸原句下面（重构 P6，草图 ①）。
 *
 * 同 NamePeek：不碰编辑器内核，用 CSS Custom Highlight API 画线（不改 DOM、不进文档、不影响编辑和存稿）。
 *  - 确定对不上：红色波浪线；可能：琥珀色点线。只画错在这一章、原句还在稿里的（改掉了自然不画）。
 *  - 点划线那句：在句子下面弹小框——前文原句、理由、【改这处】【不是问题】。改这处照旧是给 AI 发「只改这一处」。
 *  - 右栏「去看那 N 处」：滚到第一处并打开小框（requestContinuityFocus）。
 * 浏览器不支持 Highlight API 时没有划线，右栏和对话卡照常可用。
 */
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { buildContinuityFixIntent, canFixDirectly, continuityFixAction } from "./ContinuityCheckCard.js";
import type { AgentUserAction } from "../../../api/agentChatClient.js";
import {
  continuityFixChapter,
  continuityItemKey,
  openContinuityItems,
  type ContinuityItem,
  type ContinuityResult,
} from "../../../workspace/chapterProgress.js";
import { dismissContinuityItem } from "../../../workspace/continuityActions.js";
import { useNavigationStore } from "../../../stores/navigationStore.js";

const SURE = "se-cc-sure";
const MAYBE = "se-cc-maybe";

/** 「去看那 N 处」：右栏点了，稿纸滚到第一处并打开。 */
export const useContinuityFocus = create<{ readonly seq: number; readonly request: () => void }>((set) => ({
  seq: 0,
  request: () => set((state) => ({ seq: state.seq + 1 })),
}));

export function requestContinuityFocus(): void {
  useContinuityFocus.getState().request();
}

interface Mark {
  readonly key: string;
  readonly item: ContinuityItem;
  readonly level: "sure" | "maybe";
  readonly range: Range;
}

interface PopState {
  readonly mark: Mark;
  readonly top: number;
  readonly left: number;
}

const isSpace = (ch: string): boolean => ch.trim() === "";

function textNodesUnder(root: Element): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  return nodes;
}

/**
 * 在稿纸正文里找这句原句（不计空白，可跨文本节点、跨段），取第一处。
 * 模型引原句有时用「……」连起两截（「A……B」）：依次找到每一截，从第一截画到最后一截。
 */
export function findQuoteRange(root: Element, quote: string): Range | null {
  const fragments = quote.split("…").map((part) => [...part].filter((ch) => !isSpace(ch)).join("")).filter(Boolean);
  if (fragments.length === 0) return null;
  let text = "";
  const map: { readonly node: Text; readonly offset: number }[] = [];
  for (const block of root.querySelectorAll("p")) {
    if (block.closest("button, .se-cc-pop, .se-name-peek")) continue;
    for (const node of textNodesUnder(block)) {
      for (let offset = 0; offset < node.data.length; offset += 1) {
        const ch = node.data[offset]!;
        if (isSpace(ch)) continue;
        text += ch;
        map.push({ node, offset });
      }
    }
  }
  const first = text.indexOf(fragments[0]!);
  if (first < 0) return null;
  let end = first + fragments[0]!.length;
  for (const fragment of fragments.slice(1)) {
    const at = text.indexOf(fragment, end);
    if (at < 0) return null;
    end = at + fragment.length;
  }
  const startAt = map[first]!;
  const endAt = map[end - 1]!;
  const range = document.createRange();
  range.setStart(startAt.node, startAt.offset);
  range.setEnd(endAt.node, endAt.offset + 1);
  return range;
}

function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const pos = doc.caretPositionFromPoint?.(x, y);
  if (pos) return { node: pos.offsetNode, offset: pos.offset };
  const range = doc.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

type HighlightRegistry = Map<string, unknown>;
type HighlightCtor = new (...ranges: Range[]) => { priority?: number };

export function highlightApi(): { registry: HighlightRegistry; Ctor: HighlightCtor } | null {
  const registry = (globalThis.CSS as unknown as { highlights?: HighlightRegistry } | undefined)?.highlights;
  const Ctor = (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight;
  return registry && Ctor ? { registry, Ctor } : null;
}

export function ContinuityMarks({
  stageRef,
  result,
  contentKey,
  busy,
  onRevise,
  onFixAction,
}: {
  readonly stageRef: React.RefObject<HTMLDivElement | null>;
  /** 这一章最新的核账结果；null = 没核过。 */
  readonly result: ContinuityResult | null;
  /** 正文变了（换章 / 编辑 / AI 改稿）就重画。 */
  readonly contentKey: string;
  /** 有动作在跑：「改这处」先不让点。 */
  readonly busy: boolean;
  readonly onRevise?: (intent: string) => void;
  /** 按钮直接改（结构化动作，不经模型）；原句不逐字的照旧交给 AI（onRevise）。 */
  readonly onFixAction?: (action: AgentUserAction) => void;
}) {
  const marksRef = useRef<readonly Mark[]>([]);
  const [pop, setPop] = useState<PopState | null>(null);
  const focusSeq = useContinuityFocus((s) => s.seq);
  const chapter = result?.check.chapter ?? 0;
  const resultKey = result ? `${result.messageId}|${result.dismissed.join("|")}` : "";

  // 划线：正文或结果变了就重算（防抖跟着编辑走）。
  useEffect(() => {
    const stage = stageRef.current;
    const api = highlightApi();
    const clear = () => {
      api?.registry.delete(SURE);
      api?.registry.delete(MAYBE);
      marksRef.current = [];
    };
    if (!stage || !result) { clear(); return undefined; }
    let timer = 0;
    const paint = () => {
      const open = openContinuityItems(result);
      const marks: Mark[] = [];
      const collect = (items: readonly ContinuityItem[], level: Mark["level"]) => {
        for (const item of items) {
          if (continuityFixChapter(result.check.chapter, item) !== result.check.chapter) continue;
          const range = findQuoteRange(stage, item.quote);
          if (range) marks.push({ key: continuityItemKey(item), item, level, range });
        }
      };
      collect(open.sure, "sure");
      collect(open.maybe, "maybe");
      marksRef.current = marks;
      if (!api) return;
      const sure = new api.Ctor(...marks.filter((m) => m.level === "sure").map((m) => m.range));
      const maybe = new api.Ctor(...marks.filter((m) => m.level === "maybe").map((m) => m.range));
      sure.priority = 2;
      maybe.priority = 1;
      api.registry.set(SURE, sure);
      api.registry.set(MAYBE, maybe);
    };
    paint();
    const observer = new MutationObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(paint, 250);
    });
    observer.observe(stage, { subtree: true, childList: true, characterData: true });
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
      clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageRef, resultKey, contentKey]);

  const openAt = (mark: Mark) => {
    const stage = stageRef.current;
    if (!stage) return;
    const rects = [...mark.range.getClientRects()];
    const last = rects.at(-1) ?? mark.range.getBoundingClientRect();
    const first = rects[0] ?? last;
    const stageRect = stage.getBoundingClientRect();
    const left = Math.max(12, Math.min(first.left - stageRect.left - 12, stageRect.width - 372));
    setPop({ mark, top: last.bottom - stageRect.top + 8, left });
  };

  // 点划线那句：打开小框。点别处不管（照常编辑）。
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const onClick = (event: MouseEvent) => {
      if ((event.target as Element | null)?.closest?.(".se-cc-pop")) return;
      const caret = caretAt(event.clientX, event.clientY);
      if (!caret) return;
      const hit = marksRef.current.find((mark) => {
        try {
          if (!mark.range.isPointInRange(caret.node, caret.offset)) return false;
        } catch {
          return false;
        }
        return [...mark.range.getClientRects()].some((r) =>
          event.clientX >= r.left - 1 && event.clientX <= r.right + 1 && event.clientY >= r.top - 3 && event.clientY <= r.bottom + 3);
      });
      if (hit) openAt(hit);
    };
    const closeOnKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPop(null);
    };
    const closeOnScroll = () => setPop(null);
    stage.addEventListener("click", onClick);
    window.addEventListener("keydown", closeOnKey);
    stage.addEventListener("scroll", closeOnScroll, true);
    return () => {
      stage.removeEventListener("click", onClick);
      window.removeEventListener("keydown", closeOnKey);
      stage.removeEventListener("scroll", closeOnScroll, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageRef]);

  // 右栏「去看那 N 处」：滚到第一处确定的问题，停稳后打开。稿纸上一处都画不出来（错在前文那章 / 原句找不到）就滚到对话里那张核账卡。
  useEffect(() => {
    if (focusSeq === 0) return undefined;
    const target = marksRef.current.find((mark) => mark.level === "sure") ?? marksRef.current[0];
    if (!target) {
      if (result) document.querySelector(`[data-message-id="${CSS.escape(result.messageId)}"]`)?.scrollIntoView({ block: "start" });
      return undefined;
    }
    const anchor = target.range.startContainer.parentElement;
    anchor?.scrollIntoView({ block: "center" });
    const frame = requestAnimationFrame(() => openAt(target));
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSeq]);

  // 换章、结果换了：收起。
  useEffect(() => { setPop(null); }, [chapter, resultKey]);

  if (!pop || !result) return null;
  const { item, level } = pop.mark;
  const where = item.againstSetting
    ? `设定（${item.againstSetting.label}）`
    : item.earlierChapter === chapter ? "本章前面" : `第 ${item.earlierChapter} 章`;
  const title = `${level === "maybe" ? "可能" : ""}和${where}对不上`;
  const direct = Boolean(onFixAction) && canFixDirectly(chapter, item);
  const dismiss = () => {
    const mark = pop.mark;
    void dismissContinuityItem({ messageId: result.messageId, chapter, item: mark.item }).then((saved) => {
      if (!saved) useNavigationStore.getState().showToast("标了不是问题，但没记住（存盘出错），下次核账可能还会报。", 4200);
    });
    setPop(null);
  };
  return (
    <div
      className={`se-cc-pop is-${level}`}
      role="dialog"
      aria-label={title}
      style={{ top: pop.top, left: pop.left }}
    >
      <div className="se-cc-pop-h">
        <b>{title}</b>
        <button type="button" className="se-icon-btn sm" aria-label="关闭" onClick={() => setPop(null)}>×</button>
      </div>
      <p className="se-cc-pop-quote serif">{where}：「{item.earlierQuote}」</p>
      {item.reason ? <p className="se-cc-pop-reason">{item.reason}</p> : null}
      <div className="se-cc-pop-acts">
        {direct || onRevise ? (
          <button
            type="button"
            className="is-primary"
            disabled={busy}
            title={busy ? "等手上这件事做完再改" : "只改这一处"}
            onClick={() => {
              if (direct) onFixAction!(continuityFixAction(chapter, [item]));
              else onRevise?.(buildContinuityFixIntent(chapter, item));
              setPop(null);
            }}
          >
            改这处
          </button>
        ) : null}
        <button type="button" onClick={dismiss}>不是问题</button>
      </div>
    </div>
  );
}
