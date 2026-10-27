import { estimateTokens } from "../lib/estimate-tokens.js";
import type { ChapterMessage } from "../type-defs/workspace.js";
import type { ChatHistoryMessage } from "../server/lib/project-io.js";
import { cardOf } from "../utils/messageCards.js";

/** 出定论卡的工具（对话里 settle_fact、核账卡按钮 settle_preview）：卡上点了「不改了」就带上 dropped。 */
const SETTLE_TOOLS: ReadonlySet<string> = new Set(["settle_fact", "settle_preview"]);

/**
 * A2 历史诚实化（治谎报回灌·配合 A3 全书磁盘真相双保险）：发给 AI 的历史带上那条回合调过哪些工具、成没成，
 * 服务端还原成真的工具调用记录（agent-chat 的 historyToModelMessages）。长篇连写走查（2026-10-24）：只有文字的历史里
 * 全是「出清单 → 清单打开了」，模型照着续写回执、一个工具都没调。以前把这层写成回复文字前头的「（上一轮注：…）」，
 * 长篇实跑（2026-10-26）第 17 章模型连注带回执一起照抄、没调工具，所以改成结构化，不往文字里塞。
 * 纯确定性（只看结构化的工具步骤）、题材中立。
 */
export function outboundTools(m: ChapterMessage): ChatHistoryMessage["tools"] {
  if (m.role !== "assistant") return undefined;
  const steps = (m.toolSteps ?? []).filter((s) => s.toolName);
  const names = [...new Set(steps.map((s) => s.toolName!))];
  if (names.length === 0) return undefined;
  const dropped = cardOf(m, "settle")?.dropped === true;
  return names.map((name) => ({
    name,
    ok: !steps.some((s) => s.toolName === name && s.status === "failed"),
    ...(dropped && SETTLE_TOOLS.has(name) ? { dropped: true as const } : {}),
  }));
}

export function buildOutboundConversation(
  messages: readonly ChapterMessage[], archivedCount: number, budgetTokens: number,
): ChatHistoryMessage[] {
  // 界面自己塞的脚手架（「已进入工作台」、流程提示）不是对话，不发给 AI：既不占历史条数，
  // 也不让「只带上最近 N 条」的提示过早出现（P11）。
  const active = messages.slice(Math.max(0, archivedCount))
    .filter((m): m is ChapterMessage & { role: "user" | "assistant" } =>
      (m.role === "user" || m.role === "assistant") && m.kind !== "scaffolding")
    .map((m): ChatHistoryMessage => {
      const tools = outboundTools(m);
      return tools ? { role: m.role, content: m.content, tools } : { role: m.role, content: m.content };
    });
  let start = 0;
  while (start < active.length - 1
    && estimateTokens(active.slice(start).map((m) => m.content).join("\n")) > budgetTokens) {
    start++;
  }
  return active.slice(start);
}
