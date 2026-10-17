import type { ChapterMessage } from "../../../types.js";
import type { AgentUserAction } from "../../../api/agentChatClient.js";
import { cardOf } from "../../../utils/messageCards.js";

/**
 * 「下一步」选项卡数据——只取 agent 主动调 suggest_next_steps 给出的上下文相关提议
 * （lastAssistantNextStepPrompt）。2026-06-23 删掉了按 flowStatus 写死的兜底选项：那套死选项
 * 不看本章具体情况、还会和 agent 正文打架，正是 suggest_next_steps 当初要治的病。agent 没提议的
 * 回合就不出卡（顺着正文走或直接打字）。
 *
 * 选项点击 = 给 agent 发一句**自然语言意图**（intent），驱动它调对应工具；引导≠强制，可直接打字无视。
 * 例外（R4.7）：服务端自己生成的确定性选项带 action——点击直接发结构化动作（body.action），不经模型。
 */

export interface NextStepChoice {
  readonly label: string;
  /** 点击后作为一条用户消息发给 agent（对话里会留下「你：…」，再由 agent 接着做）。 */
  readonly intent: string;
  readonly primary?: boolean;
  /** 结构化动作（R4.7）：服务端生成的确定性选项才有——点击直接发 body.action，不发文本给模型。
   *  模型 suggest_next_steps 生成的选项没有 action，照旧走 intent 文本。 */
  readonly action?: AgentUserAction;
}

export interface NextStepPrompt {
  readonly question: string;
  readonly choices: readonly NextStepChoice[];
}

/**
 * 取「最近一条 assistant 消息」上 agent 主动提议的下一步选项（suggest_next_steps），转成渲染用的 NextStepPrompt
 * （recommended→primary）。最近的 assistant 消息没提议 → 返回 null（调用方据此退回按 flowStatus 写死的兜底，不翻更老的消息）。
 */
export function lastAssistantNextStepPrompt(messages: readonly ChapterMessage[]): NextStepPrompt | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const prompt = cardOf(message, "next-steps")?.prompt;
    if (!prompt || prompt.choices.length === 0) return null;
    return {
      question: prompt.question,
      choices: prompt.choices.map((choice) => ({
        label: choice.label,
        intent: choice.intent,
        ...(choice.recommended ? { primary: true } : {}),
        ...(choice.action ? { action: choice.action } : {}),
      })),
    };
  }
  return null;
}
