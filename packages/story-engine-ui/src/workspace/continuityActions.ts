/**
 * 核账条目上的动作（重构 P6）：对话卡和稿纸划线点的是同一个。
 * 「不是问题」＝记进这张卡（两边一起划掉）+ 存盘（以后核账不再报）；存不上返回 false，调用方如实说没记住。
 */
import { saveContinuityDismissal } from "../api/continuityDismissalsClient.js";
import { useChatStore } from "../stores/chatStore.js";
import { useNavigationStore } from "../stores/navigationStore.js";
import { continuityFixChapter, continuityItemKey, type ContinuityItem } from "./chapterProgress.js";

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
  // 按错所在那章记：前文那章的错在第几章标都一样，以后核哪章都不再报。
  return saveContinuityDismissal(projectPath, {
    chapter: continuityFixChapter(input.chapter, input.item),
    quote: input.item.quote,
    earlierQuote: input.item.earlierQuote,
    ...(input.item.againstSetting ? { againstSetting: true as const } : {}),
    ...(input.item.reason ? { reason: input.item.reason } : {}),
  }, undo);
}
