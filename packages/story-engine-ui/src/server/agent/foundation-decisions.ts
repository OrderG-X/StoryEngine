/**
 * 「确认改设定」（作者档，重构 P4 起按钮授权，P9 起走核心 card.write）：对话 AI 想改作者写的设定时，
 * foundation_write 只把那几步原样放进按钮；作者点了，这里按作者身份执行（改前存档、可撤销）。
 *
 * 防重复靠核心命令的幂等键（按钮带的 key）：同一个按钮点两次只做一次，重启后也认。
 * 按钮带 AI 提议时的依据摘要（写作版本 P1a）：提议之后书变了就不执行、请 AI 重提；不带依据的旧按钮一律不执行。
 */
import { CardOps, type BasisChange } from "@actalk/story-core";
import { writeCards } from "../lib/card-write.js";
import { describeBasisChanges } from "../book/truth-basis.js";
import { recallBasis } from "../lib/truth-basis-store.js";

export interface FoundationDecisionOutcome {
  readonly ok: boolean;
  readonly summary: string;
  /** 真改了才有：界面凭它把这一步登记成可撤销的一步。 */
  readonly snapshotId?: string;
}

export async function applyFoundationDecision(
  projectDir: string,
  decision: { readonly key: string; readonly input: unknown; readonly basis?: string },
): Promise<FoundationDecisionOutcome> {
  const parsed = CardOps.safeParse((decision.input as { readonly ops?: unknown } | null)?.ops);
  if (!parsed.success) return { ok: false, summary: "没改设定：按钮带的内容不对，请让 AI 重新提一次。" };
  const basis = decision.basis ? await recallBasis(projectDir, decision.basis) : undefined;
  if (!basis) return { ok: false, summary: "没改设定：这个按钮是旧的（不知道是照哪一版设定提的），请让 AI 重新提一次。" };
  const outcome = await writeCards(projectDir, { by: "author", ops: parsed.data, idempotencyKey: `card-confirm:${decision.key}`, basis });
  if (!outcome.ok && outcome.code === "basis_changed") {
    const changes = (outcome.details as { readonly changes?: readonly BasisChange[] } | undefined)?.changes ?? [];
    return { ok: false, summary: `没改设定：提议之后${describeBasisChanges(changes)}改过，这份改动是照改之前提的，请让 AI 重新提一次。` };
  }
  if (!outcome.ok) return { ok: false, summary: outcome.message };
  if (outcome.replayed) return { ok: true, summary: "这次改设定刚才已经做过了，没有重复做。" };
  if (outcome.lines.length === 0) return { ok: true, summary: "设定本没有变化（要改的和现在的一样）。" };
  return {
    ok: true,
    summary: `改好了：${outcome.lines.join("；")}。`,
    ...(outcome.snapshotId ? { snapshotId: outcome.snapshotId } : {}),
  };
}
