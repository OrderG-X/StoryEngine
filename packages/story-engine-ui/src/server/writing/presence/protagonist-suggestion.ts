/**
 * 主角建议（重构 P9）：设定本里还没有标主角的人物卡时，按账里记的视角人物给一个候选。
 *
 * 两处用：定稿后的下一步选项、开书概况的「待处理」。都只是建议，作者点了才设（可撤销），这里绝不写盘。
 * 判据全部确定性、题材中立：只看视角章数取最多（设定视图 appearances.viewpointChapters），
 * 一章都没有视角声明就没有候选，不退回数出场。
 */
import type { BibleView, CardOp } from "@actalk/story-core";

export interface ProtagonistSuggestion {
  /** 视角章数最多的人物。 */
  readonly name: string;
  /** 跟着这个人视角走的章数。 */
  readonly viewpointChapters: number;
  /** 已经有人物卡（只差标主角）；false = 账里有、还没建卡。 */
  readonly carded: boolean;
}

export function suggestProtagonist(bible: BibleView): ProtagonistSuggestion | undefined {
  if (bible.protagonist) return undefined;
  const candidates = [
    ...bible.characters.map((entry) => ({ name: entry.card.name, viewpointChapters: entry.appearances?.viewpointChapters ?? 0, carded: true })),
    ...bible.uncarded.filter((entry) => entry.character).map((entry) => ({ name: entry.name, viewpointChapters: entry.appearances?.viewpointChapters ?? 0, carded: false })),
  ].filter((item) => item.viewpointChapters > 0);
  // 同章数取先列出的（人物卡在前，按首次出场排）。
  return candidates.reduce<ProtagonistSuggestion | undefined>((best, item) => (best && best.viewpointChapters >= item.viewpointChapters ? best : item), undefined);
}

/** 采纳建议要做的改动：有卡就标主角，没卡就建一张标了主角的。 */
export function protagonistSuggestionOps(suggestion: ProtagonistSuggestion): CardOp[] {
  return suggestion.carded
    ? [{ op: "card.protagonist", card: suggestion.name }]
    : [{ op: "card.create", kind: "character", name: suggestion.name, protagonist: true }];
}
