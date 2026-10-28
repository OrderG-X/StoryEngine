/**
 * check_continuity —— 只读工具「核账」（2026-10-10 重新设计「作者写、AI 管账」第 2 期）。
 *
 * 拿这一章（工作稿优先，没有就读已定稿）去对前文原文，找前后对不上的地方：东西在哪 / 在谁手里、人物行踪身份、
 * 时间天数、谁该知道什么。正文对正文（见 editorial/continuity/check-chapter.ts），不拿账本当裁判。
 * 结果分「确定」「可能」两档，每条带本章原句和前文原句（含章号）。不改正文、不写账本。
 * 作者点「核账」按钮走结构化动作直达（user-actions），对话里说「核一下」也由 agent 调用。
 */
import { createTool } from "@mastra/core/tools";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { z } from "zod";
import { coerceBoolean, coerceNumber } from "../../lib/lenient-args.js";
import { readDraftContent } from "./read-draft.js";
import { readProjectDirFromContext, resolveChapterFromInputOrContext } from "../request-context.js";
import { draftVersionOf, readDraftStamp } from "@actalk/story-core";
import { canReuseCheck, checkChapterBody, type ChapterCheckOptions } from "../../editorial/continuity/check-service.js";
import { rereadBlocker } from "../../editorial/reread-state.js";

const issueSchema = z.object({
  quote: z.string().describe("有问题的那一句（原文）。"),
  earlierQuote: z.string().describe("和它对不上的前文那一句（原文）；对设定本的条目这里是设定原文。"),
  earlierChapter: z.number().int().describe("前文那句在第几章（等于本章章号表示本章更早处）。"),
  reason: z.string().describe("哪里对不上（一句话）。"),
  againstSetting: z.object({
    label: z.string(),
    kind: z.enum(["canon", "story", "character", "place", "item", "lore"]).optional(),
    card: z.string().optional().describe("设定原文落在哪张设定卡上（卡名）。"),
  }).optional().describe("这条对的是设定本（人物卡 / 地点 / 资产 / 世界规则）而不是某一章：earlierQuote 是设定原文。"),
  fixChapter: z.number().int().positive().optional().describe("错在哪一章、按钮就改哪一章（前文章和设定不一致时指向前文那章）；缺省＝本章。"),
  revisited: z.object({ from: z.string() }).optional().describe("这句是上一遍按核账改出来的（from＝改前那句），这遍又报了（两遍说法相反，或上次没改到点上）：已归进「可能」，别再自动改，交作者定。"),
});

const outputSchema = z.object({
  ok: z.boolean().describe("核账是否跑成。"),
  chapter: z.number().int(),
  source: z.enum(["draft", "committed"]).nullable().describe("核的是工作稿还是已定稿正文。"),
  sure: z.array(issueSchema).describe("确定对不上的地方（排在前面给作者看）。"),
  maybe: z.array(issueSchema).describe("可能对不上的地方（作者自己判断）。"),
  earlierOpen: z.array(issueSchema).optional().describe("错在前面某章、之前核账已经报过、作者还没改的：不算这一章的问题，summary 里只提一句，别逐条再念。"),
  failures: z.array(z.string()).describe("没跑成的步骤（如实说明）。"),
  pending: z.object({
    done: z.number().int().describe("已读到第几章。"),
    total: z.number().int().describe("共多少章。"),
  }).optional().describe("只在「还在读、这次没核」时有：核账员读到第 done / total 章。要区分「还在读」和「出错」用这个字段，别解析 failures 文字。（R4.4 冷窗口起「还在读」也照核 ok:true，此字段保留给未来真没核成的情况。）"),
  coverage: z.object({
    mode: z.literal("cold"),
    notedThrough: z.number().int().describe("已读笔记到第几章（0＝一章笔记都还没有）。"),
    rawFrom: z.number().int().describe("这次给了原文的第几章起（0＝一章都没给）。"),
    rawTo: z.number().int().describe("这次给了原文到第几章（含）。"),
  }).optional().describe("冷窗口核账＝核账员还没读完全书也先核（R4.4）：notedThrough / rawFrom～rawTo 说清这次实际对照的范围；summary 已如实说明，转述时别把范围说成全书。"),
  dismissed: z.number().int().describe("作者以前标过「不是问题」、这次没再报的条数。"),
  reused: z.boolean().describe("这一章和前文都没改过，直接用的上次核账结果（没调模型）。"),
  checkedVersion: z.string().optional().describe("核的是工作稿哪一版（版本号，界面据此判断核过后稿子改没改）；核的是已定稿正文时没有。"),
  summary: z.string().describe("给作者看的一句话结论。"),
  headline: z.string().optional().describe("summary 去掉逐条问题、只剩结论那句。"),
});

