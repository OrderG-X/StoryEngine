/**
 * 主角卡还是开书占位（建书模板固定名，如「主角」）时，按已定稿章节声明的视角人物给一个真名候选。
 *
 * 两处用：定稿后的下一步选项（agent/protagonist-rename-suggestion）、开书概况的「待处理」（导入的书记完账后
 * 也能看到，P8）。都只是建议，作者点了才由模型走 foundation_write 改名，这里绝不写盘。
 *
 * 判据全部确定性、题材中立：占位按建书模板固定标记（isPlaceholderCharacterName，不按名字猜）；
 * 候选只看视角人物取最多（readViewpointChapterCounts），一章都没有视角声明就没有候选，不退回数出场。
 */
import { isPlaceholderCharacterName, readCharacterBible } from "../../book/project-store.js";
import type { CharacterBibleEntry } from "../../book/types.js";
import { readViewpointChapterCounts } from "./delta-present-names.js";

export interface PlaceholderProtagonist {
  /** 主角卡现在的名字（占位名）。 */
  readonly placeholderName: string;
  /** 视角章数最多的人物。 */
  readonly suggestedName: string;
  /** 跟着他视角走的章数。 */
  readonly viewpointChapters: number;
}

/** 主角判定：与在场检测（in-scene-detector）同语义——isMainCharacter/role=protagonist/role 含「主角」。 */
function isProtagonistEntry(character: CharacterBibleEntry): boolean {
  if ((character as { readonly isMainCharacter?: unknown }).isMainCharacter === true) return true;
  const role = typeof character.role === "string" ? character.role : undefined;
  return role === "protagonist" || (role?.includes("主角") ?? false);
}

/** beforeChapter 之前（不含）已定稿的章里找；不是占位、没有视角声明、读盘失败都返回 undefined。 */
export async function readPlaceholderProtagonist(projectDir: string, beforeChapter: number): Promise<PlaceholderProtagonist | undefined> {
  const bible = await readCharacterBible(projectDir).catch(() => null);
  const characters = bible?.characters ?? [];
  const protagonist = characters.find(isProtagonistEntry) ?? characters[0];
  const placeholderName = protagonist?.name?.trim() ?? "";
  if (!placeholderName || !isPlaceholderCharacterName(placeholderName)) return undefined;
  const top = (await readViewpointChapterCounts(projectDir, beforeChapter).catch(() => []))[0];
  if (!top || top.chapters < 1) return undefined;
  return { placeholderName, suggestedName: top.name, viewpointChapters: top.chapters };
}
