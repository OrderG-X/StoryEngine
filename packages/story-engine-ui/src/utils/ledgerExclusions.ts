/**
 * 定稿预览卡上作者勾掉的账本条目（2026-10-10「AI 记账、作者核账」）。
 *
 * 放在模块里而不是卡片组件状态里：回合收尾时消息列表重建、卡片重新挂载，组件状态会悄悄丢；
 * 而且「确认定稿」有两个入口（预览卡上的按钮、输入框上方建议条的按钮），两个都得带上作者勾掉的条目，
 * 否则从建议条点会把作者去掉的照写进账本。按章记最近一次勾选和它属于哪张预览（令牌）。
 */
interface Entry {
  readonly previewToken: string;
  readonly removed: ReadonlySet<string>;
}

const byChapter = new Map<number, Entry>();

export function rememberLedgerExclusions(chapter: number, previewToken: string | undefined, removed: ReadonlySet<string>): void {
  byChapter.set(chapter, { previewToken: previewToken ?? "", removed });
}

/** 这张预览卡此前勾掉的条目（卡片重挂载时恢复用）；不是同一张预览就当没勾过。 */
export function ledgerExclusionsForCard(chapter: number, previewToken: string | undefined): ReadonlySet<string> {
  const entry = byChapter.get(chapter);
  return entry && entry.previewToken === (previewToken ?? "") ? entry.removed : new Set();
}

/**
 * 点「确认定稿」时该带上的勾掉条目：按钮带了令牌就只认同一张预览的；没带令牌（服务端用最近一次预览）就用这一章最近的勾选。
 * 事实条目的 id 是内容哈希，伏笔线索目标是标题哈希——就算对不上最新预览，也只会去掉作者看到并勾掉的那几句。
 */
export function ledgerExclusionsForConfirm(chapter: number, previewToken: string | undefined): readonly string[] {
  const entry = byChapter.get(chapter);
  if (!entry) return [];
  if (previewToken && entry.previewToken && previewToken !== entry.previewToken) return [];
  return [...entry.removed];
}

/** 定稿发出后清掉（免得下一版草稿的预览沿用）。 */
export function clearLedgerExclusions(chapter: number): void {
  byChapter.delete(chapter);
}