export type CheckContinuityToolOutput = z.infer<typeof outputSchema>;

/**
 * 只拿上次的核账结果（P11）：AI 出稿时已经核过一遍、结果在核账记忆里，就照那份出核账卡；
 * 记忆对不上（出稿后又去味改过、前文改过）就返回 null——不在作者看不见的地方再调一次模型。
 */
export async function cachedCheckContinuity(projectDir: string, chapter: number): Promise<CheckContinuityToolOutput | null> {
  const draft = await readDraftContent({ projectDir, chapter });
  if (!draft.found || !draft.content.trim()) return null;
  if (!(await canReuseCheck(projectDir, chapter, draft.content.replace(/^#[^\n]*\n/u, "").trim()))) return null;
  return runCheckContinuity(projectDir, chapter);
}

export async function runCheckContinuity(
  projectDir: string,
  chapter: number,
  options: ChapterCheckOptions = {},
): Promise<CheckContinuityToolOutput> {
  // 代次先读、正文后读（和核心 readDraftFile 同一个顺序）：正赶上写，算出的版本号谁都对不上，只会显示「核过后改过稿」。
  const stamp = await readDraftStamp(projectDir, chapter);
  const draft = await readDraftContent({ projectDir, chapter });
  if (!draft.found || !draft.content.trim()) {
    return {
      ok: false,
      chapter,
      source: null,
      sure: [],
      maybe: [],
      earlierOpen: [],
      failures: [],
      dismissed: 0,
      reused: false,
      summary: `第 ${chapter} 章还没有正文，没法核账。`,
    };
  }
  // 导入的书还在通读记账（P8）：前文的账没记全，核出来的「对不上」靠不住。
  const rereading = await rereadBlocker(projectDir, "核账");
  if (rereading) {
    return { ok: false, chapter, source: draft.source, sure: [], maybe: [], earlierOpen: [], failures: [rereading], dismissed: 0, reused: false, summary: rereading };
  }
  const result = await checkChapterBody(projectDir, chapter, draft.content.replace(/^#[^\n]*\n/u, "").trim(), options);
  // 版本号按读到的那份文件算（和核心 draft 的版本同一口径）：界面拿它判断「核过后改过稿」，不拿结果到达那一刻稿纸上的版本
  // （白沙渡试写：AI 出完稿紧接着核账，稿纸还没换上新稿，记成了旧版本，刷新后一直显示「核过后改过稿」）。
  return {
    ...result,
    sure: [...result.sure],
    maybe: [...result.maybe],
    earlierOpen: [...result.earlierOpen],
    failures: [...result.failures],
    source: draft.source,
    ...(draft.source === "draft" ? { checkedVersion: draftVersionOf(draft.content, stamp) } : {}),
  };
}

const inputSchema = z.object({
  chapter: coerceNumber(z.number().int().positive().optional().describe("要核哪一章；省略时默认用户当前所在章。")),
  fresh: coerceBoolean(z.boolean().optional().describe("正文没改也重新核（作者说「再细核一遍」时）。缺省时正文和前文都没改就直接给上次结果。")),
});

export const checkContinuityTool = createTool({
  id: "check_continuity",
  description:
    "核账：拿这一章对账本和全书前文，找前后对不上的地方，分「确定」「可能」两档、两边附原句。只读。问题清单作者在核账卡和稿纸划线上都看得到：转述只说一句结论（几处对不上），别逐条念。",
  inputSchema,
  outputSchema,
  execute: async (input: z.infer<typeof inputSchema>, context: ToolExecutionContext) => {
    const projectDir = readProjectDirFromContext(context);
    if (!projectDir) throw new Error("没有打开的书，没法核账。");
    const chapter = resolveChapterFromInputOrContext(input.chapter, context);
    if (chapter === undefined) throw new Error("不知道要核哪一章：请说一下章号。");
    return runCheckContinuity(projectDir, chapter, { fresh: input.fresh === true });
  },
});
