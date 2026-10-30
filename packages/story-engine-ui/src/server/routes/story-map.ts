/**
 * GET /api/story-map?project= —— 故事地图的数据（重构 P6，草图 ③）：每章第几天 + 谁出场，点格子回原文。
 *
 * 直接读新核心投影：章（故事日、星期、时段、依据、梗概、出场、视角）和人物（每章出场的原句）；
 * 再加节奏诊断（每章推进了几条线索、字数，哪几章可能拖 / 赶）。
 * 天数照全书一个口径出好字（写作版本 P3a：区间、往回接、整章回忆都照实说；book/story-timeline 那一套）。
 */
import { isExact, offsetText, projectBook, timelineTable, type BookProjection, type PaceReport, type TimelineRow } from "@actalk/story-core";
import { guardProjectPath, writeJson, type MiddlewareStack } from "../lib/project-io.js";
import { scrubLocalAbsolutePaths } from "../lib/local-path-scrubber.js";
import { ensureBookOnCore } from "../book/ensure-on-core.js";
import { coreSnapshotFor } from "../lib/snapshot.js";
import { readPaceReport } from "../services/pace-report.js";
import { storySpanText } from "../book/story-timeline.js";

export interface StoryMapChapter {
  readonly chapter: number;
  /** 这章的账没记全：pending = 还没记上（格子显示「账待记」）；partial = 记了一部分（天数没记上时格子显示「账没记全」）。 */
  readonly ledgerShort?: "pending" | "partial";
  /** 在不在当下线上：false = 整章是回忆、梦这类（不占故事天数）；unknown = 没认出来。 */
  readonly presentLine: true | false | "unknown";
  /** 故事哪几天（「第 5 天」「第 5～6 天」「第 5 天到第 6 天」「第 5 天以后」）；不知道就没有。 */
  readonly days?: string;
  /** 天数是按旧账推的、不算准：说明。 */
  readonly unsure?: string;
  /** 和上一个当下章之间值得标的间隔：「过了 4 天」「往回 2 天」「6 个月后」（隔天、同一天、说不准不标）。 */
  readonly gap?: string;
  /** 0 = 周一 … 6 = 周日。 */
  readonly weekday?: number;
  readonly weekdayDerived: boolean;
  readonly timeOfDay?: string;
  /** 本章里不在当下的段：「回忆（3 年前）」「梦、想象或传闻」。 */
  readonly segments: readonly string[];
  readonly summary?: string;
  readonly present: readonly string[];
  readonly viewpoint?: string;
}

export interface StoryMapMember {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly viewpointChapters: readonly number[];
  readonly appearances: readonly { readonly chapter: number; readonly quote: string }[];
}

export interface StoryMap {
  readonly upTo: number;
  readonly chapters: readonly StoryMapChapter[];
  /** 故事走到第几天：结尾确定的当下章里最晚的那天（往回接的章不往回拉，不知道哪天的章不往上加）。 */
  readonly lastDay?: number;
  /** 出场章数多的在前；一样多时当过视角的在前（多半是主角）。 */
  readonly cast: readonly StoryMapMember[];
  /** 节奏诊断：每章推进了几条、字数，哪几章可能拖 / 赶。 */
  readonly pace?: PaceReport;
}

function daysOf(row: TimelineRow): string | undefined {
  return row.presentLine === true ? storySpanText(row) : undefined;
}

function gapOf(row: TimelineRow): string | undefined {
  if (row.presentLine !== true) return undefined;
  if (row.relativeText) return offsetText(row.relativeText);
  if (!isExact(row.sincePrevious)) return undefined;
  const days = row.sincePrevious.lo;
  if (days < 0) return `往回 ${-days} 天`;
  return days >= 2 ? `过了 ${days} 天` : undefined;
}

export function toStoryMap(projection: Pick<BookProjection, "upTo" | "chapters" | "cast">): StoryMap {
  const rows = new Map(timelineTable(projection as BookProjection).map((row) => [row.chapter, row]));
  const ends = [...rows.values()].flatMap((row) => (row.presentLine === true && isExact(row.end) ? [row.end.lo] : []));
  return {
    upTo: projection.upTo,
    ...(ends.length > 0 ? { lastDay: Math.max(...ends) } : {}),
    chapters: projection.chapters.map((chapter) => {
      const row = rows.get(chapter.chapter)!;
      const days = daysOf(row);
      const gap = gapOf(row);
      return {
        chapter: chapter.chapter,
        ...(chapter.ledgerStatus !== "ready" ? { ledgerShort: chapter.ledgerStatus } : {}),
        presentLine: row.presentLine,
        ...(days ? { days } : {}),
        ...(days && row.presumed ? { unsure: "按旧账推的，不算准" } : {}),
        ...(gap ? { gap } : {}),
        ...(row.weekday !== undefined ? { weekday: row.weekday } : {}),
        weekdayDerived: row.weekdayDerived,
        ...(row.timeOfDay ? { timeOfDay: row.timeOfDay } : {}),
        segments: row.segments,
        ...(chapter.summary ? { summary: chapter.summary } : {}),
        present: chapter.present,
        ...(chapter.viewpoint ? { viewpoint: chapter.viewpoint } : {}),
      };
    }),
    cast: [...projection.cast]
      .sort((a, b) => b.chapters.length - a.chapters.length
        || b.viewpointChapters.length - a.viewpointChapters.length
        || (a.chapters[0] ?? 0) - (b.chapters[0] ?? 0)
        || a.key.localeCompare(b.key))
      .map((member) => ({
        name: member.name,
        aliases: member.aliases,
        viewpointChapters: member.viewpointChapters,
        appearances: member.appearances,
      })),
  };
}

export function registerStoryMapRoutes(middlewares: MiddlewareStack): void {
  middlewares.use(async (req, res, next) => {
    if (!req.url?.startsWith("/api/story-map")) {
      next();
      return;
    }
    try {
      if (req.method !== "GET") {
        writeJson(res, 405, { ok: false, error: "Only GET is supported." });
        return;
      }
      const url = new URL(req.url, "http://localhost");
      const projectDir = url.searchParams.get("project")?.trim();
      if (!projectDir) {
        writeJson(res, 400, { ok: false, error: "Project path is required." });
        return;
      }
      if (!guardProjectPath(res, projectDir)) return;
      const onCore = await ensureBookOnCore(projectDir, { snapshot: coreSnapshotFor(projectDir) });
      if (!onCore.ok) {
        writeJson(res, 200, { ok: false, error: `这本书的账还没接到新格式上：${onCore.reason}` });
        return;
      }
      const projection = await projectBook(projectDir);
      const map: StoryMap = { ...toStoryMap(projection), pace: await readPaceReport(projectDir, projection) };
      writeJson(res, 200, { ok: true, map });
    } catch (error) {
      writeJson(res, 500, { ok: false, error: scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error)) });
    }
  });
}
