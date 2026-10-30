/**
 * AI 写工作稿的唯一通道（写作版本 P1b）：出稿、接着写、去 AI 味、改这处、改稿，全走这里，再走核心的
 * draft.applyGenerated 命令（书锁 + 事务落盘，进程被杀不留半截稿）。服务端别处不再自己拼工作稿文件、不再裸写 drafts/。
 *
 * 只在操作的应用步骤里换上（写作版本 P2a 设计第三节、6.3、6.4；片 4C 删了操作外那条路）。只在两样都对得上时换上——
 *  - 工作稿还是开工时那一版（baseVersion）：模型跑着的几十秒到几分钟里作者存了稿、撤销或恢复过，就不换；
 *  - 书还是开工时那样（开工时读的真相依据和写的时候用过的材料，在书锁里、收拾完写到一半的事务之后核）：前文、设定、作者裁定改过，
 *    这版是照旧的写的，也不换。
 * 没换上（上面两样对不上、写盘出错）留稳定号的候选（作者处理过的不复活），如实告诉作者，稿纸上可以「换成 AI 这版」。
 *
 * 核心命令带 `op`（幂等键 = opId:stepId，有回执就回放、不再写）和 precondition（书锁里先核栅栏、再核写稿用过的材料，回放之后才核）；
 * 存档点在换上前、同一把书锁里打（真要写才打）。换上了，同一次持锁里按键记改句记录、字数。栅栏不过 → 抛 OperationStopped。
 * 换上之后的事出了意外：查回执，有就报换上了 + 警告，不改成「没成功」。
 * 调用方不要把模型调用放进书锁：作者存稿会被卡住。同一章的 AI 改稿要排队的，用 oneAiWriterPerChapter。
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { draftApplyGenerated, draftPath, fail, opCommandKey, readCommandReceipt, runCommand, withBookLock, withSettledBook, type TruthBasis } from "@actalk/story-core";
import { firstMovedMaterial, type MaterialRead, type MovedMaterial } from "../book/material-reads.js";
import { keepOperationCandidateLocked, type ApplyKeptReason, type DraftCandidateSource, type DraftKeptReason } from "./draft-candidates.js";
import { publishFixLogLocked, type FixRecord } from "./fix-log.js";
import { currentOperation, OperationStopped, type OperationContext } from "./operations/context.js";
import { checkFence } from "./operations/fence.js";
import { FENCE_CODES } from "./operations/command.js";
import { scrubLocalAbsolutePaths } from "./local-path-scrubber.js";
import { runWithLazySnapshot } from "./snapshot.js";
import { chapterWordsNow, publishChapterWordsLocked } from "./word-stats.js";

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
  /** 操作里：这次按核账改了哪些句子（零条也给），换上时同一次持锁里记进改句记录。 */
  readonly fixes?: readonly FixRecord[];
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
    /** 换上之后的收尾没做全（字数、改句记录没记上……），一句一条。 */
    readonly warnings?: readonly string[];
  }
  | {
    readonly applied: false;
    readonly reason: ApplyKeptReason;
    readonly candidateId: string;
    /** 给作者看的一句：为什么没换上、这版在哪。 */
    readonly message: string;
    /** 作者已经处理过这一版（换上 / 不要了）：没再留。 */
    readonly handled?: true;
  };

function whyNotApplied(reason: DraftKeptReason, detail?: string): string {
  if (reason === "basis_moved") return `写的途中${detail ?? "前文或设定"}改过`;
  if (reason === "interrupted") return "写到一半停了";
  if (reason === "apply_failed") return `换上的时候写盘没成功${detail ? `（${detail}）` : ""}`;
  return "写的途中这一章的稿子改过（存稿、撤销或恢复）";
}

