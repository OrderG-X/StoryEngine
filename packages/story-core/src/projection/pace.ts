/**
 * 节奏诊断：哪几章可能拖、哪几章可能赶。纯函数，只读投影；字数由调用方数好传进来（和书架、写作台同一口径）。
 *
 * 只看账里记的结构和数字，不读正文、不猜意思：
 *  - 推进密度 = 每千字推进了几条线索（收一条算两条，开新线索不算推进）。拿全书自己的中位数当「平常」，不设死标准。
 *  - 可能拖：推进密度不到平常的 0.4，故事时间也没怎么走（≤ 2 天）；挨着的几章并成一段。
 *  - 可能赶：推进密度是平常的 2.5 倍以上、且推进得不少（≥ 5）；或一章里跨了 5 天以上、字数却不到平常的 0.75。
 * 定稿不到 6 章（能算密度的）不下结论。结论只是「可能」，原因带数字，作者自己判断。
 */
import type { BookProjection } from "./types.js";

/** 能算推进密度的章少于这个数，不下结论。 */
export const PACE_MIN_CHAPTERS = 6;
/** 推进密度不到平常的几成算慢。 */
export const PACE_SLOW_RATIO = 0.4;
/** 推进密度是平常的几倍算密。 */
export const PACE_FAST_RATIO = 2.5;
/** 算密还要推进得够多（收一条算两条），免得短章推一两条就被说赶。 */
export const PACE_FAST_MIN_MOVES = 5;
/** 一章里跨了几天以上、字又少，算赶。 */
export const PACE_SPAN_DAYS = 5;
/** 「字少」= 不到全书章字数中位数的几成。 */
export const PACE_SPAN_WORDS_RATIO = 0.75;
/** 慢的章故事时间最多走几天（时间跳得远的不算拖）。 */
const PACE_SLOW_MAX_DAYS = 2;
/** 字数太少的章（残章、占位）不算密度。 */
const PACE_MIN_WORDS = 300;

export interface PaceChapter {
  readonly chapter: number;
  readonly words: number;
  readonly opened: number;
  readonly advanced: number;
  readonly closed: number;
  /** 每千字推进几条（收一条算两条）；字太少、或前面没有开着的线索可推时没有。 */
  readonly density?: number;
  /** 这章开头到结尾跨了几天。 */
  readonly span: number;
  /** 从上一章结尾到这章结尾，故事走了几天（第一章 = 本章跨的天数）。 */
  readonly storyDays: number;
  /** 天数是正文写明 / 判断 / 作者定的（估的、没记的不算准）。 */
  readonly timeSure: boolean;
  readonly pace?: "slow" | "fast";
}

export interface PaceFlag {
  readonly kind: "drag" | "rush";
  /** slow = 推进稀（拖）；dense = 推进密（赶）；span = 一章跨好多天、字却少（赶）。 */
  readonly reason: "slow" | "dense" | "span";
  readonly from: number;
  readonly to: number;
  /** 这一段合计。 */
  readonly words: number;
  readonly advanced: number;
  readonly closed: number;
  /** reason = span：那章跨了几天。 */
  readonly span?: number;
}

