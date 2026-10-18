/**
 * GET /api/story-map?project= —— 故事地图的数据（重构 P6，草图 ③）：每章第几天 + 谁出场，点格子回原文。
 *
 * 直接读新核心投影：章（故事日、星期、时段、依据、梗概、出场、视角）和人物（每章出场的原句）。
 */
import { projectBook, type BookProjection } from "@actalk/story-core";
import { guardProjectPath, writeJson, type MiddlewareStack } from "../lib/project-io.js";
import { scrubLocalAbsolutePaths } from "../lib/local-path-scrubber.js";
import { ensureBookOnCore } from "../book/mirror/ensure.js";
import { coreSnapshotFor } from "../lib/snapshot.js";

export interface StoryMapChapter {
  readonly chapter: number;
  readonly day: number;
  readonly dayEnd: number;
  /** 0 = 周一 … 6 = 周日。 */
  readonly weekday?: number;
  readonly weekdayDerived: boolean;
  readonly timeOfDay?: string;
  readonly basis: "text" | "judged" | "author" | "estimated" | "missing";
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
  /** 出场章数多的在前；一样多时当过视角的在前（多半是主角）。 */
  readonly cast: readonly StoryMapMember[];
}

export function toStoryMap(projection: Pick<BookProjection, "upTo" | "chapters" | "cast">): StoryMap {
  return {
    upTo: projection.upTo,
    chapters: projection.chapters.map((chapter) => ({
      chapter: chapter.chapter,
      day: chapter.day,
      dayEnd: chapter.dayEnd,
      ...(chapter.weekday !== undefined ? { weekday: chapter.weekday } : {}),
      weekdayDerived: chapter.weekdayDerived,
      ...(chapter.timeOfDay ? { timeOfDay: chapter.timeOfDay } : {}),
      basis: chapter.dayBasis,
      ...(chapter.summary ? { summary: chapter.summary } : {}),
      present: chapter.present,
      ...(chapter.viewpoint ? { viewpoint: chapter.viewpoint } : {}),
    })),
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
      writeJson(res, 200, { ok: true, map: toStoryMap(await projectBook(projectDir)) });
    } catch (error) {
      writeJson(res, 500, { ok: false, error: scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error)) });
    }
  });
}
