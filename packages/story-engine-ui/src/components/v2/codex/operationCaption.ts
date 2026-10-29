/** 消息上那张进行中的卡（老版本不走对话的操作挂的 running 卡；会话里还留着的照实显示「没做完」）。 */
export function runningAgentCard<T extends { readonly status?: string; readonly title?: string; readonly summary?: string }>(
  cards: readonly T[] | undefined,
): T | null {
  return cards?.find((card) => card.status === "running") ?? null;
}
