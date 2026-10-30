/**
 * 开书概况的界面附加信息（重构 P7 第 6 步从 lib/project-io 挪来）：章节文件状态、编辑部补读进度、主角建议、全书字数。
 * 要读编辑部的补读进度，所以放在流程层（services），基础设施层（lib）不引编辑部。
 */
import type { StateOverview } from "../book/state-overview.js";
import { readReadersCatchUpStatus, type ReadersCatchUpStatus } from "../editorial/catch-up.js";
import { readBible } from "@actalk/story-core";
import { suggestProtagonist, type ProtagonistSuggestion } from "../writing/presence/protagonist-suggestion.js";
import { readUiChapterFileStates, type UiChapterFileState } from "../lib/project-io.js";
import { readWordStats } from "../lib/word-stats.js";


/** 开书概况（界面拿到的那一份）：书概况 + 章节文件状态、补读进度、主角建议、全书字数。 */
export type UiStateOverview = StateOverview & {
  /** 编辑部三个跟读角色的后台补读进度（R4.3）：任一在读才带；导入的书通读记账没记完也带（P8）。 */
  readonly readerCatchUp?: ReadersCatchUpStatus;
  readonly uiChapterFiles?: readonly UiChapterFileState[];
  /** 设定本里还没标主角、账里有视角人物（「待处理」里建议设为主角；导入的书记完账后也有）。 */
  readonly protagonistSuggestion?: ProtagonistSuggestion;
  /** 全书字数（写作统计那一份：每章工作稿优先、没有数定稿）。书架、书的资料都看它，读不到就不带。 */
  readonly totalWords?: number;
};

export async function withUiOverviewDetails(projectDir: string, overview: StateOverview): Promise<UiStateOverview> {
  const [uiChapterFiles, readerCatchUp, protagonistSuggestion, totalWords] = await Promise.all([
    readUiChapterFileStates(projectDir),
    readReadersCatchUpProgress(projectDir),
    readBible(projectDir).then((read) => suggestProtagonist(read.bible)).catch(() => undefined),
    readWordStats(projectDir).then((stats) => stats.totalWords).catch(() => undefined),
  ]);
  return {
    ...overview,
    ...(readerCatchUp ? { readerCatchUp } : {}),
    ...(uiChapterFiles.length ? { uiChapterFiles } : {}),
    ...(protagonistSuggestion ? { protagonistSuggestion } : {}),
    ...(totalWords !== undefined ? { totalWords } : {}),
  };
}

/** 三个跟读角色的补读进度（agents/<角色>/progress.json，形状同 catch-up 的 ReadersCatchUpStatus）：全读完就不带（进度行消失）。
 *  导入的书通读记账停下了也带（P8）：进度行要显示原因和「接着记」。 */
async function readReadersCatchUpProgress(projectDir: string): Promise<ReadersCatchUpStatus | undefined> {
  const status = await readReadersCatchUpStatus(projectDir).catch(() => undefined);
  return status?.reading || status?.reread ? status : undefined;
}
