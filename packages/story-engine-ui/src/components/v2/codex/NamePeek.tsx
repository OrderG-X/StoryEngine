/**
 * NamePeek —— 稿纸里的角色名速览（2026-10-07 改版，补齐原型）。
 *
 * 不碰编辑器内核（WritingPaper / ProseMirror 一行不改）：
 *  - 标记：用浏览器的 CSS Custom Highlight API 给正文里出现的角色名画虚下划线（不改 DOM、不进文档模型、不影响编辑与保存）；
 *  - 触发：鼠标在名字上停 450ms 弹出速览卡，移开即收；按任意键 / 滚动也收起，不打扰打字。
 * 浏览器不支持 Highlight API 时只是没有下划线，悬停速览照常可用。只读展示，不写任何数据。
 * 重构 P9：名单和卡片内容来自设定视图（人物卡 + 别名 + 账里用过的称呼；卡上前几栏、关系、账里记的现状）。
 */
import { useEffect, useRef, useState } from "react";
import type { NamePeekCard } from "./bibleIndex.js";
import { Avatar } from "./bibleVisual.js";
import { usePresence } from "../../../hooks/usePresence.js";

export interface NameOccurrence {
  readonly start: number;
  readonly end: number;
  readonly name: string;
}

/** 在一段文本里找角色名出现的位置：长名优先、互不重叠（「周屿」与「周」同时存在时取「周屿」）。名字少于 2 个字不标。 */
export function findNameOccurrences(text: string, names: readonly string[]): NameOccurrence[] {
  const sorted = [...new Set(names.map((n) => n.trim()).filter((n) => n.length >= 2))].sort((a, b) => b.length - a.length);
  const taken: boolean[] = new Array(text.length).fill(false);
  const out: NameOccurrence[] = [];
  for (const name of sorted) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(name, from);
      if (at < 0) break;
      const end = at + name.length;
      let free = true;
      for (let i = at; i < end; i += 1) if (taken[i]) { free = false; break; }
      if (free) {
        for (let i = at; i < end; i += 1) taken[i] = true;
        out.push({ start: at, end, name });
      }
      from = end;
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

const HIGHLIGHT_NAME = "se-char-names";
const HOVER_DELAY_MS = 450;

interface PeekState {
  readonly card: NamePeekCard;
  readonly top: number;
  readonly left: number;
}

function textNodesUnder(root: Element): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  return nodes;
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

export function NamePeek({
  stageRef,
  cards,
  contentKey,
  onOpenCharacter,
}: {
  readonly stageRef: React.RefObject<HTMLDivElement | null>;
  readonly cards: readonly NamePeekCard[];
  /** 正文变了（换章 / 流式写入 / 编辑）就重算下划线。 */
  readonly contentKey: string;
  readonly onOpenCharacter?: (name: string) => void;
}) {
  const names = cards.flatMap((card) => card.terms);
  const namesKey = names.join("|");
  const [peek, setPeek] = useState<PeekState | null>(null);
  const hoverTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const hoveredName = useRef<string | null>(null);

  // 下划线：Highlight API 标记全部角色名（不改 DOM）。正文变动后防抖重算。
  useEffect(() => {
    const stage = stageRef.current;
    const registry = (globalThis.CSS as unknown as { highlights?: Map<string, unknown> } | undefined)?.highlights;
    const HighlightCtor = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
    if (!stage || !registry || !HighlightCtor || names.length === 0) return undefined;
    let timer = 0;
    const paint = () => {
      const ranges: Range[] = [];
      for (const node of textNodesUnder(stage)) {
        const parent = node.parentElement;
        if (!parent || parent.closest("button, input, textarea, .se-name-peek, .cd-starter")) continue;
        for (const hit of findNameOccurrences(node.data, names)) {
          const range = document.createRange();
          range.setStart(node, hit.start);
          range.setEnd(node, hit.end);
          ranges.push(range);
        }
      }
      registry.set(HIGHLIGHT_NAME, new HighlightCtor(...ranges));
    };
    paint();
    const observer = new MutationObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(paint, 300);
    });
    observer.observe(stage, { subtree: true, childList: true, characterData: true });
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
      registry.delete(HIGHLIGHT_NAME);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageRef, namesKey, contentKey]);

  // 悬停速览：鼠标停在名字上 450ms 弹卡；离开名字 / 卡片 200ms 后收起；按键、滚动立即收起。
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || names.length === 0) return undefined;
    const clearHover = () => { if (hoverTimer.current) window.clearTimeout(hoverTimer.current); hoverTimer.current = null; };
    const scheduleClose = () => {
      if (closeTimer.current) window.clearTimeout(closeTimer.current);
      closeTimer.current = window.setTimeout(() => { setPeek(null); hoveredName.current = null; }, 200);
    };
    const onMove = (event: MouseEvent) => {
      if ((event.target as Element | null)?.closest?.(".se-name-peek")) return;
      if (event.buttons !== 0) { clearHover(); return; } // 正在拖选
      const caret = caretAt(event.clientX, event.clientY);
      let hit: { name: string; rect: DOMRect } | null = null;
      if (caret && caret.node.nodeType === Node.TEXT_NODE) {
        const node = caret.node as Text;
        for (const occ of findNameOccurrences(node.data, names)) {
          if (caret.offset < occ.start || caret.offset > occ.end) continue;
          const range = document.createRange();
          range.setStart(node, occ.start);
          range.setEnd(node, occ.end);
          // 名字可能被折成两行：逐行矩形判断，鼠标必须真在某一段字形上（caret 落在行尾空白处不算）。
          const rect = [...range.getClientRects()].find((r) =>
            event.clientX >= r.left - 1 && event.clientX <= r.right + 1 && event.clientY >= r.top - 2 && event.clientY <= r.bottom + 2);
          if (rect) hit = { name: occ.name, rect };
          break;
        }
      }
      if (!hit) {
        clearHover();
        hoveredName.current = null;
        if (peek) scheduleClose();
        return;
      }
      if (closeTimer.current) { window.clearTimeout(closeTimer.current); closeTimer.current = null; }
      if (hoveredName.current === hit.name && (hoverTimer.current || peek)) return;
      hoveredName.current = hit.name;
      clearHover();
      const target = hit;
      hoverTimer.current = window.setTimeout(() => {
        const card = cards.find((item) => item.terms.includes(target.name));
        const stageRect = stage.getBoundingClientRect();
        if (!card) return;
        const left = Math.max(12, Math.min(target.rect.left - stageRect.left - 12, stageRect.width - 332));
        setPeek({ card, top: target.rect.bottom - stageRect.top + 8, left });
      }, HOVER_DELAY_MS);
    };
    const onLeave = () => { clearHover(); hoveredName.current = null; scheduleClose(); };
    const closeNow = () => { clearHover(); hoveredName.current = null; setPeek(null); };
    stage.addEventListener("mousemove", onMove);
    stage.addEventListener("mouseleave", onLeave);
    window.addEventListener("keydown", closeNow);
    stage.addEventListener("scroll", closeNow, true);
    return () => {
      stage.removeEventListener("mousemove", onMove);
      stage.removeEventListener("mouseleave", onLeave);
      window.removeEventListener("keydown", closeNow);
      stage.removeEventListener("scroll", closeNow, true);
      clearHover();
      if (closeTimer.current) window.clearTimeout(closeTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageRef, namesKey, peek]);

  // 换章时收起。
  useEffect(() => { setPeek(null); }, [contentKey]);

  // 收起时淡出：留着最后那张卡播完退场。
  const presence = usePresence<HTMLDivElement>(peek !== null);
  const lastPeek = useRef(peek);
  if (peek) lastPeek.current = peek;
  const shown = peek ?? (presence.mounted ? lastPeek.current : null);
  if (!shown) return null;
  const c = shown.card;
  const empty = c.lines.length === 0 && c.relations.length === 0 && c.now.length === 0;
  return (
    <div
      ref={presence.ref}
      className="se-name-peek"
      role="dialog"
      aria-label={`${c.name}的速览`}
      style={{ top: shown.top, left: shown.left }}
      data-closing={presence.closing || undefined}
      onMouseEnter={() => { if (closeTimer.current) { window.clearTimeout(closeTimer.current); closeTimer.current = null; } }}
      onMouseLeave={() => { closeTimer.current = window.setTimeout(() => { setPeek(null); hoveredName.current = null; }, 200); }}
    >
      <div className="se-peek-h">
        <Avatar name={c.name} kind="character" />
        <div className="se-peek-who"><b>{c.name}</b><span className={c.protagonist ? "is-hero" : undefined}>{c.protagonist ? "主角" : "人物"}</span></div>
      </div>
      <ul className="se-peek-lines">
        {c.lines.map((line) => <li key={line}>{line}</li>)}
        {c.relations.slice(0, 2).map((line) => <li key={line}>{line}</li>)}
        {c.now.map((line) => <li key={line} className="is-now">{line}</li>)}
        {empty ? <li className="is-empty">卡上还没写东西。</li> : null}
      </ul>
      {onOpenCharacter ? (
        <div className="se-peek-f">
          <button type="button" onClick={() => { setPeek(null); onOpenCharacter(c.name); }}>在设定本中打开</button>
        </div>
      ) : null}
    </div>
  );
}
