/**
 * 回合收尾一句话：模型做完事直接结束、没再说话时（如出完稿就停），把最后一步工具自己的结果显示出来，
 * 不让作者对着一行收起的「生成正文」猜成没成。纯展示、确定性：只用工具原话，不补写、不美化。
 *
 * 不显示：回合还在进行；最后一段已经是正文；最后一步是读类/建议/自带卡片的工具（卡片里已经说清）；没有结果文字。
 */
import type { ToolStep } from "../../../api/types.js";
import type { FoldedRenderItem } from "./processLogFold.js";

/** 有专门卡片或只读、不需要再补一句的工具。 */
const TAIL_SKIP_TOOLS = new Set([
  "read_state_overview",
  "read_chapters_overview",
  "read_timeline",
  "read_foundation",
  "read_draft",
  "suggest_next_steps",
  "commit_preview",
  "commit_apply",
  "quality_check",
  "ai_review",
  "check_ai_flavor",
  "web_search",
]);

/** 已结束的步骤（成功 / 失败 / 部分完成 / 等确认）才有结果可说；进行中、被停、裁决类不补。 */
const TAIL_STATUSES = new Set<ToolStep["status"]>(["completed", "failed", "partial", "needs_confirmation"]);

function lastToolStep(items: readonly FoldedRenderItem[]): ToolStep | null {
  const last = items.at(-1);
  if (!last) return null;
  if (last.kind === "tool") return last.step;
  if (last.kind === "process") {
    for (let i = last.steps.length - 1; i >= 0; i -= 1) {
      const step = last.steps[i]!;
      if (step.kind === "tool") return step.step;
    }
  }
  return null;
}

export function turnTailSummary(items: readonly FoldedRenderItem[] | null, turnFinished: boolean): string | null {
  if (!turnFinished || !items?.length) return null;
  const last = items.at(-1)!;
  if (last.kind === "text") return null;
  const step = lastToolStep(items);
  if (!step || !TAIL_STATUSES.has(step.status)) return null;
  if (step.toolName && TAIL_SKIP_TOOLS.has(step.toolName)) return null;
  const detail = step.detail?.trim();
  return detail ? detail : null;
}
