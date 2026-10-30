/**
 * 老书的天数怎么进账（写作版本 P3a 设计 2.6）：新导入（import/build.ts）和已导入账的盘点（commands/time-audit.ts）同一条规则。
 *
 * 老格式时间线是每章一个绝对天数 + 依据。按章顺序过一遍：
 *  - 依据是作者定的 → 作者定的天数（真裁定，照留）；
 *  - 坏锚 → 不知道，原值进 legacy，不当锚、不进链。坏锚 = 依据是估的；或不是作者定的、却比上一章结尾早（没法判断是倒叙还是记错）；
 *    或（只在盘点时）账里记成作者定的、老文件里不是（伪裁定），或老文件不在了、证明不了的作者天数；
 *  - 紧跟坏锚的下一章：它的差值是相对坏锚算的 → 同样不知道（它自己是作者定的照留）；
 *  - 其余：离上一章结尾几天（差值）。
 */
import type { LegacyTime, TimeBasis } from "../schema/ledger.js";
import type { LegacyTimelineEntry } from "./legacy.js";

/** 老时间线的依据 → 账里的依据（老代码的四种；别的一律当估的）。 */
export const LEGACY_TIME_BASIS: Readonly<Record<string, TimeBasis>> = { author: "author", declared: "text", plan: "judged", fallback: "estimated" };

export interface LegacyTimeRow {
  readonly chapter: number;
  readonly day: number;
  readonly daysInChapter?: number;
  readonly basis: TimeBasis;
  /** 盘点时：账里这章现在记成了作者定的天数（导入当年的）。 */
  readonly storedAsAuthor?: boolean;
}

export type LegacyTimeOutcome =
  | { readonly chapter: number; readonly kind: "at"; readonly day: number; readonly daysInChapter?: number }
  | { readonly chapter: number; readonly kind: "offset"; readonly daysSincePrevious: number; readonly daysInChapter?: number; readonly basis: TimeBasis }
  | { readonly chapter: number; readonly kind: "unknown"; readonly legacy: LegacyTime };

export const legacyTimelineRow = (entry: LegacyTimelineEntry): LegacyTimeRow => ({
  chapter: entry.chapter,
  day: entry.day,
  ...(entry.daysInChapter ? { daysInChapter: entry.daysInChapter } : {}),
  basis: LEGACY_TIME_BASIS[entry.source] ?? "estimated",
});

/** 按章顺序（调用方排好、每章一行）过一遍老时间线。 */
export function legacyTimeOf(rows: readonly LegacyTimeRow[]): LegacyTimeOutcome[] {
  const out: LegacyTimeOutcome[] = [];
  let previousEnd = 0;
  let previousBad = false;
  for (const row of rows) {
    const span = row.daysInChapter ? { daysInChapter: row.daysInChapter } : {};
    const unknown = (reason: LegacyTime["reason"]): LegacyTimeOutcome => ({
      chapter: row.chapter,
      kind: "unknown",
      legacy: { relation: "at", day: row.day, basis: row.basis, reason },
    });
    let outcome: LegacyTimeOutcome;
    let bad = false;
    const gap = row.day - previousEnd;
    if (row.basis === "author") {
      outcome = { chapter: row.chapter, kind: "at", day: row.day, ...span };
    } else if (row.storedAsAuthor) {
      outcome = unknown("not_author");
      bad = true;
    } else if (row.basis === "estimated") {
      outcome = unknown("estimated");
      bad = true;
    } else if (gap < 0) {
      outcome = unknown("earlier");
      bad = true;
    } else if (previousBad) {
      outcome = unknown("after_bad");
    } else {
      outcome = { chapter: row.chapter, kind: "offset", daysSincePrevious: gap, basis: row.basis, ...span };
    }
    out.push(outcome);
    previousBad = bad;
    previousEnd = row.day + (row.daysInChapter ?? 0);
  }
  return out;
}
