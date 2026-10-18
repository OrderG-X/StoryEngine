/**
 * read_timeline — 只读工具：查询 timeline/events.json 里某章或某区间的事件。
 *
 * 让 agent 在想了解「早期某章/某段发生了啥」时有精确的只读查询入口，
 * 而不必依赖 read_state_overview 里被截断的近章视窗。
 * 只读盘、题材中立、不建快照、不带 refreshScope（不触发前端刷新）。
 * 绝不静默失败：返回 ok 字段。
 */
import { createTool } from "@mastra/core/tools";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { z } from "zod";
import { coerceNumber } from "../../lib/lenient-args.js";

import { readTimelineEvents } from "../../book/project-store.js";
import { readCharacterNameById, resolveEntityLabels, resolveSemanticSummaryLabels } from "../../writing/presence/entity-labels.js";
import { readProjectDirFromContext, resolveChapterFromInputOrContext } from "../request-context.js";

const inputSchema = z.object({
  chapter: coerceNumber(z.number().int().positive().optional().describe(
    "查某一章。",
  )),
  fromChapter: coerceNumber(z.number().int().positive().optional().describe(
    "区间起始章（含）。",
  )),
  toChapter: coerceNumber(z.number().int().positive().optional().describe(
    "区间结束章（含）。",
  )),
});

const outputSchema = z.object({
  ok: z.boolean(),
  events: z.array(z.object({
    chapter: z.number(),
    id: z.string(),
    summary: z.string(),
    mainEvent: z.string().optional(),
    participants: z.array(z.string()),
    semanticSummary: z.record(z.string(), z.unknown()).optional(),
  })),
  summary: z.string(),
  error: z.string().optional(),
});

export const readTimelineTool = createTool({
  id: "read_timeline",
  description:
    "查询某章或某区间的 timeline 事件（含 summary、mainEvent、参与角色等）。" +
    "当你需要了解早期某章/某段发生了啥——比如第 2 章的伏笔、某角色第一次出场时的状态——调用本工具精确查询，" +
    "不依赖 read_state_overview 里只能看到近章的窗口。只读，不改任何东西。",
  inputSchema,
  outputSchema,
  execute: async (input: z.infer<typeof inputSchema>, context: ToolExecutionContext) => {
    const projectDir = readProjectDirFromContext(context);
    if (!projectDir) {
      throw new Error(
        "read_timeline 缺少 projectDir：请确认调用 agent 时通过 RequestContext 注入了 projectDir。",
      );
    }

    try {
      const allEvents = await readTimelineEvents(projectDir);
      // allEvents 必须是数组，防御非法返回值
      const safeEvents = Array.isArray(allEvents) ? allEvents : [];
      // 模型无关·绝不泄露裸 id：participants 是裸 char-id（char-xxxx）——解析成角色名再交给模型/用户，
      // 否则模型转述「参与者：char-ffe5af」（长篇回看早章是高频路径）。
      const nameById = await readCharacterNameById(projectDir);

      // 解析查询范围
      // 只有在「没有传区间参数」时才让 context 章号作为 chapter 的兜底；
      // 若 caller 传了 fromChapter/toChapter，context 章号绝不覆盖区间查询。
      const resolvedChapter =
        (input.fromChapter === undefined && input.toChapter === undefined)
          ? resolveChapterFromInputOrContext(input.chapter, context)
          : input.chapter; // 传了区间参数时只用明确传入的 chapter（通常为 undefined）

      let fromChapter: number | undefined;
      let toChapter: number | undefined;

      if (resolvedChapter !== undefined) {
        // 单章模式（显式传 chapter，或无区间参数时 context 兜底）
        fromChapter = resolvedChapter;
        toChapter = resolvedChapter;
      } else if (input.fromChapter !== undefined || input.toChapter !== undefined) {
        // 区间模式（传了 fromChapter/toChapter，且没有传 chapter）
        fromChapter = input.fromChapter;
        toChapter = input.toChapter;
      }
      // 若没有任何章号约束，返回全部事件

      const filtered = safeEvents.filter((evt) => {
        if (fromChapter !== undefined && evt.chapter < fromChapter) return false;
        if (toChapter !== undefined && evt.chapter > toChapter) return false;
        return true;
      }).sort((a, b) => a.chapter - b.chapter);

      const events = filtered.map((evt) => {
        const sem = evt.effects?.semanticSummary;
        const mainEvent =
          sem && typeof sem === "object" && "mainEvent" in sem && typeof (sem as Record<string, unknown>)["mainEvent"] === "string"
            ? (sem as Record<string, unknown>)["mainEvent"] as string
            : undefined;
        return {
          chapter: evt.chapter,
          id: evt.id,
          summary: evt.summary,
          ...(mainEvent ? { mainEvent } : {}),
          participants: resolveEntityLabels(evt.participants ?? [], nameById),
          ...(sem && typeof sem === "object" ? { semanticSummary: resolveSemanticSummaryLabels(sem as Record<string, unknown>, nameById) } : {}),
        };
      });

      const rangeDesc =
        fromChapter !== undefined && toChapter !== undefined
          ? fromChapter === toChapter
            ? `第 ${fromChapter} 章`
            : `第 ${fromChapter}–${toChapter} 章`
          : "全书";

      const summary =
        events.length === 0
          ? `${rangeDesc}没有 timeline 事件。`
          : `${rangeDesc}共找到 ${events.length} 条 timeline 事件。`;

      return { ok: true as const, events, summary };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false as const, events: [], summary: `读取 timeline 失败：${message}`, error: message };
    }
  },
});
