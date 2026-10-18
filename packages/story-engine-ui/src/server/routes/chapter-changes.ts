/**
 * GET /api/chapter-changes?project=&chapter= —— 这一章定稿记下了什么（重构 P6 第 6 步：定稿后设定本标出本章改了什么）。
 *
 * 直接读新核心投影：第一次出场的人、这章记的事实（改掉了哪条旧的）、线索开 / 推进 / 收口。
 * 不带 chapter＝最近定稿的那章。全部是名字和原句，不出 id。
 */
import { projectBook, type BookProjection } from "@actalk/story-core";
import { guardProjectPath, writeJson, type MiddlewareStack } from "../lib/project-io.js";
import { scrubLocalAbsolutePaths } from "../lib/local-path-scrubber.js";
import { ensureBookOnCore } from "../legacy-mirror/ensure.js";
import { createSnapshot } from "../lib/snapshot.js";

export interface ChapterChangeFact {
  readonly subject?: string;
  readonly text: string;
  readonly quote?: string;
  /** 这条顶掉的旧说法（同一人同一方面前面记的那条）。 */
  readonly replaces?: string;
  /** 记账员自动记的（作者没逐条看过）。 */
  readonly auto: boolean;
  /** 后来又被别的章改掉了 / 作者撤了。 */
  readonly later?: "superseded" | "retracted";
}

export interface ChapterChangeThread {
  readonly op: "open" | "advance" | "close";
  readonly title: string;
  readonly note: string;
  readonly quote?: string;
}

export interface ChapterChanges {
  readonly chapter: number;
  /** 定稿了的章号（翻上一章 / 下一章用）。 */
  readonly chapters: readonly number[];
  readonly summary?: string;
  readonly day: number;
  readonly dayEnd: number;
  readonly present: readonly string[];
  /** 这章第一次出场的人。 */
  readonly newCast: readonly { readonly name: string; readonly quote?: string }[];
  readonly threads: readonly ChapterChangeThread[];
  readonly facts: readonly ChapterChangeFact[];
}

const THREAD_ORDER: Record<ChapterChangeThread["op"], number> = { open: 0, advance: 1, close: 2 };

/** 投影 → 某章的改动；这章没定稿（投影里没有）返回 undefined。 */
export function toChapterChanges(
  projection: Pick<BookProjection, "chapters" | "facts" | "threads" | "cast">,
  chapter?: number,
): ChapterChanges | undefined {
  const target = chapter ?? projection.chapters.at(-1)?.chapter;
  const view = projection.chapters.find((item) => item.chapter === target);
  if (target === undefined || !view) return undefined;
  const facts = projection.facts
    .filter((fact) => fact.chapter === target)
    .map((fact): ChapterChangeFact => {
      const replaced = projection.facts.find((old) => old.supersededBy === fact.id && old.id !== fact.id);
      return {
        ...(fact.subject ? { subject: fact.subject } : {}),
        text: fact.text,
        ...(fact.quote ? { quote: fact.quote } : {}),
        ...(replaced ? { replaces: replaced.text } : {}),
        auto: fact.review === "auto",
        ...(fact.status !== "current" ? { later: fact.status } : {}),
      };
    });
  const threads = projection.threads
    .flatMap((thread) => thread.touches
      .filter((touch) => touch.chapter === target)
      .map((touch): ChapterChangeThread => ({
        op: touch.op,
        title: thread.title,
        note: touch.note,
        ...(touch.quote ? { quote: touch.quote } : {}),
      })))
    .sort((a, b) => THREAD_ORDER[a.op] - THREAD_ORDER[b.op]);
  const newCast = projection.cast
    .filter((member) => member.chapters[0] === target)
    .map((member) => {
      const quote = member.appearances.find((item) => item.chapter === target)?.quote;
      return { name: member.name, ...(quote ? { quote } : {}) };
    });
  return {
    chapter: target,
    chapters: projection.chapters.map((item) => item.chapter),
    ...(view.summary ? { summary: view.summary } : {}),
    day: view.day,
    dayEnd: view.dayEnd,
    present: view.present,
    newCast,
    threads,
    facts,
  };
}

export function registerChapterChangesRoutes(middlewares: MiddlewareStack): void {
  middlewares.use(async (req, res, next) => {
    if (!req.url?.startsWith("/api/chapter-changes")) {
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
      const rawChapter = Number(url.searchParams.get("chapter"));
      const chapter = Number.isInteger(rawChapter) && rawChapter > 0 ? rawChapter : undefined;
      const onCore = await ensureBookOnCore(projectDir, { snapshot: (label) => createSnapshot(projectDir, label).then(() => undefined) });
      if (!onCore.ok) {
        writeJson(res, 200, { ok: false, error: `这本书的账还没接到新格式上：${onCore.reason}` });
        return;
      }
      const changes = toChapterChanges(await projectBook(projectDir), chapter);
      writeJson(res, 200, changes
        ? { ok: true, changes }
        : { ok: false, error: chapter ? `第 ${chapter} 章还没定稿，没有记下的改动。` : "还没有定稿的章。" });
    } catch (error) {
      writeJson(res, 500, { ok: false, error: scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error)) });
    }
  });
}