function describeMovedMaterial(moved: MovedMaterial): string {
  if (moved.kind === "plan") return "本章章纲";
  if (moved.kind === "files") {
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

/** AI 稿只在操作的应用步骤里换上（写作版本 P2a 片 4C）：不在操作里的如实挡下，不写。 */
export async function applyAiDraft(projectDir: string, input: AiDraftInput): Promise<AiDraftOutcome> {
  const operation = currentOperation();
  if (!operation) throw new AiDraftWriteError("not_in_operation", "AI 稿只在操作里换上，这次没写。");
  return applyInOperation(projectDir, input, operation);
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


async function applyInOperation(projectDir: string, input: AiDraftInput, operation: OperationContext): Promise<AiDraftOutcome> {
  if (resolve(operation.bookDir) !== resolve(projectDir)) throw new OperationStopped("cross_book_write", "这次操作只写它自己那本书，别的书没有写。");
  const stepId = operation.step?.id;
  if (!stepId) throw new AiDraftWriteError("not_in_step", "AI 稿只在操作的应用步骤里换上。");
  const op = { opId: operation.opId, stepId };
  const key = `${op.opId}:${op.stepId}`;
  const title = input.title.trim();
  const path = join(projectDir, draftPath(input.chapter));
  const keep = async (reason: ApplyKeptReason, detail?: string): Promise<AiDraftOutcome> => {
    let kept;
    try {
      kept = await keepOperationCandidateLocked(projectDir, {
        chapter: input.chapter,
        title,
        body: input.body,
        baseVersion: input.baseVersion,
        basisDigest: input.basis.digest,
        source: input.source,
        reason,
        op,
      });
    } catch (error) {
      throw new AiDraftWriteError("not_kept", `第 ${input.chapter} 章 AI 这版没换上（${whyNotApplied(reason, detail)}），也没能另外存下来：${errorText(error)}`);
    }
    if (kept.kind === "handled") {
      return { applied: false, reason, candidateId: kept.id, handled: true, message: `第 ${input.chapter} 章 AI 这版你已经处理过了，这次没再留。` };
    }
    return { applied: false, reason, candidateId: kept.candidate.id, message: keptMessage(input.chapter, reason, detail) };
  };
  const applied = async (version: string, unchanged: boolean, warnings: string[], snapshotId?: string): Promise<AiDraftOutcome> => {
    const content = await readFile(path, "utf-8");
    return { applied: true, path, content, version, unchanged, ...(snapshotId ? { snapshotId } : {}), ...(warnings.length > 0 ? { warnings } : {}) };
  };
  try {
    // 先收拾写到一半的事务再量字数、换上（P1 第 17 轮 AE3：写手读材料时正赶上别的写断在半路，先核后收拾就看不出来）；收拾不了如实留成候选。
    const settled = await withSettledBook(projectDir, async (): Promise<AiDraftOutcome> => {
      let moved: MovedMaterial | undefined;
      const wordsBefore = await chapterWordsNow(projectDir, input.chapter).catch(() => undefined);
      const { snapshotId, result } = await runWithLazySnapshot(projectDir, (snapshot) =>
        runCommand(projectDir, draftApplyGenerated, {
          chapter: input.chapter,
          body: input.body,
          title,
          baseVersion: input.baseVersion,
        }, {
          caller: "ai",
          snapshot,
          basis: input.basis,
          op,
          // 回放回执之后才跑：已经换上过的不再核（核了反而会把自己换上的那一下当成材料变了）。
          precondition: async () => {
            const blocked = await checkFence(operation);
            if (blocked) return blocked;
            moved = await firstMovedMaterial(projectDir, input.materials);
            return moved ? fail("material_moved", describeMovedMaterial(moved)) : undefined;
          },
        }), input.snapshotLabel);
      if (!result.ok) {
        if (FENCE_CODES.has(result.code)) throw new OperationStopped(result.code, result.message);
        if (result.code === "material_moved") return keep("basis_moved", moved ? describeMovedMaterial(moved) : undefined);
        if (result.code === "basis_changed") return keep("basis_moved");
        if (result.code === "draft_conflict") return keep("draft_moved");
        return keep("apply_failed", result.message);
      }
      // 换上了（或回放：上次换上了、之后崩了）。之后的事同一次持锁里做完，出意外只记警告。
      const warnings: string[] = [];
      if (!result.result.unchanged) {
        const counted = await publishChapterWordsLocked(projectDir, input.chapter, key, result.replayed ? undefined : wordsBefore);
        if (counted && result.replayed) warnings.push("这次的字数没按来源记上（记成了「其他」）。");
      }
      if (input.fixes) {
        try {
          await publishFixLogLocked(projectDir, input.chapter, key, input.fixes);
        } catch (error) {
          warnings.push(`改句记录没记上：${errorText(error)}`);
        }
      }
      return applied(result.result.version, result.result.unchanged, warnings, result.replayed ? undefined : snapshotId);
    });
    return settled.ok ? settled.value : await keep("apply_failed", settled.message);
  } catch (error) {
    if (error instanceof AiDraftWriteError || error instanceof OperationStopped) throw error;
    // 核心提交之后的事（存档点收尾、读回盘上那份）出了意外：有回执就是换上了。
    const receipt = await readCommandReceipt(projectDir, opCommandKey(op)).catch(() => undefined);
    if (receipt) {
      const result = receipt.result as { readonly version?: unknown; readonly unchanged?: unknown };
      if (typeof result.version === "string") return applied(result.version, result.unchanged === true, [`换上之后的收尾没做全：${errorText(error)}`]);
    }
    return withBookLock(projectDir, () => keep("apply_failed", errorText(error)));
  }
}