export interface PaceReport {
  readonly chapters: readonly PaceChapter[];
  readonly flags: readonly PaceFlag[];
  /** 全书平常的推进密度、章字数（中位数）；能算的章太少时没有，也不出结论。 */
  readonly typical?: { readonly density: number; readonly words: number };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** 挨着的同类章并成一段。 */
function groupRuns<T extends { readonly chapter: number }>(items: readonly T[]): T[][] {
  const runs: T[][] = [];
  for (const item of items) {
    const run = runs.at(-1);
    if (run && run.at(-1)!.chapter + 1 === item.chapter) run.push(item);
    else runs.push([item]);
  }
  return runs;
}

function flagOf(kind: PaceFlag["kind"], reason: PaceFlag["reason"], run: readonly PaceChapter[]): PaceFlag {
  return {
    kind,
    reason,
    from: run[0]!.chapter,
    to: run.at(-1)!.chapter,
    words: run.reduce((sum, item) => sum + item.words, 0),
    advanced: run.reduce((sum, item) => sum + item.advanced, 0),
    closed: run.reduce((sum, item) => sum + item.closed, 0),
    ...(reason === "span" ? { span: run[0]!.span } : {}),
  };
}

/** words：章号 → 定稿正文字数；没给的章当 0。 */
export function paceReport(projection: Pick<BookProjection, "chapters" | "threads">, words: ReadonlyMap<number, number>): PaceReport {
  const moves = new Map<number, { opened: number; advanced: number; closed: number }>();
  for (const thread of projection.threads) {
    for (const touch of thread.touches) {
      const row = moves.get(touch.chapter) ?? { opened: 0, advanced: 0, closed: 0 };
      if (touch.op === "open") row.opened += 1;
      else if (touch.op === "advance") row.advanced += 1;
      else row.closed += 1;
      moves.set(touch.chapter, row);
    }
  }
  // 这章之前开着的线索有几条：一条都没有（开头那章）就没什么可推，不算密度。
  const openBefore = (chapter: number): number => projection.threads.filter((thread) =>
    thread.openedAt < chapter && !(thread.closedAt !== undefined && thread.closedAt < chapter)).length;

  const base = projection.chapters.map((view, index) => {
    const previous = projection.chapters[index - 1];
    const count = words.get(view.chapter) ?? 0;
    const row = moves.get(view.chapter) ?? { opened: 0, advanced: 0, closed: 0 };
    const weighted = row.advanced + row.closed * 2;
    const density = count >= PACE_MIN_WORDS && openBefore(view.chapter) > 0 ? weighted / (count / 1000) : undefined;
    return {
      chapter: view.chapter,
      words: count,
      ...row,
      ...(density !== undefined ? { density } : {}),
      span: view.dayEnd - view.day,
      storyDays: previous ? view.dayEnd - previous.dayEnd : view.dayEnd - view.day,
      timeSure: view.dayBasis !== "estimated" && view.dayBasis !== "missing",
      weighted,
    };
  });

  const densities = base.flatMap((item) => (item.density !== undefined ? [item.density] : []));
  const typicalDensity = densities.length >= PACE_MIN_CHAPTERS ? median(densities) : 0;
  if (typicalDensity <= 0) {
    return { chapters: base.map(({ weighted: _weighted, ...item }) => item), flags: [] };
  }
  const typicalWords = median(base.filter((item) => item.words >= PACE_MIN_WORDS).map((item) => item.words));

  const judged = base.map(({ weighted, ...item }) => ({
    item,
    slow: item.density !== undefined
      && item.density <= typicalDensity * PACE_SLOW_RATIO
      && item.storyDays <= PACE_SLOW_MAX_DAYS,
    dense: item.density !== undefined
      && item.density >= typicalDensity * PACE_FAST_RATIO
      && weighted >= PACE_FAST_MIN_MOVES,
    span: item.timeSure
      && item.words >= PACE_MIN_WORDS
      && item.span >= PACE_SPAN_DAYS
      && item.words < typicalWords * PACE_SPAN_WORDS_RATIO,
  }));
  // 慢要故事时间走得少（≤ 2 天），跨天要一章跨 5 天以上：同一章不会又拖又赶。
  const chapters: PaceChapter[] = judged.map(({ item, slow, dense, span }) =>
    slow ? { ...item, pace: "slow" as const } : dense || span ? { ...item, pace: "fast" as const } : item);
  const pick = (key: "slow" | "dense" | "span"): PaceChapter[] => judged.flatMap((row, index) => (row[key] ? [chapters[index]!] : []));

  const flags: PaceFlag[] = [
    ...groupRuns(pick("slow")).map((run) => flagOf("drag", "slow", run)),
    ...groupRuns(pick("dense")).map((run) => flagOf("rush", "dense", run)),
    ...pick("span").map((item) => flagOf("rush", "span", [item])),
  ].sort((a, b) => a.from - b.from || a.reason.localeCompare(b.reason));

  return { chapters, flags, typical: { density: typicalDensity, words: typicalWords } };
}
