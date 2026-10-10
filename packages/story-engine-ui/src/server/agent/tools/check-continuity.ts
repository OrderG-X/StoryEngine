/**
 * check_continuity —— 只读工具「核账」（2026-10-10 重新设计「作者写、AI 管账」第 2 期）。
 *
 * 拿这一章（工作稿优先，没有就读已定稿）去对前文原文，找前后对不上的地方：东西在哪 / 在谁手里、人物行踪身份、
 * 时间天数、谁该知道什么。正文对正文（见 continuity-v2/check-chapter.ts），不拿账本当裁判。
 * 结果分「确定」「可能」两档，每条带本章原句和前文原句（含章号）。不改正文、不写账本。
 * 作者点「核账」按钮走结构化动作直达（user-actions），对话里说「核一下」也由 agent 调用。
 */
import { createTool } from "@mastra/core/tools";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { z } from "zod";
import { coerceNumber } from "./lenient-args.js";
import { readDraftContent } from "./read-draft.js";
import { readProjectDirFromContext, resolveChapterFromInputOrContext } from "../request-context.js";
import { callConfiguredCheckerModel, checkChapterContinuity, type ContinuityIssueV2 } from "../continuity-v2/check-chapter.js";
import { isDismissed, readDismissals } from "../continuity-v2/dismissals.js";

const issueSchema = z.object({
  quote: z.string().describe("本章里有问题的那一句（原文）。"),
  earlierQuote: z.string().describe("和它对不上的前文那一句（原文）。"),
  earlierChapter: z.number().int().describe("前文那句在第几章（等于本章章号表示本章更早处）。"),
  reason: z.string().describe("哪里对不上（一句话）。"),
});

const outputSchema = z.object({
  ok: z.boolean().describe("核账是否跑成。"),
  chapter: z.number().int(),
  source: z.enum(["draft", "committed"]).nullable().describe("核的是工作稿还是已定稿正文。"),
  sure: z.array(issueSchema).describe("确定对不上的地方（排在前面给作者看）。"),
  maybe: z.array(issueSchema).describe("可能对不上的地方（作者自己判断）。"),
  failures: z.array(z.string()).describe("没跑成的步骤（如实说明）。"),
  dismissed: z.number().int().describe("作者以前标过「不是问题」、这次没再报的条数。"),
  summary: z.string().describe("给作者看的一句话结论。"),
});

export type CheckContinuityToolOutput = z.infer<typeof outputSchema>;

const toItem = (issue: ContinuityIssueV2) => ({
  quote: issue.quote,
  earlierQuote: issue.earlierQuote,
  earlierChapter: issue.earlierChapter,
  reason: issue.reason,
});

export async function runCheckContinuity(projectDir: string, chapter: number): Promise<CheckContinuityToolOutput> {
  const draft = await readDraftContent({ projectDir, chapter });
  if (!draft.found || !draft.content.trim()) {
    return {
      ok: false,
      chapter,
      source: null,
      sure: [],
      maybe: [],
      failures: [],
      dismissed: 0,
      summary: `第 ${chapter} 章还没有正文，没法核账。`,
    };
  }
  const body = draft.content.replace(/^#[^\n]*\n/u, "").trim();
  const result = await checkChapterContinuity({ projectDir, chapter, draftBody: body, callModel: callConfiguredCheckerModel });
  // 作者点过「不是问题」的不再报（只认同一章、两边原句都对得上的）。
  const dismissals = await readDismissals(projectDir);
  const shown = result.issues.filter((issue) => !isDismissed(chapter, issue, dismissals));
  const dismissed = result.issues.length - shown.length;
  const sure = shown.filter((issue) => issue.confidence === "sure").map(toItem);
  const maybe = shown.filter((issue) => issue.confidence !== "sure").map(toItem);
  const ok = result.failures.length === 0 || result.issues.length > 0;
  const where = (issue: { readonly earlierChapter: number }) => (issue.earlierChapter === chapter ? "本章前文" : `第 ${issue.earlierChapter} 章`);
  const dismissedNote = dismissed > 0 ? `（另有 ${dismissed} 处你标过「不是问题」，没再报。）` : "";
  const summary = !ok
    ? `第 ${chapter} 章核账没跑成：${result.failures[0] ?? "原因不明"}。可以再点一次「核账」。`
    : sure.length + maybe.length === 0
      ? `核了第 ${chapter} 章，没发现和前文对不上的地方。${dismissedNote}${result.failures.length > 0 ? `（有一步没跑成：${result.failures[0]}）` : ""}`
      : [
        `核了第 ${chapter} 章：确定对不上 ${sure.length} 处${maybe.length > 0 ? `，可能有问题 ${maybe.length} 处` : ""}。${dismissedNote}`,
        ...sure.slice(0, 3).map((issue) => `· 「${issue.quote.slice(0, 40)}」和${where(issue)}「${issue.earlierQuote.slice(0, 40)}」：${issue.reason}`),
      ].join("\n");
  return { ok, chapter, source: draft.source, sure, maybe, failures: [...result.failures], dismissed, summary };
}

const inputSchema = z.object({
  chapter: coerceNumber(z.number().int().positive().optional().describe("要核哪一章；省略时默认用户当前所在章。")),
});

export const checkContinuityTool = createTool({
  id: "check_continuity",
  description:
    "核账：拿这一章（工作稿优先，没有就读已定稿）去对前文原文，找前后对不上的地方（东西在哪、在谁手里、人物行踪身份、时间天数、谁该知道什么）。" +
    "只读，不改正文、不写账本。结果分「确定」「可能」两档，每条带本章原句和前文原句。" +
    "作者说「核账 / 查一下前后对不对 / 有没有吃书 / 有没有穿帮」时用。转述时先说确定的几处，可能的让作者自己看卡片。",
  inputSchema,
  outputSchema,
  execute: async (input: z.infer<typeof inputSchema>, context: ToolExecutionContext) => {
    const projectDir = readProjectDirFromContext(context);
    if (!projectDir) throw new Error("没有打开的书，没法核账。");
    const chapter = resolveChapterFromInputOrContext(input.chapter, context);
    if (chapter === undefined) throw new Error("不知道要核哪一章：请说一下章号。");
    return runCheckContinuity(projectDir, chapter);
  },
});
