/**
 * prune_snapshots — 快照历史（操作历史）磁盘治理：把太长的历史裁到最近 keep 条。
 *
 * 两步哲学（对齐 commit_preview / commit_apply）：默认 dry-run 只预览，如实回报将裁多少条、
 * 净释放多少提交；用户明确说「确认裁剪」后才带 confirm:true 真裁。
 * 真裁由 lib/snapshot.pruneSnapshots 完成：全程只动快照仓库的 git 引用与对象库，工作树/正文分毫不动；
 * 裁前完整历史自动打成 bundle 备份到项目目录外（~/.story-engine/snapshot-backups/，SE_DATA_DIR 可覆盖），
 * 被裁条目折成一条 base 存档提交，仍可作为整体恢复点。
 *
 * 刻意不用 writeTool 包装：裁剪的对象就是快照链本身——事前再建一条快照只会落在保留窗口内、
 * 且「恢复到工作树」语义撤不掉一次纯历史折叠（工作树本来就没动）；它的兜底是 bundle 备份 + base 提交。
 *
 * 意图门（turn-intent-gate）：dry-run 只读不拦；confirm=true 真裁须本轮用户原话带
 * 「确认裁剪」级意图（userTurnAllowsSnapshotPrune）——「吧」级首次请求（「裁剪快照历史吧」）
 * 只够预览、不够真裁；缺原话放行（前端按钮/旧会话兼容）。
 */
import { createTool } from "@mastra/core/tools";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { z } from "zod";

import { pruneSnapshots, type SnapshotPruneResult } from "../../lib/snapshot.js";
import { readProjectDirFromContext, readUserTurnTextFromContext } from "../request-context.js";
import { coerceBoolean, coerceNumber, positiveOrUndefined } from "./lenient-args.js";
import { userTurnAllowsSnapshotPrune } from "./turn-intent-gate.js";

export interface PruneSnapshotsRunResult {
  readonly ok: boolean;
  readonly dryRun: boolean;
  readonly summary: string;
  readonly keep?: number;
  readonly totalBefore?: number;
  readonly prunedCount?: number;
  readonly totalAfter?: number;
  readonly freedCommits?: number;
  readonly backupBundlePath?: string;
  readonly warnings?: string[];
}

/**
 * 摘要消毒（铁律④·绝不泄露本地绝对路径）：与 commit-apply.ts scrubBareEntityIdsFromText 的
 * 路径分支同一口径。prune 的错误/警告文本可能内嵌 bundle 备份或项目目录的绝对路径
 * （snapshot.ts 回滚错误内嵌 bundlePath、git 子进程报错常带 -C 仓库路径），进【给用户看的】summary 前必须洗掉。
 */
