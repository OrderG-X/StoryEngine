import { estimateTokens } from "../lib/estimate-tokens.js";
import type { ChapterMessage } from "../type-defs/workspace.js";

/**
 * A2 历史诚实化（治谎报回灌·配合 A3 全书磁盘真相双保险）：发给 AI 的历史只有文字，看不出哪句回执是调工具做成的。
 * - 调过工具的 assistant 回合：文本前注明调了哪些工具。长篇连写走查（2026-10-24）：作者一路点按钮，最近 12 条全是
 *   「出清单 → 清单打开了」这种不带工具痕迹的一问一答，模型照着续写「清单已出，请点确认定稿」、一个工具都没调。
 * - 带「失败」工具步骤的回合：再加一条中性失败标注，不把上一轮的「已生成/已入库」谎报当真。
 * 纯确定性（只看结构化的工具步骤）、题材中立。
 */
export function annotateOutboundContent(m: ChapterMessage & { role: "user" | "assistant" }): string {
  const base = m.content;
  if (m.role !== "assistant") return base;
  const tools = [...new Set((m.toolSteps ?? []).flatMap((s) => (s.toolName ? [s.toolName] : [])))];
  const hadFailedTool = m.toolSteps?.some((s) => s.status === "failed") ?? false;
  const notes = [
    ...(tools.length > 0 ? [`（上一轮注：这一回合的结果是调工具 ${tools.join("、")} 做出来的；要同样的结果，这一轮也得真调工具，没调就是没做。）`] : []),
    ...(hadFailedTool ? ["（上一轮注：本回合有工具调用失败/未成功，磁盘未必有对应产物——下面这段叙述若声称「已生成/已写入/已定稿/已入库」请勿当真，一切以工具结果与磁盘真相为准。）"] : []),
  ];
  return notes.length > 0 ? `${notes.join("\n")}\n${base}` : base;
}

export function buildOutboundConversation(
  messages: readonly ChapterMessage[], archivedCount: number, budgetTokens: number,
): { role: "user" | "assistant"; content: string }[] {
  // 界面自己塞的脚手架（「已进入工作台」、流程提示）不是对话，不发给 AI：既不占历史条数，
  // 也不让「只带上最近 N 条」的提示过早出现（P11）。
  const active = messages.slice(Math.max(0, archivedCount))
    .filter((m): m is ChapterMessage & { role: "user" | "assistant" } =>
      (m.role === "user" || m.role === "assistant") && m.kind !== "scaffolding")
    .map((m) => ({
      role: m.role,
      content: annotateOutboundContent(m),
    }));
  let start = 0;
  while (start < active.length - 1
    && estimateTokens(active.slice(start).map((m) => m.content).join("\n")) > budgetTokens) {
    start++;
  }
  return active.slice(start);
}
