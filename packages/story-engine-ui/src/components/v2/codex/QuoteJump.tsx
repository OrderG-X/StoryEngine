/**
 * 回原句（重构 P6）：伏笔看板（以后故事地图也用）点一句原句 → 写作台打开那一章、滚到这句、短暂标亮。
 *
 * 和核账划线一样用 CSS Custom Highlight API（不改 DOM、不进文档）。工作稿里找不到、这章有定稿时切到定稿再找；
 * 都找不到就如实说「没找到（可能改过稿）」，不乱跳。
 */
import { useEffect, useRef } from "react";
import { create } from "zustand";
import { findQuoteRange, highlightApi } from "./ContinuityMarks.js";
import { useNavigationStore } from "../../../stores/navigationStore.js";

const JUMP = "se-jump";
/** 标亮停多久。 */
const JUMP_GLOW_MS = 4000;
/**
 * 换章后稿纸可能还没渲染完：隔一会儿再找，几次都找不到才算没找到。
 * 头一次也等一下：写作台换章时会把稿纸滚回顶（下一帧还会再归一次顶），先滚过去会被它拽回去（真机）。
 */
const RETRY_DELAYS_MS = [120, 400, 900] as const;

export interface QuoteJumpTarget {
  readonly chapter: number;
  readonly quote: string;
  readonly seq: number;
}

export const useQuoteJump = create<{
  readonly target: QuoteJumpTarget | null;
  readonly request: (chapter: number, quote: string) => void;
  readonly clear: () => void;
}>((set) => ({
  target: null,
  request: (chapter, quote) => set((state) => ({ target: { chapter, quote, seq: (state.target?.seq ?? 0) + 1 } })),
  clear: () => set({ target: null }),
}));

export function requestQuoteJump(chapter: number, quote: string): void {
  useQuoteJump.getState().request(chapter, quote);
}

let glowTimer: ReturnType<typeof setTimeout> | null = null;

function glow(range: Range): void {
  const api = highlightApi();
  if (api) {
    api.registry.set(JUMP, new api.Ctor(range));
    if (glowTimer) clearTimeout(glowTimer);
    glowTimer = setTimeout(() => { api.registry.delete(JUMP); glowTimer = null; }, JUMP_GLOW_MS);
  }
  const node = range.startContainer;
  const el = node instanceof Element ? node : node.parentElement;
  el?.scrollIntoView?.({ block: "center", behavior: "smooth" });
}

/** 挂在写作台稿纸旁：有要回的原句、且就是这一章时，找到它、滚过去、标亮。 */
export function QuoteJumpMarker({
  stageRef,
  chapter,
  contentKey,
  showingCommitted,
  canShowCommitted,
  onShowCommitted,
}: {
  readonly stageRef: React.RefObject<HTMLDivElement | null>;
  readonly chapter: number;
  /** 正文变了（换章、换工作稿 / 定稿）就再找一次。 */
  readonly contentKey: string;
  readonly showingCommitted: boolean;
  /** 这章有定稿可切。 */
  readonly canShowCommitted: boolean;
  readonly onShowCommitted: () => void;
}) {
  const target = useQuoteJump((state) => state.target);
  // 回调每次渲染都是新的：放 ref 里，不让它把找原句的计时器一遍遍重置。
  const onShowCommittedRef = useRef(onShowCommitted);
  onShowCommittedRef.current = onShowCommitted;
  useEffect(() => {
    if (!target || target.chapter !== chapter) return undefined;
    const timers: ReturnType<typeof setTimeout>[] = [];
    let done = false;
    RETRY_DELAYS_MS.forEach((delay, index) => {
      timers.push(setTimeout(() => {
        if (done) return;
        const stage = stageRef.current;
        const range = stage ? findQuoteRange(stage, target.quote) : null;
        if (range) {
          done = true;
          glow(range);
          useQuoteJump.getState().clear();
          return;
        }
        if (index < RETRY_DELAYS_MS.length - 1) return;
        done = true;
        if (!showingCommitted && canShowCommitted) {
          // 工作稿改过了：定稿里应该还在，切过去（contentKey 变了会再找一轮）。
          onShowCommittedRef.current();
          return;
        }
        useQuoteJump.getState().clear();
        useNavigationStore.getState().showToast(`第 ${chapter} 章稿里没找到这句（可能改过稿）。`, 4200);
      }, delay));
    });
    return () => { done = true; timers.forEach(clearTimeout); };
  }, [target, chapter, contentKey, showingCommitted, canShowCommitted, stageRef]);
  return null;
}
