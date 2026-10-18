/**
 * 「正文」页签空态文案（P0-2）——有工作稿时别吓人说「暂无正式正文」。
 */
export function committedEmptyTitle(): string {
  return "本章还没有定稿版";
}

export function committedEmptySubtitle(draftWordCount: number): string {
  const n = Number.isFinite(draftWordCount) ? Math.max(0, Math.floor(draftWordCount)) : 0;
  if (n > 0) {
    return `你的工作稿还在（${n} 字），定稿后这里会显示定稿版本。`;
  }
  return "你的工作稿还在，定稿后这里会显示定稿版本。";
}
