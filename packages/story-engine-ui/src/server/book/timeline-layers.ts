/**
 * timeline-layers.ts
 *
 * 确定性纯函数：从全量 TimelineEvent[] 按「读时派生」策略产出三层分层摘要。
 *
 * L1 近窗口（近 l1Window 章）→ 完整  chapter + summary + mainEvent + participants
 * L2 中段（l1Window..l2Window 章前）→ per-章紧凑  chapter + summary + mainEvent(截断)
 * L3 远期（超过 l2Window 章前）→ 每 l3BlockSize 章压一条宏事件块
 *
 * 设计约束：
 * - 纯同步，不调 LLM，不读写磁盘
 * - 题材中立
 * - effects.semanticSummary 用防御式读取（字段可能不存在）
 * - currentChapter 为 0/NaN/null 时兜底不崩（L2/L3 空，L1 取最近 l1Window 章）
 */

import type { TimelineEvent } from "./types.js";

// ---------------------------------------------------------------------------
// 公开接口
// ---------------------------------------------------------------------------

export interface TimelineLayerEvent {
  readonly chapter: number;
  readonly summary: string;
  readonly mainEvent?: string;
  readonly participants?: readonly string[];
}

export interface TimelineMacroBlock {
  readonly fromChapter: number;
  readonly toChapter: number;
  readonly summary: string;
}

export interface TimelineLayers {
  readonly l1: readonly TimelineLayerEvent[];
  readonly l2: readonly TimelineLayerEvent[];
  readonly l3: readonly TimelineMacroBlock[];
}

export interface TimelineLayersOpts {
  readonly l1Window?: number;
  readonly l2Window?: number;
  readonly l3BlockSize?: number;
}

// ---------------------------------------------------------------------------
// 内部工具：防御式读取 effects.semanticSummary 字段
// （不 import ChapterSemanticSummary，避免跨模块耦合，自包含防御读）
// ---------------------------------------------------------------------------

interface SemanticSummaryShape {
  mainEvent?: string;
  timelineSummary?: string;
  chapterSummary?: string;
}

function readSemanticSummaryLocal(event: TimelineEvent): SemanticSummaryShape | undefined {
  const effects = event.effects;
  if (typeof effects !== "object" || effects === null) return undefined;
  const semantic = effects["semanticSummary"];
  if (typeof semantic !== "object" || semantic === null) return undefined;
  const sem = semantic as Record<string, unknown>;
  return {
    mainEvent: typeof sem["mainEvent"] === "string" ? sem["mainEvent"] : undefined,
    timelineSummary: typeof sem["timelineSummary"] === "string" ? sem["timelineSummary"] : undefined,
    chapterSummary: typeof sem["chapterSummary"] === "string" ? sem["chapterSummary"] : undefined,
  };
}

/** 取最佳单行事件文本（mainEvent > timelineSummary > summary），并按 maxLen 截断 */
function bestSingleLine(event: TimelineEvent, maxLen?: number): string {
  const sem = readSemanticSummaryLocal(event);
  const text =
    (sem?.mainEvent && sem.mainEvent.trim().length > 0 ? sem.mainEvent : undefined) ??
    (sem?.timelineSummary && sem.timelineSummary.trim().length > 0 ? sem.timelineSummary : undefined) ??
    event.summary;
  if (maxLen !== undefined && text.length > maxLen) {
    return text.slice(0, maxLen);
  }
  return text;
}

/** 从事件读 mainEvent 字段（无则 undefined） */
function readMainEvent(event: TimelineEvent): string | undefined {
  const sem = readSemanticSummaryLocal(event);
  return sem?.mainEvent && sem.mainEvent.trim().length > 0 ? sem.mainEvent : undefined;
}

// ---------------------------------------------------------------------------
// 核心实现
// ---------------------------------------------------------------------------

const DEFAULT_L1_WINDOW = 3;
const DEFAULT_L2_WINDOW = 15;
const DEFAULT_L3_BLOCK_SIZE = 5;
const L2_TRUNCATE = 120;
const L3_BLOCK_TRUNCATE = 200;
/**
 * 远期块数上限（2026-10-10 引擎升级第 4 期）：原来每 5 章一块、块数随章数一直涨，500 章时这一段约 6 千 token。
 * 现在最近 L3_FINE_BLOCKS 块保持 5 章一块，更早的合成至多 L3_COARSE_BLOCKS 块（越早越粗），整段有上限。
 */
