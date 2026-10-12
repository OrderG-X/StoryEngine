/**
 * protagonist-rename-suggestion — 定稿后的「占位主角卡改名」建议（编辑部 R4.6 建议项，2026-10-13）。
 *
 * 场景：UI 新建的书只有一张开书占位卡「主角」（建书模板固定名），作者手写章节不会建卡。第 1 章定稿后，
 * 记账员声明的 charactersPresent 里已有真实人名——这时在「确认定稿」的下一步选项里给一个
 * 「把主角卡改成『X』」。**只是建议**：作者点了才把这句话发给模型，由模型走 foundation_write 改名
 * （引擎对「给占位主角起真名」是确定性认领改名场景，foundation-write-gateway 占位改名），绝不在
 * 本建议里直接写盘。
 *
 * 判据全部确定性、题材中立：主角卡是否占位按建书模板固定标记（PLACEHOLDER_CHARACTER_NAME，不按名字猜）；
 * 人名按已定稿声明（时间线 presentCharacterNames）的出场章数取最多。
 */
import { readCharacterBible, PLACEHOLDER_CHARACTER_NAME, type CharacterBibleEntry } from "@actalk/story-engine";

import { readPresentNameChapterCounts } from "./presence/delta-present-names.js";

/** 主角判定：与在场检测（in-scene-detector）同语义——isMainCharacter/role=protagonist/role 含「主角」。 */
function isProtagonistEntry(character: CharacterBibleEntry): boolean {
  if ((character as { readonly isMainCharacter?: unknown }).isMainCharacter === true) return true;
  const role = typeof character.role === "string" ? character.role : undefined;
  return role === "protagonist" || (role?.includes("主角") ?? false);
}

export interface ProtagonistRenameSuggestion {
  readonly label: string;
  readonly intent: string;
}

/**
 * 定稿（committedChapter 已入库）后：主角卡还是开书占位、已定稿声明里有出场最多的真名 → 给改名建议；
 * 否则 undefined。读盘失败按「没有建议」处理（绝不因为建议挂掉定稿收尾；调用方另有 catch 兜底）。
 */
export async function buildProtagonistRenameSuggestion(
  projectDir: string,
  committedChapter: number,
): Promise<ProtagonistRenameSuggestion | undefined> {
  const bible = await readCharacterBible(projectDir).catch(() => null);
  const protagonist = (bible?.characters ?? []).find(isProtagonistEntry) ?? (bible?.characters ?? [])[0];
  const placeholderName = protagonist?.name?.trim() ?? "";
  if (!placeholderName || !PLACEHOLDER_CHARACTER_NAME.test(placeholderName)) return undefined;

  const ranked = await readPresentNameChapterCounts(projectDir, committedChapter + 1);
  const top = ranked[0];
  if (!top || top.chapters < 1) return undefined;

  return {
    label: `把主角卡改成『${top.name}』`,
    intent: `把开书占位的主角卡（现在的名字是「${placeholderName}」）改名为「${top.name}」——这是已定稿章节里出场最多的名字。只改名字，别的不动。`,
  };
}
