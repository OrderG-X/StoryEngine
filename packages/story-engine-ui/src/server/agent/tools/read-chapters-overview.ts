/**
 * read_chapters_overview — 只读工具：列出全书每一章的状态（空 / 有草稿未入库 / 已入库，含标题）。
 *
 * 给 agent 一张「全书章节地图」，让它在跨章操作或判断进度时不靠猜（⑤治本：当前章无从下手时
 * 别再回退到历史里更具体的旧章）。只读盘、题材中立（状态是确定性枚举、标题取自文件、无任何题材词）、
 * 不建快照、不带 refreshScope（不触发前端刷新）。绝不静默失败：返回 ok 字段。
 */
import { createTool } from "@mastra/core/tools";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { z } from "zod";

import { readProjectDirFromContext } from "../request-context.js";
import { readUiChapterFileStates, type UiChapterFileState } from "../../lib/project-io.js";

const inputSchema = z.object({});

const outputSchema = z.object({
  ok: z.boolean(),
  chapters: z.array(z.object({
    chapter: z.number().int().positive(),
    status: z.enum(["committed", "draft", "empty"]),
    title: z.string().optional(),
  })),
  summary: z.string(),
});

function statusOf(state: UiChapterFileState): "committed" | "draft" | "empty" {
  if (state.hasCommittedChapter) return "committed";
  // 「有草稿」只认真草稿：.md 有真内容，或 workspace 里有真草稿。光「开过」(hasWorkspaceSnapshot) 不算，
  // 否则空章会谎报「有草稿未入库」（真机实测 bug 根因之一）。
  if (state.hasDraftFile || state.hasWorkspaceDraft) return "draft";
  return "empty";
}

export const readChaptersOverviewTool = createTool({
  id: "read_chapters_overview",
  description:
    "列出全书每一章的状态（空 / 有工作稿未定稿 / 已定稿，含标题）。" +
    "当你需要全书进度地图——判断下一章是第几、某章写到哪、用户说『继续』时本章或相邻章是什么状态——调用本工具拿真实数据，不要凭印象猜。只读，不改任何东西。",
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
      const title = state.committedTitle ?? state.draftTitle ?? state.workspaceTitle;
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
    return { ok: true, chapters, summary };
  },
});
