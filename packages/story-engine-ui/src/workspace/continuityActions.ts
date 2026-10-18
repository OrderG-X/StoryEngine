/**
 * 核账条目上的动作（重构 P6）：对话卡和稿纸划线点的是同一个。
 * 「不是问题」＝记进这张卡（两边一起划掉）+ 存盘（下次核这一章不再报）；存不上返回 false，调用方如实说没记住。
 */
import { saveContinuityDismissal } from "../api/continuityDismissalsClient.js";
import { useChatStore } from "../stores/chatStore.js";
import { useNavigationStore } from "../stores/navigationStore.js";
import { continuityItemKey, type ContinuityItem } from "./chapterProgress.js";

export async function dismissContinuityItem(input: {
  readonly messageId: string;
  readonly chapter: number;
  readonly item: ContinuityItem;
  readonly undo?: boolean;
}): Promise<boolean> {
  const undo = input.undo === true;
  useChatStore.getState().setContinuityDismissed(input.messageId, continuityItemKey(input.item), !undo);
  const projectPath = useNavigationStore.getState().projectPath;
  if (!projectPath) return false;
  return saveContinuityDismissal(projectPath, {
    chapter: input.chapter,
    quote: input.item.quote,
    earlierQuote: input.item.earlierQuote,
    ...(input.item.reason ? { reason: input.item.reason } : {}),
  }, undo);
}
