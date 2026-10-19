/**
 * protagonist-rename-suggestion — 定稿后的「占位主角卡改名」建议（编辑部 R4.6 建议项，2026-10-13）。
 *
 * 场景：UI 新建的书只有一张开书占位卡「主角」（建书模板固定名），作者手写章节不会建卡。第 1 章定稿后，
 * 记账员声明的 charactersPresent 里已有真实人名——这时在「确认定稿」的下一步选项里给一个
 * 「把主角卡改成『X』」。**只是建议**：作者点了才把这句话发给模型，由模型走 foundation_write 改名
 * （引擎对「给占位主角起真名」是确定性认领改名场景，foundation-write-gateway 占位改名），绝不在
 * 本建议里直接写盘。
 *
 * 判据全部确定性、题材中立：主角卡是否占位按建书模板固定标记（isPlaceholderCharacterName，不按名字猜）；
 * 人名只看已定稿章节声明的**视角人物**（时间线 semanticSummary.viewpointCharacter，R5.1 起）取最多——
 * 不再数出场次数（第 1 章视角是林小满、宋伯名字出现再多，也是建议林小满）。
 * 一章都没有视角声明就不给建议，绝不退回数出场次数（老书老数据没有这字段就没有建议）。
 */
import { readPlaceholderProtagonist } from "../writing/presence/protagonist-placeholder.js";

export interface ProtagonistRenameSuggestion {
  readonly label: string;
  readonly intent: string;
}

/**
 * 定稿（committedChapter 已入库）后：主角卡还是开书占位、已定稿章节声明的视角人物里取出现最多的真名
 * → 给改名建议；一章都没有视角声明 → undefined（没有依据就不建议，不退回数出场）。
 * 读盘失败按「没有建议」处理（绝不因为建议挂掉定稿收尾；调用方另有 catch 兜底）。
 */
export async function buildProtagonistRenameSuggestion(
  projectDir: string,
  committedChapter: number,
): Promise<ProtagonistRenameSuggestion | undefined> {
  const found = await readPlaceholderProtagonist(projectDir, committedChapter + 1);
  if (!found) return undefined;
  return {
    label: `把主角卡改成『${found.suggestedName}』`,
    intent: `把开书占位的主角卡（现在的名字是「${found.placeholderName}」）改名为「${found.suggestedName}」——这是已定稿章节的视角人物（${found.viewpointChapters} 章都是跟着${found.suggestedName}的眼睛走）。只改名字，别的不动。`,
  };
}