function scrubLocalAbsolutePaths(text: string): string {
  return text.replace(/'?\/(?:Users|home|var|tmp|private)\/[^'"\s]*'?/gu, "(本地路径)");
}

/** summary 只讲条数与去向；快照 id / 提交哈希绝不进文本（baseCommitId 也不透出到 output——agent 用不上）。 */
function buildSummary(result: SnapshotPruneResult): string {
  const { dryRun, keep, totalBefore, prunedCount, totalAfter, freedCommits } = result;
  if (prunedCount === 0) {
    return dryRun
      ? `预览：当前操作历史共 ${totalBefore} 条，未超过保留上限 ${keep} 条，不需要裁剪。`
      : `当前操作历史共 ${totalBefore} 条，未超过保留上限 ${keep} 条，无需裁剪（没有改动）。`;
  }
  if (dryRun) {
    return `预览：当前操作历史共 ${totalBefore} 条，裁剪后将保留最近 ${keep} 条——更早 ${prunedCount} 条折成一条存档点（仍可整体恢复到那里），净释放 ${freedCommits} 条提交，裁后共 ${totalAfter} 条。确认要裁就说「确认裁剪」，我再动手；真裁前会把裁前完整历史自动备份到项目目录外。`;
  }
  // warnings 内嵌的 git 报错可能带绝对路径，进 summary 前同款消毒
  const warningsText = result.warnings?.length ? ` 注意：${result.warnings.map(scrubLocalAbsolutePaths).join("；")}` : "";
  return `已把操作历史裁到最近 ${keep} 条：更早 ${prunedCount} 条折成一条「base」存档点（仍可整体恢复到那里），净释放 ${freedCommits} 条提交，裁后共 ${totalAfter} 条。裁前完整历史已备份到项目目录外的 snapshot-backups 目录。注意：这一步不在「撤销上一改动」链上（裁剪没动工作树、没有可撤的内容变更），要回退只能用备份 bundle / base 存档点整体恢复。${warningsText}`;
}

/** 纯壳函数（便于单测）：预览/真裁都由它走，confirm!==true 一律 dry-run。失败如实 ok:false，绝不静默。 */
export async function runPruneSnapshots(
  projectDir: string,
  options: { readonly keep?: number; readonly confirm?: boolean } = {},
): Promise<PruneSnapshotsRunResult> {
  const confirm = options.confirm === true;
  // 「0=默认」与兄弟工具（requestedDraftLength 等）同惯例：keep 非正数视作没填，交给引擎默认 200。
  const keep = positiveOrUndefined(options.keep);
  try {
    const result = await pruneSnapshots(projectDir, {
      ...(keep !== undefined ? { keep } : {}),
      dryRun: !confirm,
    });
    return {
      ok: true,
      // dryRun 口径=「没落盘」：只读预览与「无需裁剪」都是 true；仅真裁成功改写历史才是 false。
      dryRun: result.dryRun || result.prunedCount === 0,
      summary: buildSummary(result),
      keep: result.keep,
      totalBefore: result.totalBefore,
      prunedCount: result.prunedCount,
      totalAfter: result.totalAfter,
      freedCommits: result.freedCommits,
      ...(result.backupBundlePath ? { backupBundlePath: result.backupBundlePath } : {}),
      ...(result.warnings?.length ? { warnings: result.warnings.map(scrubLocalAbsolutePaths) } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      // 失败=没落盘（真裁在 update-ref 成功前失败会整体回滚），dryRun 恒 true——与「没落盘」口径自洽。
      dryRun: true,
      summary: `${confirm ? "裁剪" : "预览"}操作历史失败：${scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error))}`,
    };
  }
}

const inputSchema = z.object({
  keep: coerceNumber(z.number().int().nonnegative().optional().describe("保留最近多少条快照；省略或 0=默认 200，引擎侧下限夹逼到 20。用户没提数量就别填。")),
  confirm: coerceBoolean(z.boolean().optional().describe("缺省/false=只预览（dry-run）不落盘；只有用户明确说「确认裁剪 / 确认清理快照历史」后才传 true 真裁。")),
});

const outputSchema = z.object({
  ok: z.boolean().describe("是否成功；false 时 summary 含原因。"),
  dryRun: z.boolean().describe("本次是否没有落盘任何改动：只读预览 / 无需裁剪 / 被守卫拦下 / 失败回滚都是 true；仅真裁成功、历史已改写时为 false。"),
  summary: z.string().describe("自然语言结果，供回答用户。"),
  blockedReason: z.string().optional().describe("守卫拦截原因，如本轮用户原话没有确认裁剪意图。"),
  keep: z.number().optional().describe("实际生效的保留条数。"),
  totalBefore: z.number().optional().describe("裁前历史提交总数。"),
  prunedCount: z.number().optional().describe("将裁/已裁的更早快照条数；0=无需裁剪。"),
  totalAfter: z.number().optional().describe("裁后提交总数（预览时为预计值）。"),
  freedCommits: z.number().optional().describe("净释放的提交数。"),
  backupBundlePath: z.string().optional().describe("真裁时裁前完整历史的备份 bundle 路径（项目目录之外）。"),
  warnings: z.array(z.string()).optional().describe("非致命降级警告（如旧对象回收失败），须如实转告。"),
});

export const pruneSnapshotsTool = createTool({
  id: "prune_snapshots",
  description:
    "管理快照操作历史的磁盘占用：把太长的历史裁到最近 keep 条（默认 200、下限 20），更早的折成一条 base 存档点（仍可整体恢复），真裁前自动把裁前完整历史备份到项目目录外。" +
    "【两步】默认只预览（dry-run）、如实回报将裁多少条；只有用户明确说「确认裁剪 / 确认清理快照历史」后才带 confirm:true 真裁（对齐 commit_preview/commit_apply 两步）。" +
    "全程只动快照仓库的 git 引用，工作树/正文分毫不动；不足 keep 条时如实回报无需裁剪。" +
    "confirm=true 有写入前守卫：本轮用户原话没有确认裁剪意图会被拒绝（blockedReason=user_turn_no_prune_confirm_intent）。" +
    "【不在撤销链】undo_last_change 撤不到裁剪（它撤的是内容写操作，裁剪没动工作树）；要回退只能用裁前 bundle 备份 / base 存档点整体恢复——用户说『撤销刚才的裁剪』时如实说明这一点，别拿 undo 顶替。",
  inputSchema,
  outputSchema,
  execute: async (input: z.infer<typeof inputSchema>, context: ToolExecutionContext) => {
    const projectDir = readProjectDirFromContext(context);
    if (!projectDir) {
      throw new Error("prune_snapshots 缺少 projectDir：请确认调用 agent 时通过 RequestContext 注入了 projectDir。");
    }
    const confirm = input.confirm === true;
    // 意图门只守真裁：预览只读，任何回合都可调；真裁须本轮用户原话带确认意图。
    if (confirm) {
      const userTurnText = readUserTurnTextFromContext(context);
      if (userTurnText !== undefined && !userTurnAllowsSnapshotPrune(userTurnText)) {
        console.warn("[turn-intent-gate] 拦下未授权 prune_snapshots confirm=true（本轮用户原话无确认裁剪意图）");
        return {
          ok: false,
          dryRun: true,
          blockedReason: "user_turn_no_prune_confirm_intent",
          summary: "本回合用户没有明确说「确认裁剪」，已拦下真裁。先不带 confirm 调本工具做预览，把将裁多少条如实转告用户，等用户明确确认后再带 confirm:true。",
        };
      }
    }
    const keep = positiveOrUndefined(input.keep);
    return runPruneSnapshots(projectDir, { ...(keep !== undefined ? { keep } : {}), confirm });
  },
});
