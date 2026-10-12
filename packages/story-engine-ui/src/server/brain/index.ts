/**
 * 编辑部（brain）对外入口（2026-10-12 第 1 步：专员底座 + 核账员）。
 *
 * 新代码都在 brain/ 下，不 import 旧的 agent/tools、agent/story-agent；以后整块搬进独立包。
 * 现在只有一个专员（核账员）。核账走哪一路由环境变量 STORY_CHECKER 定：reader＝核账员，其余＝旧核账（缺省）。
 */
import { CHECKER_ROLE, callConfiguredBrainModel } from "./checker.js";
import { ensureReaderWindow, type BrainCallModel, type ReaderRole } from "./reader-window.js";

export { CHECKER_ROLE, callConfiguredBrainModel, checkChapterByReader } from "./checker.js";
export { ensureReaderWindow, type BrainCallModel, type BrainMessage, type ReaderRole } from "./reader-window.js";

/** 需要跟读新章节的专员。 */
const READER_ROLES: readonly ReaderRole[] = [CHECKER_ROLE];

/** 环境变量 STORY_CHECKER=reader：核账走核账员，定稿后后台给它补笔记。 */
export function isReaderCheckerEnabled(): boolean {
  return process.env.STORY_CHECKER === "reader";
}

/**
 * 后台给各专员补笔记到第 upTo 章。永不抛错：补不成只 console.warn（下次核账或定稿会接着补），
 * 所以调用方可以放心 `void`。
 */
export async function catchUpReaders(
  projectDir: string,
  upTo: number,
  options: { readonly callModel?: BrainCallModel; readonly notesRoot?: string } = {},
): Promise<void> {
  for (const role of READER_ROLES) {
    try {
      await ensureReaderWindow({
        projectDir,
        role,
        upTo,
        callModel: options.callModel ?? callConfiguredBrainModel,
        ...(options.notesRoot ? { notesRoot: options.notesRoot } : {}),
      });
    } catch (error) {
      console.warn(`[brain] ${role.id} 补读书笔记没成（不影响定稿和核账，下次接着补）`, error);
    }
  }
}

/** 定稿后预热：后台给专员补笔记到刚定稿的这一章。只在 STORY_CHECKER=reader 时干活，不阻塞定稿。 */
export function warmUpReaders(
  projectDir: string,
  chapter: number,
  options: { readonly callModel?: BrainCallModel; readonly notesRoot?: string } = {},
): Promise<void> {
  if (!isReaderCheckerEnabled()) return Promise.resolve();
  return catchUpReaders(projectDir, chapter, options);
}
