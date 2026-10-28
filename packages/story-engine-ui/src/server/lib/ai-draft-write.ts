/**
 * AI 写工作稿的唯一通道（重构 P7 第 3 步）：出稿、补写、去 AI 味、改稿、选候选落盘，全走核心的 draft.write 命令
 * （书锁 + 事务落盘，进程被杀不留半截稿）。服务端别处不再自己拼工作稿文件、不再裸写 drafts/。
 *
 * 存档点由调用方先打：它们要带操作名（「第 3 章修订前快照」）、要把存档点 id 回给对话撤销，所以这里不再让命令另打一个。
 * 要「存档点 + 写稿」不被撤销、定稿切进中间，调用方把两步一起放进 withBookLock（锁可重入，这里再拿一次直接进）。
 *
 * 每次写都要说清是拿哪一版改的（baseVersion）：模型跑着的几十秒到几分钟里作者存了稿、撤销或恢复过，
 * 盘上那份就不再是这一版，这次不写、如实报（外部审查 2026-10-28：补写落盘把作者刚存的句子盖掉了）。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { draftPath, draftWrite, runCommand, withBookLock } from "@actalk/story-core";
import { chapterWordsNow, recordChapterWords } from "./word-stats.js";
import { TURN_ABORTED_MESSAGE, turnAborted } from "./turn-abort.js";

export class AiDraftWriteError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AiDraftWriteError";
  }
}

export interface AiDraftWriteInput {
  readonly chapter: number;
  /** 正文。开头已经是「# 标题」行时整份照写，标题不另加。 */
  readonly body: string;
  /** 不给就沿用盘上原来的标题。 */
  readonly title?: string;
  /**
   * 这次改的是哪一版（读稿时的 version；这一章原来没有工作稿就是 null）。盘上已经不是这一版就不写，抛 draft_conflict。
   * "overwrite" 只给作者自己点了要换掉整稿的（选用候选稿）：不比版本。
   */
  readonly baseVersion: string | null | "overwrite";
}

export const DRAFT_CONFLICT = "draft_conflict";

export function isDraftConflict(error: unknown): boolean {
  return error instanceof AiDraftWriteError && error.code === DRAFT_CONFLICT;
}

export interface AiDraftWriteResult {
  /** 工作稿文件的绝对路径。 */
  readonly path: string;
  /** 盘上现在的整份文件（带标题行），回给界面就用它。 */
  readonly content: string;
  readonly version: string;
  /** 盘上原来就是这一版，这次没写。 */
  readonly unchanged: boolean;
}

export async function writeAiDraft(projectDir: string, input: AiDraftWriteInput): Promise<AiDraftWriteResult> {
  const title = input.title?.trim();
  const path = join(projectDir, draftPath(input.chapter));
  // 写和回读在同一把锁里：回给界面的就是这次写下的那份。
  return withBookLock(projectDir, async () => {
    // 作者喊停之后后到的稿不落盘（锁里再问一次：等锁的工夫也可能停了）。
    if (turnAborted()) throw new AiDraftWriteError("turn_aborted", TURN_ABORTED_MESSAGE);
    // 写作统计：写之前量一下这章多少字，写完按差值记成 AI 写的。
    const wordsBefore = await chapterWordsNow(projectDir, input.chapter).catch(() => undefined);
    const outcome = await runCommand(projectDir, draftWrite, {
      chapter: input.chapter,
      body: input.body,
      ...(title ? { title } : {}),
      ...(input.baseVersion === "overwrite" ? {} : { baseVersion: input.baseVersion }),
    }, { caller: "ai" });
    if (!outcome.ok && outcome.code === DRAFT_CONFLICT) {
      throw new AiDraftWriteError(DRAFT_CONFLICT, `第 ${input.chapter} 章的工作稿在这期间被改过（存稿、撤销或恢复），AI 这次改的没写进去，盘上那份没动。`);
    }
    if (!outcome.ok) throw new AiDraftWriteError(outcome.code, outcome.message);
    if (!outcome.result.unchanged) await recordChapterWords(projectDir, input.chapter, "ai", wordsBefore);
    const content = await readFile(path, "utf-8");
    return { path, content, version: outcome.result.version, unchanged: outcome.result.unchanged };
  });
}
