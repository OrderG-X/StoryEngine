/**
 * 定稿后的「设为主角」建议（重构 P9 起：设定本里没有标主角时，按视角人物建议）。
 * **只是建议**：作者点了才把这句话发给模型，由模型走 change_settings 设（可撤销），绝不在这里写盘。
 */
import { readBible } from "@actalk/story-core";
import { suggestProtagonist } from "../writing/presence/protagonist-suggestion.js";

export interface ProtagonistRenameSuggestion {
  readonly label: string;
  readonly intent: string;
}

/** 读盘失败按「没有建议」处理（调用方另有 catch 兜底）。 */
export async function buildProtagonistRenameSuggestion(projectDir: string): Promise<ProtagonistRenameSuggestion | undefined> {
  const found = suggestProtagonist((await readBible(projectDir)).bible);
  if (!found) return undefined;
  return {
    label: `把『${found.name}』设为主角`,
    intent: found.carded
      ? `把人物卡「${found.name}」标成主角——已定稿的 ${found.viewpointChapters} 章都是跟着${found.name}的眼睛走的。只标主角，别的不动。`
      : `给「${found.name}」建一张人物卡并标成主角——已定稿的 ${found.viewpointChapters} 章都是跟着${found.name}的眼睛走的。只建卡、标主角，别的先不填。`,
  };
}
