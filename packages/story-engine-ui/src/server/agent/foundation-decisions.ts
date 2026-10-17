/**
 * 改设定的作者档（重构 P4）：删角色、覆盖已确立的设定（引擎判 needs_confirmation 的写入）只有作者点了
 * 「确认改设定」按钮才执行。
 *
 *   对话 AI 调 foundation_write → 被拦下的写入原样放进按钮（foundationConfirm）→ 作者点了 →
 *   applyFoundationDecision 按入参 schema 校验、存一个撤销点、带作者确认执行。
 *
 * 以前靠读作者原话找「允许覆盖 / 确定」这类词放行（userTurnAllowsEstablishedOverride），删角色只认模型自报的
 * confirmed——都是猜。现在授权只来自按钮。
 */
import { runWithSnapshot } from "../lib/snapshot.js";
import {
  applyFoundationWriteToolLogic,
  foundationWriteInputSchema,
  foundationWriteSnapshotDetail,
  type FoundationWriteToolOutput,
} from "./tools/foundation-write.js";

/** 同一份提议点两次只执行一次（进程内记；重启后再点：删过的角色找不到会如实说没改，覆盖同值无害）。 */
const appliedKeys = new Map<string, Set<string>>();
const MAX_KEYS_PER_BOOK = 200;

function wasApplied(projectDir: string, key: string): boolean {
  return appliedKeys.get(projectDir)?.has(key) === true;
}

function rememberApplied(projectDir: string, key: string): void {
  const keys = appliedKeys.get(projectDir) ?? new Set<string>();
  keys.add(key);
  if (keys.size > MAX_KEYS_PER_BOOK) {
    const oldest = keys.values().next().value;
    if (oldest !== undefined) keys.delete(oldest);
  }
  appliedKeys.set(projectDir, keys);
}

export interface FoundationDecisionOutcome {
  readonly ok: boolean;
  readonly summary: string;
  /** 真改了才有：界面凭它把这一步登记成可撤销的一步。 */
  readonly snapshotId?: string;
  /** 资料写入的完整回执（真执行了才有），界面照 foundation_write 的结果刷新资料面板。 */
  readonly output?: FoundationWriteToolOutput;
}

export async function applyFoundationDecision(
  projectDir: string,
  decision: { readonly key: string; readonly input: unknown },
): Promise<FoundationDecisionOutcome> {
  if (wasApplied(projectDir, decision.key)) {
    return { ok: true, summary: "这次改设定刚才已经做过了，没有重复做。" };
  }
  const parsed = foundationWriteInputSchema.safeParse(decision.input);
  if (!parsed.success) {
    return { ok: false, summary: "没改设定：按钮带的内容不对，请让 AI 重新提一次。" };
  }
  const toolInput = parsed.data;
  const detail = foundationWriteSnapshotDetail(toolInput).replace(/:/gu, "·");
  const { snapshot, result } = await runWithSnapshot(projectDir, `agent:foundation_write:${detail}`, () =>
    applyFoundationWriteToolLogic({ projectDir, toolInput, authorConfirmed: true }));
  if (result.ok) rememberApplied(projectDir, decision.key);
  return {
    ok: result.ok,
    summary: result.summary,
    output: result,
    ...(result.ok ? { snapshotId: snapshot.id } : {}),
  };
}
