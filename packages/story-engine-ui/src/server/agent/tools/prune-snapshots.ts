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
 * 授权（2026-10-07 起，与「确认定稿」同一套结构化动作）：模型调用一律只预览；有可裁内容时给用户出
 * 「确认裁剪」按钮（needsConfirmation + confirmAction），用户点了按钮服务端才带确认标记真裁。
 * 不再用正则去猜用户原话是不是「确认裁剪」。
 */
import { createTool } from "@mastra/core/tools";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { z } from "zod";

import { pruneSnapshots, type SnapshotPruneResult } from "../../lib/snapshot.js";
import { scrubLocalAbsolutePaths } from "../../lib/local-path-scrubber.js";
import { isUserConfirmedTool, readProjectDirFromContext } from "../request-context.js";
import { coerceBoolean, coerceNumber, positiveOrUndefined } from "../../lib/lenient-args.js";

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
  readonly needsConfirmation?: boolean;
  readonly confirmAction?: { readonly toolName: "prune_snapshots"; readonly keep?: number };
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
    return `预览：当前操作历史共 ${totalBefore} 条，裁剪后将保留最近 ${keep} 条——更早 ${prunedCount} 条折成一条存档点（仍可整体恢复到那里），净释放 ${freedCommits} 条提交，裁后共 ${totalAfter} 条。确认要裁就点下面的「确认裁剪」按钮；真裁前会把裁前完整历史自动备份到项目目录外。`;
  }
  // warnings 内嵌的 git 报错可能带绝对路径，进 summary 前同款消毒
  const warningsText = result.warnings?.length ? ` 注意：${result.warnings.map(scrubLocalAbsolutePaths).join("；")}` : "";
  return `已把操作历史裁到最近 ${keep} 条：更早 ${prunedCount} 条折成一条「base」存档点（仍可整体恢复到那里），净释放 ${freedCommits} 条提交，裁后共 ${totalAfter} 条。裁前完整历史已备份到项目目录外的 snapshot-backups 目录。注意：这一步不在「撤销上一步」链上（裁剪没动工作树、没有可撤的内容变更），要回退只能用备份 bundle / base 存档点整体恢复。${warningsText}`;
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
  blockedReason: z.string().optional().describe("守卫拦截原因，如还等作者点「确认裁剪」。"),
  keep: z.number().optional().describe("实际生效的保留条数。"),
  totalBefore: z.number().optional().describe("裁前历史提交总数。"),
  prunedCount: z.number().optional().describe("将裁/已裁的更早快照条数；0=无需裁剪。"),
  totalAfter: z.number().optional().describe("裁后提交总数（预览时为预计值）。"),
  freedCommits: z.number().optional().describe("净释放的提交数。"),
  needsConfirmation: z.boolean().optional().describe("true=只做了预览、没有裁；界面已给用户出「确认裁剪」按钮，用户点了系统才真裁。"),
  confirmAction: z.object({
    toolName: z.literal("prune_snapshots"),
    keep: z.number().optional(),
  }).optional().describe("「确认裁剪」按钮携带的结构化动作（前端用，你不用管）。"),
  backupBundlePath: z.string().optional().describe("真裁时裁前完整历史的备份 bundle 路径（项目目录之外）。"),
  warnings: z.array(z.string()).optional().describe("非致命降级警告（如旧对象回收失败），须如实转告。"),
});

export const pruneSnapshotsTool = createTool({
  id: "prune_snapshots",
  description:
    "把太长的操作历史裁到最近 keep 条（默认 200），正文和资料不动，裁前完整历史自动备份。你调用永远只预览；有可裁的界面会出「确认裁剪」按钮，用户点了才真裁，别说成已裁剪。",
  inputSchema,
  outputSchema,
  execute: async (input: z.infer<typeof inputSchema>, context: ToolExecutionContext) => {
    const projectDir = readProjectDirFromContext(context);
    if (!projectDir) {
      throw new Error("prune_snapshots 缺少 projectDir：请确认调用 agent 时通过 RequestContext 注入了 projectDir。");
    }
    const keep = positiveOrUndefined(input.keep);
    // 只有用户点了「确认裁剪」按钮（结构化动作带确认标记）才真裁；模型自己发起的调用一律只预览。
    if (input.confirm === true && isUserConfirmedTool(context, "prune_snapshots")) {
      return runPruneSnapshots(projectDir, { ...(keep !== undefined ? { keep } : {}), confirm: true });
    }
    const preview = await runPruneSnapshots(projectDir, { ...(keep !== undefined ? { keep } : {}), confirm: false });
    if (!preview.ok || (preview.prunedCount ?? 0) <= 0) return preview;
    return {
      ...preview,
      needsConfirmation: true,
      confirmAction: { toolName: "prune_snapshots" as const, ...(keep !== undefined ? { keep } : {}) },
    };
  },
});
