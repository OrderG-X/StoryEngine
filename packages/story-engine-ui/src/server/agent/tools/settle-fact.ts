/**
 * settle_fact — 作者在对话里定下一个说法（「杜叔是十年前走的，以这个为准」）：查全书哪几句和它对不上，
 * 出一张定论卡（和核账卡上「以第 N 章为准」出的同一张）。只出预览、不改书；作者在卡上点「确认」才一次改齐（作者档、可撤销）。
 * 绝不静默失败：模型没查成、哪几章没查全都如实写在结果里。
 */
import { createTool, type ToolExecutionContext } from "@mastra/core/tools";
import { z } from "zod";
import { CANON_TEXT_MAX } from "@actalk/story-core";
import { blankToUndefined, coerceNumber } from "../../lib/lenient-args.js";
import { readProjectDirFromContext, resolveChapterFromInputOrContext } from "../request-context.js";
import { previewSettle } from "../settle-actions.js";

const inputSchema = z.object({
  canon: z.string().trim().min(1).max(CANON_TEXT_MAX).describe("作者定下的说法，尽量用作者的原话（一句话说清是什么，如『杜长顺十年前去世』）。"),
  chapter: coerceNumber(blankToUndefined(z.number().int().positive().optional().describe("作者此刻在写的章号；缺省用当前章。这一章有工作稿时连工作稿一起查。"))),
});

const outputSchema = z.object({
  ok: z.boolean(),
  summary: z.string(),
  settle: z.unknown().optional(),
});

export const settleFactTool = createTool({
  id: "settle_fact",
  description:
    "作者定下某个说法、要全书以它为准时调用（如『杜叔是十年前走的，以这个为准』『前面写错了，统一成……』『那条定论过时了，改成……』）：" +
    "查全书哪几句和它对不上、设定本和账里哪些要跟着改，出一张定论卡给作者看（改的是设定本里已有的定论时，卡上会换掉旧的那条）。只出预览、不改任何东西；作者在卡上点「确认」才改齐。" +
    "只在作者明说要定下来时调，别替作者定。",
  inputSchema,
  outputSchema,
  execute: async (input: z.infer<typeof inputSchema>, context: ToolExecutionContext) => {
    const projectDir = readProjectDirFromContext(context);
    if (!projectDir) throw new Error("settle_fact 缺少 projectDir：请确认 RequestContext 注入了 projectDir。");
    const chapter = resolveChapterFromInputOrContext(input.chapter, context);
    const preview = await previewSettle(projectDir, { kind: "statement", text: input.canon, ...(chapter !== undefined ? { chapter } : {}) });
    // 卡上那句话不念定论（卡上有）；给对话 AI 的要带上，它才知道卡上记的是哪一条（可能是设定本里已有的整条）。
    return preview.ok
      ? { ok: true, summary: `定论「${preview.card.canon}」：${preview.summary}`, settle: preview.card }
      : { ok: false, summary: preview.summary };
  },
});
