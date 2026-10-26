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
import { coerceBoolean, coerceJsonArray } from "../../lib/lenient-args.js";

const choiceSchema = z.object({
  label: z.string().trim().min(1).describe("按钮短文案。"),
  intent: z.string().trim().min(1).describe("用户点了以后发回给你的一句话。"),
  recommended: coerceBoolean(z.boolean().optional().describe("推荐项，至多一个。")),
});

/** 模型无关：多给了几个、只给了字、少写 intent 都别整步拒掉——边界里归一（见 normalizeChoices）。 */
const choiceInputSchema = z.union([
  z.string(),
  z.object({
    label: z.string().optional(),
    intent: z.string().optional(),
    recommended: coerceBoolean(z.boolean().optional()),
  }),
]);

const MAX_CHOICES = 4;
const DEFAULT_QUESTION = "接下来？";

const inputSchema = z.object({
  question: z.string().trim().optional().describe("一句话问用户接下来想怎么走（如『这章定稿了，接下来？』）。"),
  choices: coerceJsonArray(z.array(choiceInputSchema).describe("2–4 个选项，留一个『我自己说』兜底。")).optional(),
});

type Choice = z.infer<typeof choiceSchema>;

/** 只给了字的当按钮文案也当发回的话；没写 intent 的用 label；没文案的丢掉；超过 4 个留前 4 个（推荐项排在后面也留下）。 */
export function normalizeChoices(raw: readonly z.infer<typeof choiceInputSchema>[]): Choice[] {
  const choices: Choice[] = [];
  for (const item of raw) {
    const label = (typeof item === "string" ? item : item.label ?? "").trim();
    if (!label) continue;
    const intent = (typeof item === "string" ? "" : item.intent ?? "").trim() || label;
    choices.push({ label, intent, ...(typeof item !== "string" && item.recommended ? { recommended: true } : {}) });
  }
  if (choices.length <= MAX_CHOICES) return choices;
  const recommended = choices.findIndex((choice) => choice.recommended);
  if (recommended < MAX_CHOICES) return choices.slice(0, MAX_CHOICES);
  return [...choices.slice(0, MAX_CHOICES - 1), choices[recommended] as Choice];
}

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
    const choices = normalizeChoices(input.choices ?? []);
    // 模型无关：给了选项、漏了问句，用中性问句补上，别整步拒掉。
    const question = input.question?.trim() || (choices.length > 0 ? DEFAULT_QUESTION : undefined);

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
