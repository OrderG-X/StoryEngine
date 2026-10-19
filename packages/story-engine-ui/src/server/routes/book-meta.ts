/**
 * 书的资料、归档、写作统计（P10）：
 *
 *   GET  /api/books/info?project=   → 书名、资料、归档没有、写作统计（读路径：不写盘、不拿锁）。
 *   POST /api/books/info            → { projectPath, info }：整份替换资料（宽进：坏值丢掉、超长截断）。
 *   POST /api/books/archive         → { projectPath, archived }。
 *   POST /api/books/meta            → { paths }：书架上每本书的归档、标签、封面色、笔名（只读；读不到的略过）。
 *   GET  /api/books/stats?project=  → 写作统计（书架「继续写」卡片用）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { BOOK_INFO_LIMITS, readBookMeta, writeBookMeta } from "../lib/book-info.js";
import { scrubLocalAbsolutePaths } from "../lib/local-path-scrubber.js";
import { assertStoryEngineProject, guardProjectPath, isSafeProjectPath, readJsonBody, readString, writeJson, type MiddlewareStack } from "../lib/project-io.js";
import { readWordStats } from "../lib/word-stats.js";

const MAX_META_PATHS = 200;

function messageOf(error: unknown): string {
  return scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error));
}

function projectFromQuery(req: IncomingMessage): string | undefined {
  return new URL(req.url ?? "", "http://localhost").searchParams.get("project")?.trim() || undefined;
}

async function handleInfo(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === "GET") {
    const projectDir = projectFromQuery(req);
    if (!projectDir) {
      writeJson(res, 400, { ok: false, error: "没说是哪本书。" });
      return;
    }
    if (!guardProjectPath(res, projectDir)) return;
    const [meta, stats] = await Promise.all([readBookMeta(projectDir), readWordStats(projectDir)]);
    writeJson(res, 200, { ok: true, ...meta, stats, limits: BOOK_INFO_LIMITS });
    return;
  }
  if (req.method !== "POST") {
    writeJson(res, 405, { ok: false, error: "Only GET / POST is supported." });
    return;
  }
  const body = await readJsonBody(req);
  const projectDir = readString(body.projectPath);
  if (!projectDir) {
    writeJson(res, 400, { ok: false, error: "没存上：没说是哪本书。" });
    return;
  }
  if (!guardProjectPath(res, projectDir)) return;
  await assertStoryEngineProject(projectDir);
  const meta = await writeBookMeta(projectDir, { info: body.info ?? {} });
  writeJson(res, 200, { ok: true, ...meta });
}

async function handleArchive(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    writeJson(res, 405, { ok: false, error: "Only POST is supported." });
    return;
  }
  const body = await readJsonBody(req);
  const projectDir = readString(body.projectPath);
  if (!projectDir || typeof body.archived !== "boolean") {
    writeJson(res, 400, { ok: false, error: projectDir ? "没改成：没说归档还是取消归档。" : "没改成：没说是哪本书。" });
    return;
  }
  if (!guardProjectPath(res, projectDir)) return;
  await assertStoryEngineProject(projectDir);
  const meta = await writeBookMeta(projectDir, { archived: body.archived });
  writeJson(res, 200, { ok: true, ...meta });
}

async function handleMeta(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    writeJson(res, 405, { ok: false, error: "Only POST is supported." });
    return;
  }
  const body = await readJsonBody(req);
  const paths = Array.isArray(body.paths) ? body.paths.filter((path): path is string => typeof path === "string" && isSafeProjectPath(path)).slice(0, MAX_META_PATHS) : [];
  const books: Record<string, { archived: boolean; coverTone?: number; tags?: readonly string[]; author?: string }> = {};
  await Promise.all(paths.map(async (path) => {
    const meta = await readBookMeta(path).catch(() => null);
    if (!meta) return;
    books[path] = {
      archived: meta.archived,
      ...(meta.info.coverTone !== undefined ? { coverTone: meta.info.coverTone } : {}),
      ...(meta.info.tags ? { tags: meta.info.tags } : {}),
      ...(meta.info.author ? { author: meta.info.author } : {}),
    };
  }));
  writeJson(res, 200, { ok: true, books });
}

async function handleStats(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET") {
    writeJson(res, 405, { ok: false, error: "Only GET is supported." });
    return;
  }
  const projectDir = projectFromQuery(req);
  if (!projectDir) {
    writeJson(res, 400, { ok: false, error: "没说是哪本书。" });
    return;
  }
  if (!guardProjectPath(res, projectDir)) return;
  const [meta, stats] = await Promise.all([readBookMeta(projectDir), readWordStats(projectDir)]);
  writeJson(res, 200, { ok: true, stats, ...(meta.info.dailyGoal ? { dailyGoal: meta.info.dailyGoal } : {}), ...(meta.info.targetWords ? { targetWords: meta.info.targetWords } : {}) });
}

const ROUTES: Readonly<Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>> = {
  "/api/books/info": handleInfo,
  "/api/books/archive": handleArchive,
  "/api/books/meta": handleMeta,
  "/api/books/stats": handleStats,
};

export function registerBookMetaRoutes(middlewares: MiddlewareStack): void {
  middlewares.use(async (req, res, next) => {
    const handler = ROUTES[req.url?.split("?")[0] ?? ""];
    if (!handler) {
      next();
      return;
    }
    try {
      await handler(req, res);
    } catch (error) {
      writeJson(res, 400, { ok: false, error: messageOf(error) });
    }
  });
}