const L3_FINE_BLOCKS = 6;
const L3_COARSE_BLOCKS = 6;
/** 粗块里每章取一句的最长字数（均匀抽样，保证整段时间都有代表，而不是只剩块里最早几章）。 */
const L3_COARSE_LINE = 40;

/**
 * 同章多事件合并：取 participants 并集，summary/mainEvent 取首条非空。
 */
function mergeByChapter(events: readonly TimelineEvent[]): readonly TimelineEvent[] {
  const map = new Map<number, TimelineEvent>();
  for (const evt of events) {
    const existing = map.get(evt.chapter);
    if (!existing) {
      map.set(evt.chapter, evt);
    } else {
      // 合并：participants 取并集
      const mergedParticipants = Array.from(
        new Set([...existing.participants, ...evt.participants]),
      );
      // summary：首条非空
      const mergedSummary =
        existing.summary.trim().length > 0 ? existing.summary : evt.summary;
      // effects：优先保留有 semanticSummary.mainEvent 的那条
      const existingSem = readSemanticSummaryLocal(existing);
      const incomingSem = readSemanticSummaryLocal(evt);
      const mergedEffects =
        existingSem?.mainEvent
          ? existing.effects
          : incomingSem?.mainEvent
            ? evt.effects
            : existing.effects ?? evt.effects;
      map.set(evt.chapter, {
        ...existing,
        participants: mergedParticipants,
        summary: mergedSummary,
        effects: mergedEffects,
      });
    }
  }
  // 按章号排序
  return Array.from(map.values()).sort((a, b) => a.chapter - b.chapter);
}

/**
 * 判断 currentChapter 是否为"有效"（>0 且非 NaN）。
 * 无效时走兜底路径：L1 取最近 l1Window 条，L2/L3 空。
 */
function isValidChapter(n: number): boolean {
  return typeof n === "number" && !isNaN(n) && n > 0;
}

export function buildTimelineLayers(
  events: readonly TimelineEvent[],
  currentChapter: number,
  opts?: TimelineLayersOpts,
): TimelineLayers {
  const l1Window = opts?.l1Window ?? DEFAULT_L1_WINDOW;
  const l2Window = opts?.l2Window ?? DEFAULT_L2_WINDOW;
  const l3BlockSize = opts?.l3BlockSize ?? DEFAULT_L3_BLOCK_SIZE;

  if (events.length === 0) {
    return { l1: [], l2: [], l3: [] };
  }

  // 合并同章 + 排序
  const sorted = mergeByChapter(events);

  // 兜底：currentChapter 无效
  if (!isValidChapter(currentChapter)) {
    // L1 取最近 l1Window 章，L2/L3 空
    const l1 = sorted.slice(-l1Window).map(toLayerEvent);
    return { l1, l2: [], l3: [] };
  }

  // 边界计算
  // L1: chapter > currentChapter - l1Window
  const l1MinExclusive = currentChapter - l1Window; // exclusive lower bound
  // L2: currentChapter - l2Window < chapter <= currentChapter - l1Window
  const l2MinExclusive = currentChapter - l2Window;
  const l2MaxInclusive = currentChapter - l1Window;
  // L3: chapter <= currentChapter - l2Window
  const l3MaxInclusive = currentChapter - l2Window;

  // L1 — 近窗口，保完整字段
  const l1: TimelineLayerEvent[] = sorted
    .filter((e) => e.chapter > l1MinExclusive)
    .map(toLayerEvent);

  // L2 — 中段，per-章紧凑（mainEvent/timelineSummary 截断）
  const l2: TimelineLayerEvent[] = sorted
    .filter((e) => e.chapter > l2MinExclusive && e.chapter <= l2MaxInclusive)
    .map((e) => toLayerEventCompact(e));

  // L3 — 远期，按 l3BlockSize 分块
  const l3Events = sorted.filter((e) => e.chapter <= l3MaxInclusive);
  const l3: TimelineMacroBlock[] = buildMacroBlocks(l3Events, l3BlockSize);

  return { l1, l2, l3 };
}

// ---------------------------------------------------------------------------
// 转换辅助
// ---------------------------------------------------------------------------

function toLayerEvent(event: TimelineEvent): TimelineLayerEvent {
  return {
    chapter: event.chapter,
    summary: event.summary,
    mainEvent: readMainEvent(event),
    participants: event.participants.length > 0 ? event.participants : undefined,
  };
}

