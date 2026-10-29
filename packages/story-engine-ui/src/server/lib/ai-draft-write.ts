/**
 * AI 写工作稿的唯一通道（写作版本 P1b）：出稿、接着写、去 AI 味、改这处、改稿，全走这里，再走核心的
 * draft.applyGenerated 命令（书锁 + 事务落盘，进程被杀不留半截稿）。服务端别处不再自己拼工作稿文件、不再裸写 drafts/。
 *
 * 规矩：AI 写好的一份先存成候选（draft-candidates.ts，「在写」），再试着换上；只在两样都对得上时换上——
 *  - 工作稿还是开工时那一版（baseVersion）：模型跑着的几十秒到几分钟里作者存了稿、撤销或恢复过，就不换；
 *  - 书还是开工时那样（开工时读的真相依据，runner 在书锁里、收拾完写到一半的事务之后核）：前文、设定、作者裁定改过，
 *    这版是照旧的写的，也不换。
 * 换上了删这份候选（只删这一份：别的没处理的候选不动）；没换上（上面两样对不上、写盘出错）这份标成「写好了」留着，
 * 如实告诉作者，稿纸上可以「换成 AI 这版」。白跑的几分钟不丢，作者那份也不被盖掉。
 *
 * 存档点在换上前、同一把书锁里打（真要写才打）：撤销、定稿切不进中间，没换上的不在操作历史里多出一条。
 * 调用方不要把模型调用放进书锁：作者存稿会被卡住。同一章的 AI 改稿要排队的，用 oneAiWriterPerChapter。
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { draftApplyGenerated, draftPath, runCommand, withBookLock, type TruthBasis } from "@actalk/story-core";
import { firstMovedMaterial, type MaterialRead, type MovedMaterial } from "../book/material-reads.js";
import { MIRROR_FILES } from "../book/mirror/build.js";
import { MIRROR_MARKER } from "../book/mirror/sync.js";
import { removeDraftCandidate, saveDraftCandidate, type DraftCandidateSource, type DraftKeptReason } from "./draft-candidates.js";
import { scrubLocalAbsolutePaths } from "./local-path-scrubber.js";
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
  /**
   * AI 这一版的整份稿（写作版本 P1 第 14 轮复核）：拆开的正文（一行都不再拆）+ 章名（空串 = 没章名）。
   * 调用方开工时就把章名定下来：AI 给了用它，没给就是开工时那份稿的章名——留成候选、作者后来再换上，也还是这一版的章名，
   * 不借换上那一刻盘上的（AB3）。改文件原文的（改句、改稿、去 AI 味）先过核心 parseDraftFile。
   */
  readonly title: string;
  readonly body: string;
  /** 开工时读的工作稿版本（这一章原来没有工作稿就是 null）；和读到的正文一起读的那一版。 */
  readonly baseVersion: string | null;
  /** 开工时读的真相依据（先读它，再读写稿要用的材料）。 */
  readonly basis: TruthBasis;
  /**
   * 写的时候用过、不在真相依据里的材料（前一章工作稿、已有各章章名、本章章纲……，用到时记下的那一版）：
   * 换上时有一样变了，也算依据过期（第 4 轮复核 R6、第 5 轮 S8/S9）。只改这一章本身的（改稿、改句、去 AI 味）给空。
   */
  readonly materials: readonly MaterialRead[];
  readonly source: DraftCandidateSource;
  /** 换上前打的存档点叫什么（操作历史里看的）；不给用核心的「AI 写稿：第 N 章」。 */
  readonly snapshotLabel?: string;
  /** 开写时已经存下的那份候选（出稿流程）：就用它，不另存一份。 */
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

function whyNotApplied(reason: DraftKeptReason, detail?: string): string {
  if (reason === "basis_moved") return `写的途中${detail ?? "前文或设定"}改过`;
  if (reason === "interrupted") return "写到一半停了";
  if (reason === "apply_failed") return `换上的时候写盘没成功${detail ? `（${detail}）` : ""}`;
  return "写的途中这一章的稿子改过（存稿、撤销或恢复）";
}

const MIRROR_PATHS: ReadonlySet<string> = new Set([MIRROR_MARKER, ...Object.values(MIRROR_FILES)]);

function describeMovedMaterial(moved: MovedMaterial): string {
  if (moved.kind === "plan") return "本章章纲";
  if (moved.kind === "files") {
    if (moved.path !== undefined && MIRROR_PATHS.has(moved.path)) return "按账整理的时间线和线索";
    return moved.path === "project.json" ? "书的资料" : "书里的其他资料";
  }
  const what = moved.kind === "drafts" ? "的稿子" : "的章纲";
  return moved.chapter === undefined ? `别的章${what}` : `第 ${moved.chapter} 章${what}`;
}

