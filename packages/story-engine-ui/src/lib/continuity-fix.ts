/**
 * 核账条目「按前文改」的改稿要求：核账卡上的「改这处 / 改掉这 N 处」和出稿流程里的「按核账改」（2026-10-23）说同一句话，
 * 改的都是本章原句、要和前文原句（或设定原文）对上。前后端共用，免得两边说法走样。
 */
export interface ContinuityFixItem {
  readonly quote: string;
  readonly earlierQuote: string;
  readonly earlierChapter: number;
  readonly reason?: string;
  readonly againstSetting?: { readonly label: string };
}

/** 要和哪句对上（本章前面 / 第 N 章 / 设定本某页）+ 核账员的理由。 */
export function continuityFixGoal(chapter: number, item: ContinuityFixItem): string {
  const where = item.againstSetting
    ? `设定本${item.againstSetting.label}`
    : item.earlierChapter === chapter ? "本章前面" : `第 ${item.earlierChapter} 章`;
  return `和${where}「${item.earlierQuote}」对上${item.reason ? `（${item.reason}）` : ""}`;
}