function toLayerEventCompact(event: TimelineEvent): TimelineLayerEvent {
  const sem = readSemanticSummaryLocal(event);
  // mainEvent 截断 ≤120
  const mainEvent =
    sem?.mainEvent && sem.mainEvent.trim().length > 0
      ? sem.mainEvent.slice(0, L2_TRUNCATE)
      : undefined;
  // summary：mainEvent > timelineSummary > summary（截断）
  const summary = (
    mainEvent ??
    (sem?.timelineSummary && sem.timelineSummary.trim().length > 0
      ? sem.timelineSummary.slice(0, L2_TRUNCATE)
      : undefined) ??
    event.summary.slice(0, L2_TRUNCATE)
  );
  return {
    chapter: event.chapter,
    summary,
    mainEvent,
  };
}

/**
 * 将远期事件按 blockSize 章分块，每块产一条 TimelineMacroBlock。
 * 块的 summary = 块内各章 bestSingleLine（mainEvent 优先）用「；」拼接，再截断。
 * 保证早期重要 mainEvent 出现在 summary 里（而不是整块丢弃）。
 */
function buildMacroBlocks(
  events: readonly TimelineEvent[],
  blockSize: number,
): TimelineMacroBlock[] {
  if (events.length === 0) return [];
  const minChapter = events[0].chapter;
  const maxChapter = events[events.length - 1].chapter;
  // 细块区：最后 L3_FINE_BLOCKS 个 blockSize 对齐块
  const lastBlockStart = Math.floor((maxChapter - 1) / blockSize) * blockSize + 1;
  const fineStart = Math.max(Math.floor((minChapter - 1) / blockSize) * blockSize + 1, lastBlockStart - (L3_FINE_BLOCKS - 1) * blockSize);
  const blocks: TimelineMacroBlock[] = [];
  // 粗块区：fineStart 之前的章，分成至多 L3_COARSE_BLOCKS 块（块长是 blockSize 的倍数）
  if (minChapter < fineStart) {
    const coarseFirst = Math.floor((minChapter - 1) / blockSize) * blockSize + 1;
    const span = fineStart - coarseFirst;
    const coarseSize = Math.max(blockSize, Math.ceil(span / L3_COARSE_BLOCKS / blockSize) * blockSize);
    for (let start = coarseFirst; start < fineStart; start += coarseSize) {
      const end = Math.min(start + coarseSize - 1, fineStart - 1);
      const inBlock = events.filter((e) => e.chapter >= start && e.chapter <= end);
      if (inBlock.length === 0) continue;
      blocks.push({ fromChapter: start, toChapter: Math.min(end, maxChapter), summary: sampledSummary(inBlock, coarseSize > blockSize) });
    }
  }
  for (let blockStart = fineStart; blockStart <= maxChapter; blockStart += blockSize) {
    const blockEnd = blockStart + blockSize - 1;
    const blockEvents = events.filter((e) => e.chapter >= blockStart && e.chapter <= blockEnd);
    if (blockEvents.length === 0) continue;
    blocks.push({ fromChapter: blockStart, toChapter: Math.min(blockEnd, maxChapter), summary: sampledSummary(blockEvents, false) });
  }
  return blocks;
}

/**
 * 块摘要：各章 bestSingleLine（mainEvent 优先）用「；」拼接、截到 L3_BLOCK_TRUNCATE。
 * 粗块（跨好几十章）均匀抽几章、每句截到 L3_COARSE_LINE，整块时间都有代表。
 */
function sampledSummary(blockEvents: readonly TimelineEvent[], coarse: boolean): string {
  const lines = blockEvents.map((e) => {
    const line = bestSingleLine(e);
    return line.trim().length > 0 ? line : e.summary;
  });
  let parts = lines;
  if (coarse) {
    const take = Math.max(1, Math.floor(L3_BLOCK_TRUNCATE / (L3_COARSE_LINE + 1)));
    const step = lines.length / take;
    parts = lines.length <= take ? lines : Array.from({ length: take }, (_, index) => lines[Math.floor(index * step)]!);
    parts = parts.map((line) => line.slice(0, L3_COARSE_LINE));
  }
  const joined = parts.join("；");
  return joined.length > L3_BLOCK_TRUNCATE ? joined.slice(0, L3_BLOCK_TRUNCATE) : joined;
}
