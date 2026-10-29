/**
 * 改设定卡的唯一通道（重构 P9）：作者在设定本里改走核心 card.write；对话 AI 改设定是一次操作（settings.change，写作版本 P2a 片 3），
 * AI 补的走 card.fill（只能建新卡、填空的、改自己补的），作者点了「确认改设定」「认下」的走 card.write。服务端别处不再自己写设定文件。
 *
 * 存档点由核心在真要写盘时、在书锁里打：指错了卡、没变化、按钮点第二次都不打（撤销不会插进中间）。
 */
import { cardFill, cardWrite, runCommand, type CardOp, type TruthBasis } from "@actalk/story-core";
import { runCommandInOperation } from "./operations/command.js";
import { runWithLazySnapshot } from "./snapshot.js";

export type CardWriteOutcome =
  | {
      readonly ok: true;
      /** 改了什么（给人看的，只有名字）。空 = 什么都没变（没存档点）。 */
      readonly lines: readonly string[];
      readonly snapshotId?: string;
      /** 同一个按钮点了第二次：上次已经做过，这次没再做。 */
      readonly replayed?: true;
    }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly details?: unknown };

type CardCommandOutcome = Awaited<ReturnType<typeof runCommand<{ ops: CardOp[] }, { lines: readonly string[] }>>>;

function outcomeOf(result: CardCommandOutcome, snapshotId: string | undefined): CardWriteOutcome {
  if (!result.ok) return { ok: false, code: result.code, message: result.message, ...(result.details !== undefined ? { details: result.details } : {}) };
  return {
    ok: true,
    lines: result.result.lines,
    ...(result.replayed ? { replayed: true as const } : snapshotId ? { snapshotId } : {}),
  };
}

/** 作者在设定本里点字就改（不是操作）：作者档 card.write，按请求号防重复。 */
export async function writeCards(
  projectDir: string,
  input: { readonly ops: readonly CardOp[]; readonly idempotencyKey: string },
): Promise<CardWriteOutcome> {
  if (input.ops.length === 0) return { ok: true, lines: [] };
  const { snapshotId, result } = await runWithLazySnapshot(projectDir, (snapshot) =>
    runCommand(projectDir, cardWrite, { ops: input.ops }, { caller: "author", snapshot, idempotencyKey: input.idempotencyKey }));
  return outcomeOf(result, snapshotId);
}

/**
 * 改设定这次操作的应用步骤里写（写作版本 P2a 片 3）：AI 补的走 card.fill，作者点了「确认改设定」「认下」的走 card.write。
 * 幂等键是这一步（崩了重来回放）；依据给了就在书锁里核，书从那以后变了就不改（basis_changed + 变了哪些）。
 */
export async function writeCardsInOperation(
  projectDir: string,
  input: { readonly by: "author" | "ai"; readonly ops: readonly CardOp[]; readonly basis?: TruthBasis },
): Promise<CardWriteOutcome> {
  if (input.ops.length === 0) return { ok: true, lines: [] };
  const { snapshotId, result } = await runCommandInOperation(projectDir, input.by === "author" ? cardWrite : cardFill, { ops: [...input.ops] }, {
    what: "改设定",
    caller: input.by,
    ...(input.basis ? { basis: input.basis } : {}),
  });
  return outcomeOf(result, snapshotId);
}
