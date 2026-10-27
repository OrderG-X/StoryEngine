/**
 * read_chapters_overview — 只读工具：列出全书每一章的状态（空 / 有草稿未入库 / 已入库，含标题）。
 *
 * 给 agent 一张「全书章节地图」，让它在跨章操作或判断进度时不靠猜（⑤治本：当前章无从下手时
 * 别再回退到历史里更具体的旧章）。只读盘、题材中立（状态是确定性枚举、标题取自文件、无任何题材词）、
 * 不建快照、不带 refreshScope（不触发前端刷新）。绝不静默失败：返回 ok 字段。
 *
 * 顺带一句节奏诊断（哪几章可能拖 / 赶，和故事地图同一份数、同一种说法），作者问「哪几章拖了」时拿它答，不凭印象。
 */
import { createTool } from "@mastra/core/tools";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { z } from "zod";

import { readProjectDirFromContext } from "../request-context.js";
import { projectBook } from "@actalk/story-core";
import { readUiChapterFileStates, type UiChapterFileState } from "../../lib/project-io.js";
import { readPaceReport } from "../../services/pace-report.js";
import { scrubLocalAbsolutePaths } from "../../lib/local-path-scrubber.js";
import { paceNote } from "../../../lib/pace-text.js";

const inputSchema = z.object({});

const outputSchema = z.object({
  ok: z.boolean(),
  chapters: z.array(z.object({
    chapter: z.number().int().positive(),
    status: z.enum(["committed", "draft", "empty"]),
    title: z.string().optional(),
  })),
  summary: z.string(),
  pace: z.string(),
});

/** 节奏诊断一句话；读不出来如实说，不装作没问题。 */
async function paceLine(projectDir: string): Promise<string> {
  try {
    const projection = await projectBook(projectDir);
    const report = await readPaceReport(projectDir, projection);
    if (!report.typical) return "节奏诊断：能比较的定稿章还太少（或账里记的线索推进太少），先不下结论。";
    if (report.flags.length === 0) return "节奏诊断：按账里每章推进的线索和字数看，没有明显拖或赶的章。";
    return `节奏诊断（按账里每章推进的线索和字数，跟全书平常比；只是「可能」，作者自己判断）：${report.flags.map(paceNote).join("；")}。`;
  } catch (error) {
    return `节奏诊断这次没读出来：${scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error))}`;
  }
}

function statusOf(state: UiChapterFileState): "committed" | "draft" | "empty" {
  if (state.hasCommittedChapter) return "committed";
  // 「有草稿」只认工作稿文件里的真稿（重构 P5：稿子只有这一份；旧版写作台缓存不再更新，不看它）。
  if (state.hasDraftFile) return "draft";
  return "empty";
}

export const readChaptersOverviewTool = createTool({
  id: "read_chapters_overview",
  description:
    "列出全书每一章的状态（空 / 有工作稿未定稿 / 已定稿，含标题），外加一句节奏诊断（哪几章可能拖、可能赶）。" +
    "当你需要全书进度地图——判断下一章是第几、某章写到哪、用户说『继续』时本章或相邻章是什么状态——调用本工具拿真实数据，不要凭印象猜。" +
    "作者问节奏（哪几章拖、哪几章赶）时也调它，照 pace 那句说，别自己另下结论。只读，不改任何东西。",
  inputSchema,
  outputSchema,
  execute: async (_input: z.infer<typeof inputSchema>, context: ToolExecutionContext) => {
    const projectDir = readProjectDirFromContext(context);
    if (!projectDir) {
      throw new Error(
        "read_chapters_overview 缺少 projectDir：请确认调用 agent 时通过 RequestContext 注入了 projectDir。",
      );
    }
    const states = await readUiChapterFileStates(projectDir);
    const chapters = states.map((state) => {
      const title = state.committedTitle ?? state.draftTitle;
      return {
        chapter: state.chapter,
        status: statusOf(state),
        ...(title ? { title } : {}),
      };
    });
    const committed = chapters.filter((c) => c.status === "committed").length;
    const draft = chapters.filter((c) => c.status === "draft").length;
    const maxChapter = chapters.length > 0 ? Math.max(...chapters.map((c) => c.chapter)) : 0;
    const summary = chapters.length === 0
      ? "全书还没有任何章节文件（空书）。"
      : `全书共涉及 ${chapters.length} 章：已定稿 ${committed} 章、有工作稿未定稿 ${draft} 章；当前最大章号 ${maxChapter}。`;
    return { ok: true, chapters, summary, pace: await paceLine(projectDir) };
  },
});
