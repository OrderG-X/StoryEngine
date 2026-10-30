/**
 * 故事时间出字（写作版本 P3a 设计第 6 节）：全书一个口径——`第 5 天` / `第 5～6 天` / `第 5 天以后` / `不知道`；
 * 段说「回忆（约三年前）」「梦里」。界面、对话 AI、核账员、写手的材料都用这里，不各写各的。
 */
import type { BoundaryOffsets, TimeOffset } from "../schema/ledger.js";
import type { DayRange, SegmentView } from "./time.js";

/** 第几天（第一个当下章的开头 = 第 1 天；更早的多线往回接说「第 1 天之前 N 天」）。 */
export function dayLabel(day: number): string {
  return day >= 1 ? `第 ${day} 天` : `第 1 天之前 ${1 - day} 天`;
}

/** 绝对天数区间。 */
export function daysText(range: DayRange | undefined): string {
  if (!range || (range.lo === undefined && range.hi === undefined)) return "不知道";
  const { lo, hi } = range;
  if (lo !== undefined && hi !== undefined) {
    if (lo === hi) return dayLabel(lo);
    return lo >= 1 ? `第 ${lo}～${hi} 天` : `${dayLabel(lo)}～${dayLabel(hi)}`;
  }
  return lo !== undefined ? `${dayLabel(lo)}以后` : `${dayLabel(hi as number)}以前`;
}

/** 相对天数（离前一个当下章结尾 / 本章开头）。 */
export function relativeDaysText(range: DayRange | undefined): string {
  if (!range || (range.lo === undefined && range.hi === undefined)) return "不知道";
  const { lo, hi } = range;
  if (lo !== undefined && hi !== undefined && lo === hi) return lo === 0 ? "同一天" : lo > 0 ? `过了 ${lo} 天` : `往回 ${-lo} 天`;
  if (lo !== undefined && hi !== undefined) return lo >= 0 ? `过了 ${lo}～${hi} 天` : hi <= 0 ? `往回 ${-hi}～${-lo} 天` : `往回 ${-lo} 天到过了 ${hi} 天之间`;
  if (lo !== undefined) return lo >= 0 ? `至少过了 ${lo} 天` : `最多往回 ${-lo} 天`;
  return (hi as number) <= 0 ? `至少往回 ${-(hi as number)} 天` : `最多过了 ${hi} 天`;
}

const UNIT_LABELS: Record<TimeOffset["unit"], string> = { day: "天", month: "个月", year: "年" };

/** 一处相对的原样说法（月 / 年不折天）：「6 个月后」「至少 3 年前」「1～2 天后」。 */
export function offsetText(offset: TimeOffset): string {
  const unit = UNIT_LABELS[offset.unit];
  const { min, max } = offset;
  if (min !== undefined && max !== undefined) {
    if (min === max) return min === 0 ? "同一时候" : min > 0 ? `${min} ${unit}后` : `${-min} ${unit}前`;
    if (min >= 0) return `${min}～${max} ${unit}后`;
    if (max <= 0) return `${-max}～${-min} ${unit}前`;
    return `前后 ${Math.max(-min, max)} ${unit}之内`;
  }
  if (min !== undefined) return min >= 0 ? `至少 ${min} ${unit}后` : `最多 ${-min} ${unit}前`;
  return (max as number) <= 0 ? `至少 ${-(max as number)} ${unit}前` : `最多 ${max} ${unit}后`;
}

/** 按换天规矩各记了一份的：两份一样只说一次，不一样两种都说。 */
export function boundaryText(byBoundary: BoundaryOffsets): string {
  const midnight = offsetText(byBoundary.midnight);
  const dawn = offsetText(byBoundary.dawn);
  return midnight === dawn ? midnight : `过了半夜算第二天的话${midnight}，天亮才算的话${dawn}`;
}

/** 一个段：「回忆（3 年前）」「梦、想象或传闻」。 */
export function segmentText(segment: Pick<SegmentView, "frame" | "when">): string {
  if (segment.frame === "other") return "梦、想象或传闻";
  if (!segment.when || segment.when === "unknown") return "回忆";
  const when = segment.when.offset ? offsetText(segment.when.offset) : segment.when.byBoundary ? boundaryText(segment.when.byBoundary) : undefined;
  return when ? `回忆（${when}）` : "回忆";
}
