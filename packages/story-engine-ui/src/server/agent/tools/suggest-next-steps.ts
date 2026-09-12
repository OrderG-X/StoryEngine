/**
 * suggest_next_steps — agent 主动把「接下来想让用户选的下一步」结构化吐出来，前端渲染成可点的「下一步」选项卡。
 *
 * 为什么要这个工具：原本「下一步」选项是 UI 按 flowStatus 写死的，看不到 agent 看到的上下文
 * （比如资料有缺口、本章具体情况），经常和 agent 自己说的话打架（agent 问"要不要先补资料"、
 * 卡片却推"开始写下一章"）。让 agent 调这个工具来定选项 → 卡片永远和 agent 的提议一致。
 *
 * 纯声明、无副作用、题材中立：不读写项目，只把 (question, choices) 原样回传，作为流到前端的数据通道。
 * 前端把它挂到这条消息上、渲染选项；agent 没调这个工具时，前端退回按 flowStatus 写死的兜底选项。
 */
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { coerceBoolean, coerceJsonArray } from "./lenient-args.js";

const choiceSchema = z.object({
  label: z.string().trim().min(1).describe("按钮短文案（如『先补地点和资产』『开始写第二章』『先放着』）。"),
  intent: z.string().trim().min(1).describe("用户点这个按钮后，作为一句话发回给你的意图，你据此继续做事（如『帮我把地点和资产补上』）。"),
  recommended: coerceBoolean(z.boolean().optional().describe("是否为推荐项（这一步最顺的选择）；至多一个标 true。")),
});

const inputSchema = z.object({
  question: z.string().trim().optional().describe("一句话问用户接下来想怎么走（如『这章定稿了，接下来？』）。"),
  choices: coerceJsonArray(z.array(choiceSchema).max(4).describe("2–4 个下一步选项；建议含一个推荐项，并留一个『先放着/我自己说』之类的兜底。")).optional(),
});

const outputSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    question: z.string(),
    choices: z.array(choiceSchema),
  }),
  z.object({
    ok: z.literal(false),
    summary: z.string(),
    question: z.string().optional(),
    choices: z.array(choiceSchema).optional(),
  }),
]);

export const suggestNextStepsTool = createTool({
  id: "suggest_next_steps",
  description:
    "把你想让用户选的『下一步』结构化吐出来，前端会渲染成可点的选项卡（点了就把对应 intent 当作用户消息发回给你）。" +
    "在你做完一步、想引导用户选下一步时调用——尤其当『下一步』取决于上下文（如资料有缺口、是否该先补）时，" +
    "用它让选项贴合你真实的建议，别让用户面对和你说的话不一致的写死选项。只声明选项、不执行动作。",
  inputSchema,
  outputSchema,
  execute: async (input: z.infer<typeof inputSchema>) => {
    const question = input.question?.trim();
    const choices = input.choices ?? [];

    if (!question || choices.length === 0) {
      return {
        ok: false as const,
        summary: "下一步选项不完整：缺少 question 或 choices，未生成下一步卡片；请重新给出问题和 1–4 个选项。",
        question,
        choices,
      };
    }

    return {
      ok: true as const,
      question,
      choices,
    };
  },
});
