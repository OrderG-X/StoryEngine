import { estimateTokens } from "../lib/estimate-tokens.js";
import type { ChapterMessage } from "../type-defs/workspace.js";

/**
 * A2 历史诚实化（治谎报回灌·配合 A3 全书磁盘真相双保险）：assistant 回合若带「失败」的工具步骤，
 * 说明它当轮可能没真做成事，给文本前加一条中性失败标注，让下一轮/新会话读历史时不把上一轮的
 * 「已生成/已入库」谎报当真——以工具结果与磁盘真相为准。纯确定性、题材中立。
 */
export function annotateOutboundContent(m: ChapterMessage & { role: "user" | "assistant" }): string {
  const base = m.content;
  if (m.role !== "assistant") return base;
  const hadFailedTool = m.toolSteps?.some((s) => s.status === "failed") ?? false;
  if (!hadFailedTool) return base;
  return `（上一轮注：本回合有工具调用失败/未成功，磁盘未必有对应产物——下面这段叙述若声称「已生成/已写入/已定稿/已入库」请勿当真，一切以工具结果与磁盘真相为准。）\n${base}`;
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
