/**
 * 作者挑的 AI 稿：换上 / 不要了（写作版本 P2a 片 2D，设计 6.6）。只在 draft.adopt / draft.discard 操作的步骤里调，
 * 作者在稿纸提示条、「另外几版」卡上点了才有这次操作（对话 AI 交不了）。
 *
 * - 先读（`readAdoptable`，步骤里）：候选还在、是这一章的、作者没处理过、内容还是作者看到的那版（sha）；读出的章名和正文进检查点，
 *   之后崩了重做，换上那一下拿的还是这一份。
 * - 换上（`adoptCandidateInOperation`，应用步骤里）：书锁里收拾完写到一半的事务 → 核心 draft.adoptCandidate（作者档、存档、
 *   可撤销；工作稿还是作者眼前那版才换，核心按 baseVersion 核）→ 同一次持锁里这份候选立墓碑（同号不复活）、按 AI 字数记。
 *   核心命令带 op（幂等键 = opId:stepId）：有回执就回放、不再写；precondition（回放之后才跑）核栅栏、再核一遍候选。
 *   生成时的依据只提示、不挡（作者看过、自己挑的）。
 * - 不要了（`discardCandidateLocked`，发布步骤里、拿着书锁）：核候选（同上）后立墓碑；已经不在、处理过了也算做成了。
 * 对不上抛 OperationObsolete（这次作废、说哪样变了），作者那份不动；栅栏不过抛 OperationStopped。
 */
import { resolve } from "node:path";
import { draftAdoptCandidate, fail, opCommandKey, readCommandReceipt, runCommand, withSettledBook } from "@actalk/story-core";
import { readTruthBasisToCompare } from "../book/truth-basis.js";
import { draftSha, readDraftCandidate, settleDraftCandidate, type DraftCandidate } from "./draft-candidates.js";
import { currentOperation, OperationObsolete, OperationStopped } from "./operations/context.js";
import { checkFence } from "./operations/fence.js";
import { scrubLocalAbsolutePaths } from "./local-path-scrubber.js";
import { runWithLazySnapshot } from "./snapshot.js";
import { chapterWordsNow, publishChapterWordsLocked } from "./word-stats.js";

/** 作者点的是哪一份：候选号 + 作者看到的那份的指纹。 */
export interface CandidatePick {
  readonly chapter: number;
  readonly candidateId: string;
  readonly sha: string;
}

/** 读出来要换上的那一份（进检查点）。 */
export interface AdoptableCandidate {
  readonly title: string;
  readonly body: string;
  readonly basisDigest: string;
}

type CandidateProblem = { readonly code: string; readonly message: string };

/** 这一份还能不能由作者处理（换上 / 不要了）：不在、处理过、不是这章、变过了如实说。 */
function candidateProblem(candidate: DraftCandidate | undefined, pick: CandidatePick): CandidateProblem | undefined {
  if (!candidate || candidate.chapter !== pick.chapter) return { code: "candidate_gone", message: "那一版已经不在了（可能已经换上或不要了）。" };
  if (candidate.status === "handled" || !candidate.body.trim()) return { code: "candidate_handled", message: "那一版已经处理过了（换上过或不要了）。" };
  if (draftSha(candidate) !== pick.sha) return { code: "candidate_changed", message: "那一版在这期间变过了，没换。看一眼再选。" };
  return undefined;
}

/**
 * 步骤里：读出要换上的那一份（读路径，不拿锁；换上那一下在书锁里再核一遍）。候选是整份稿：章名开写时就定下了
 * （写手没起就是作者那时的章名），没有就是没有，不借盘上后来的（P1 第 14 轮 AB3）。
 */
export async function readAdoptable(projectDir: string, pick: CandidatePick): Promise<AdoptableCandidate> {
  const candidate = await readDraftCandidate(projectDir, pick.candidateId);
  const problem = candidateProblem(candidate, pick);
  if (problem) throw new OperationObsolete(problem.code, problem.message);
  return { title: candidate!.title ?? "", body: candidate!.body, basisDigest: candidate!.basisDigest };
}

export interface AdoptOutcome {
  readonly version: string;
  readonly unchanged: boolean;
  readonly snapshotId?: string;
  /** 这一版是照旧的前文写的（写它之后前文、设定改过）：只提示。 */
  readonly basisMoved?: true;
  readonly warnings?: readonly string[];
}

