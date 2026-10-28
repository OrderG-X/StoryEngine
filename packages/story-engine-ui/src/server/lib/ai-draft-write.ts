/**
 * AI 写工作稿的唯一通道（写作版本 P1b）：出稿、接着写、去 AI 味、改这处、改稿，全走这里，再走核心的
 * draft.applyGenerated 命令（书锁 + 事务落盘，进程被杀不留半截稿）。服务端别处不再自己拼工作稿文件、不再裸写 drafts/。
 *
 * 规矩：AI 写的稿只在两样都对得上时换上——
 *  - 工作稿还是开工时那一版（baseVersion）：模型跑着的几十秒到几分钟里作者存了稿、撤销或恢复过，就不换；
 *  - 书还是开工时那样（开工时读的真相依据）：前文、设定、作者裁定改过，这版是照旧的写的，也不换。
 * 不换的那份存成候选（draft-candidates.ts），如实告诉作者，稿纸上可以「换成 AI 这版」。白跑的几分钟不丢，作者那份也不被盖掉。
 *
 * 存档点在换上前、同一把书锁里打（真要写才打）：撤销、定稿切不进中间，没换上的不在操作历史里多出一条。
 * 调用方不要把模型调用放进书锁：作者存稿会被卡住。同一章的 AI 改稿要排队的，用 oneAiWriterPerChapter。
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { draftApplyGenerated, draftPath, readTruthBasis, runCommand, withBookLock, type TruthBasis } from "@actalk/story-core";
import { clearDraftCandidates, removeDraftCandidate, saveDraftCandidate, type DraftCandidateSource, type DraftKeptReason } from "./draft-candidates.js";
import { runWithLazySnapshot } from "./snapshot.js";
import { chapterWordsNow, recordChapterWords } from "./word-stats.js";
import { TURN_ABORTED_MESSAGE, turnAborted } from "./turn-abort.js";

export class AiDraftWriteError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AiDraftWriteError";
  }
}

export interface AiDraftInput {
  readonly chapter: number;
  /** 正文。开头已经是「# 标题」行时整份照写，标题不另加。 */
  readonly body: string;
  /** 不给就沿用盘上原来的标题。 */
  readonly title?: string;
  /** 开工时读的工作稿版本（这一章原来没有工作稿就是 null）。 */
  readonly baseVersion: string | null;
  /** 开工时读的真相依据（先读它，再读写稿要用的材料）。 */
  readonly basis: TruthBasis;
  readonly source: DraftCandidateSource;
  /** 换上前打的存档点叫什么（操作历史里看的）；不给用核心的「AI 写稿：第 N 章」。 */
  readonly snapshotLabel?: string;
  /** 开写时已经存下的那份候选（出稿流程）：换上了删掉，没换上就是它。 */
  readonly candidateId?: string;
}

export type AiDraftOutcome =
  | {
    readonly applied: true;
    /** 工作稿文件的绝对路径。 */
    readonly path: string;
    /** 盘上现在的整份文件（带标题行），回给界面就用它。 */
    readonly content: string;
    readonly version: string;
    /** 盘上原来就是这一版，这次没写。 */
    readonly unchanged: boolean;
    readonly snapshotId?: string;
  }
  | {
    readonly applied: false;
    readonly reason: Exclude<DraftKeptReason, "interrupted">;
    readonly candidateId: string;
    /** 给作者看的一句：为什么没换上、这版在哪。 */
    readonly message: string;
  };

/** 没换上时给作者看的一句。 */
export function keptMessage(chapter: number, reason: DraftKeptReason): string {
  const why = reason === "basis_moved" ? "写的途中前文或设定改过" : reason === "interrupted" ? "写到一半停了" : "写的途中这一章的稿子改过（存稿、撤销或恢复）";
  return `第 ${chapter} 章 AI 这版没换上：${why}，你那份没动。AI 这版留着，稿纸上可以换成它。`;
}

export async function applyAiDraft(projectDir: string, input: AiDraftInput): Promise<AiDraftOutcome> {
  const title = input.title?.trim();
  const path = join(projectDir, draftPath(input.chapter));
  const keep = async (reason: Exclude<DraftKeptReason, "interrupted">): Promise<AiDraftOutcome> => {
    const candidate = await saveDraftCandidate(projectDir, {
      chapter: input.chapter,
      ...(title ? { title } : {}),
      body: input.body,
      baseVersion: input.baseVersion,
      basisDigest: input.basis.digest,
      source: input.source,
      status: "ready",
      reason,
      ...(input.candidateId ? { id: input.candidateId } : {}),
    });
    return { applied: false, reason, candidateId: candidate.id, message: keptMessage(input.chapter, reason) };
  };
  return withBookLock(projectDir, async () => {
    // 作者喊停之后后到的稿不落盘，也不留候选（锁里再问一次：等锁的工夫也可能停了）。
    if (turnAborted()) {
      if (input.candidateId) await removeDraftCandidate(projectDir, input.candidateId);
      throw new AiDraftWriteError("turn_aborted", TURN_ABORTED_MESSAGE);
    }
    if ((await readTruthBasis(projectDir)).digest !== input.basis.digest) return keep("basis_moved");
    // 写作统计：写之前量一下这章多少字，写完按差值记成 AI 写的。
    const wordsBefore = await chapterWordsNow(projectDir, input.chapter).catch(() => undefined);
    const { snapshotId, result: outcome } = await runWithLazySnapshot(projectDir, (snapshot) =>
      runCommand(projectDir, draftApplyGenerated, {
        chapter: input.chapter,
        body: input.body,
        ...(title ? { title } : {}),
        baseVersion: input.baseVersion,
      }, { caller: "ai", snapshot }), input.snapshotLabel);
    if (!outcome.ok && outcome.code === "draft_conflict") return keep("draft_moved");
    if (!outcome.ok) throw new AiDraftWriteError(outcome.code, outcome.message);
    // 换上了：这一章更早没换上的候选都是照更早的稿写的，一起清掉。
    await clearDraftCandidates(projectDir, input.chapter);
    if (input.candidateId) await removeDraftCandidate(projectDir, input.candidateId);
    if (!outcome.result.unchanged) await recordChapterWords(projectDir, input.chapter, "ai", wordsBefore);
    const content = await readFile(path, "utf-8");
    return { applied: true, path, content, version: outcome.result.version, unchanged: outcome.result.unchanged, ...(snapshotId ? { snapshotId } : {}) };
  });
}

const queues = new Map<string, Promise<unknown>>();

/**
 * 同一章的 AI 改稿一次一笔（读稿 → 调模型 → 换上）：模型一步里并行发出几处改稿时，后一笔等前一笔换上了再读稿，
 * 每笔都是在上一笔的结果上改（不然后一笔照旧稿改，换上时版本对不上、只能留成候选）。不占书锁，作者存稿不被卡住。
 */
export async function oneAiWriterPerChapter<T>(projectDir: string, chapter: number, fn: () => Promise<T>): Promise<T> {
  const key = `${resolve(projectDir)}#${chapter}`;
  const run = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  queues.set(key, tail);
  try {
    return await run;
  } finally {
    if (queues.get(key) === tail) queues.delete(key);
  }
}
