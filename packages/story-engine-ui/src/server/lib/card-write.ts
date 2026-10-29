/**
 * 改设定卡的唯一通道（重构 P9）：作者在设定本里改、作者点「确认改设定」走核心 card.write；
 * 对话 AI 补资料走 card.fill（只能建新卡、填空的、改自己补的）。服务端别处不再自己写设定文件。
 *
 * 存档点由核心在真要写盘时、在书锁里打：指错了卡、没变化、按钮点第二次都不打（撤销不会插进中间）。
 */
import { cardFill, cardWrite, runCommand, type CardOp, type TruthBasis } from "@actalk/story-core";
import { runWithLazySnapshot } from "./snapshot.js";
import { TURN_ABORTED_MESSAGE, turnAborted } from "./turn-abort.js";

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

export async function writeCards(
  projectDir: string,
  input: {
    readonly by: "author" | "ai";
    readonly ops: readonly CardOp[];
    readonly idempotencyKey?: string;
    /** 按钮带的依据：书从那以后变了就不改（核心在书锁里比）。 */
    readonly basis?: TruthBasis;
  },
): Promise<CardWriteOutcome> {
  if (input.ops.length === 0) return { ok: true, lines: [] };
  if (input.by === "ai" && turnAborted()) return { ok: false, code: "turn_aborted", message: TURN_ABORTED_MESSAGE };
  const spec = input.by === "author" ? cardWrite : cardFill;
  const { snapshotId, result } = await runWithLazySnapshot(projectDir, (snapshot) =>
    runCommand(projectDir, spec, { ops: input.ops }, {
      caller: input.by,
      snapshot,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.basis ? { basis: input.basis } : {}),
    }));
  if (!result.ok) return { ok: false, code: result.code, message: result.message, ...(result.details !== undefined ? { details: result.details } : {}) };
  return {
    ok: true,
    lines: result.result.lines,
    ...(result.replayed ? { replayed: true as const } : snapshotId ? { snapshotId } : {}),
  };
}