const FENCE_CODES: ReadonlySet<string> = new Set(["operation_stopped", "book_gone", "book_epoch_changed"]);

const errorText = (error: unknown): string => scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error));

/** 应用步骤里：换上作者挑的那一份。 */
export async function adoptCandidateInOperation(projectDir: string, input: CandidatePick & AdoptableCandidate & { readonly baseVersion: string | null }): Promise<AdoptOutcome> {
  const operation = currentOperation();
  const stepId = operation?.step?.id;
  if (!operation || !stepId) throw new Error("换上 AI 稿只在操作的应用步骤里做。");
  if (resolve(operation.bookDir) !== resolve(projectDir)) throw new OperationStopped("cross_book_write", "这次操作只写它自己那本书，别的书没有写。");
  const op = { opId: operation.opId, stepId };
  const key = `${op.opId}:${op.stepId}`;
  let problem: CandidateProblem | undefined;
  try {
    const settled = await withSettledBook(projectDir, async (): Promise<AdoptOutcome> => {
      const wordsBefore = await chapterWordsNow(projectDir, input.chapter).catch(() => undefined);
      const { snapshotId, result } = await runWithLazySnapshot(projectDir, (snapshot) =>
        runCommand(projectDir, draftAdoptCandidate, {
          chapter: input.chapter,
          body: input.body,
          title: input.title,
          baseVersion: input.baseVersion,
        }, {
          caller: "author",
          snapshot,
          op,
          // 回放回执之后才跑：已经换上过的不再核（换上之后这份已经立了墓碑）。
          precondition: async () => {
            const blocked = await checkFence(operation);
            if (blocked) return blocked;
            problem = candidateProblem(await readDraftCandidate(projectDir, input.candidateId), input);
            return problem ? fail(problem.code, problem.message) : undefined;
          },
        }), `换上 AI 稿：第${input.chapter}章`);
      if (!result.ok) {
        if (FENCE_CODES.has(result.code)) throw new OperationStopped(result.code, result.message);
        if (problem) throw new OperationObsolete(problem.code, problem.message);
        if (result.code === "draft_conflict") throw new OperationObsolete("draft_moved", `第 ${input.chapter} 章的稿子在你看过之后又改过了，AI 这版没换上。看一眼稿纸再选。`);
        throw new Error(result.message);
      }
      // 换上了（或回放：上次换上了、之后崩了）。之后的事同一次持锁里做完，出意外只记警告。
      const warnings: string[] = [];
      if (!result.result.unchanged) await publishChapterWordsLocked(projectDir, input.chapter, key, result.replayed ? undefined : wordsBefore);
      try {
        await settleDraftCandidate(projectDir, input.candidateId);
      } catch (error) {
        warnings.push(`换好了，但那一版没清掉（下次开这一章还会提示）：${errorText(error)}`);
      }
      const basisMoved = await readTruthBasisToCompare(projectDir).then((basis) => basis.digest !== input.basisDigest).catch(() => false);
      return {
        version: result.result.version,
        unchanged: result.result.unchanged,
        ...(snapshotId && !result.replayed ? { snapshotId } : {}),
        ...(basisMoved ? { basisMoved: true as const } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    });
    if (!settled.ok) throw new Error(settled.message);
    return settled.value;
  } catch (error) {
    if (error instanceof OperationObsolete || error instanceof OperationStopped) throw error;
    // 核心提交之后的事出了意外：有回执就是换上了。
    const receipt = await readCommandReceipt(projectDir, opCommandKey(op)).catch(() => undefined);
    const result = receipt?.result as { readonly version?: unknown; readonly unchanged?: unknown } | undefined;
    if (typeof result?.version === "string") return { version: result.version, unchanged: result.unchanged === true, warnings: [`换上之后的收尾没做全：${errorText(error)}`] };
    throw error;
  }
}

/** 发布步骤里（拿着书锁）：不要那一份了。已经不在、处理过了也算做成了；内容变过了不清（作者看到的不是这份）。 */
export async function discardCandidateLocked(projectDir: string, pick: CandidatePick): Promise<{ readonly already: boolean }> {
  const problem = candidateProblem(await readDraftCandidate(projectDir, pick.candidateId), pick);
  if (problem?.code === "candidate_changed") throw new OperationObsolete(problem.code, "那一版在这期间变过了，没删。看一眼再选。");
  if (problem) return { already: true };
  await settleDraftCandidate(projectDir, pick.candidateId);
  return { already: false };
}