/** 没换上时给作者看的一句。detail = 写盘出错时的原因 / 依据过期时改过的是什么。 */
export function keptMessage(chapter: number, reason: DraftKeptReason, detail?: string): string {
  return `第 ${chapter} 章 AI 这版没换上：${whyNotApplied(reason, detail)}，你那份没动。AI 这版留着，稿纸上可以换成它。`;
}

const errorText = (error: unknown): string => scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error));

export async function applyAiDraft(projectDir: string, input: AiDraftInput): Promise<AiDraftOutcome> {
  const title = input.title.trim();
  const path = join(projectDir, draftPath(input.chapter));
  const candidateOf = (status: "writing" | "ready", reason?: Exclude<DraftKeptReason, "interrupted">, id?: string) => saveDraftCandidate(projectDir, {
    chapter: input.chapter,
    title,
    body: input.body,
    baseVersion: input.baseVersion,
    basisDigest: input.basis.digest,
    source: input.source,
    status,
    ...(reason ? { reason } : {}),
    ...(id ? { id } : {}),
  });
  // 先存下（写作版本 P1b 第 3 轮复核）：换上的途中写盘出错、进程被杀，AI 这版都还在。存不下来照样试着换上，换不上再存一次。
  let candidateId = input.candidateId;
  try {
    candidateId = (await candidateOf("writing", undefined, candidateId)).id;
  } catch (error) {
    console.warn(`[ai-draft] 第 ${input.chapter} 章 AI 这版换上前没存成候选：${errorText(error)}`);
  }
  const keep = async (reason: Exclude<DraftKeptReason, "interrupted">, detail?: string): Promise<AiDraftOutcome> => {
    let kept;
    try {
      kept = await candidateOf("ready", reason, candidateId);
    } catch (error) {
      throw new AiDraftWriteError("not_kept", `第 ${input.chapter} 章 AI 这版没换上（${whyNotApplied(reason, detail)}），也没能另外存下来：${errorText(error)}`);
    }
    return { applied: false, reason, candidateId: kept.id, message: keptMessage(input.chapter, reason, detail) };
  };
  let outcome: AiDraftOutcome | "aborted";
  try {
    outcome = await withBookLock(projectDir, async (): Promise<AiDraftOutcome | "aborted"> => {
      // 作者喊停之后后到的稿不落盘，也不留候选（锁里再问一次：等锁的工夫也可能停了）。
      if (turnAborted()) return "aborted";
      const movedMaterial = await firstMovedMaterial(projectDir, input.materials);
      if (movedMaterial) return keep("basis_moved", describeMovedMaterial(movedMaterial));
      // 写作统计：写之前量一下这章多少字，写完按差值记成 AI 写的。
      const wordsBefore = await chapterWordsNow(projectDir, input.chapter).catch(() => undefined);
      // 依据交给 runner 核：它先收拾写到一半的事务（回滚会换代次），再在同一把锁里比，途中读到的半截真相一律对不上。
      const { snapshotId, result } = await runWithLazySnapshot(projectDir, (snapshot) =>
        runCommand(projectDir, draftApplyGenerated, {
          chapter: input.chapter,
          body: input.body,
          title,
          baseVersion: input.baseVersion,
        }, { caller: "ai", snapshot, basis: input.basis }), input.snapshotLabel);
      if (!result.ok && result.code === "basis_changed") return keep("basis_moved");
      if (!result.ok && result.code === "draft_conflict") return keep("draft_moved");
      if (!result.ok) return keep("apply_failed", result.message);
      // 换上了：只删这一份（别的候选作者还没处理，不动）。
      if (candidateId) await removeDraftCandidate(projectDir, candidateId);
      if (!result.result.unchanged) await recordChapterWords(projectDir, input.chapter, "ai", wordsBefore);
      const content = await readFile(path, "utf-8");
      return { applied: true, path, content, version: result.result.version, unchanged: result.result.unchanged, ...(snapshotId ? { snapshotId } : {}) };
    });
  } catch (error) {
    if (error instanceof AiDraftWriteError) throw error;
    // 存档点、写盘这些出了意外：工作稿没动（核心事务回滚），AI 这版留着。
    outcome = await keep("apply_failed", errorText(error));
  }
  if (outcome === "aborted") {
    if (candidateId) await removeDraftCandidate(projectDir, candidateId);
    throw new AiDraftWriteError("turn_aborted", TURN_ABORTED_MESSAGE);
  }
  return outcome;
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
