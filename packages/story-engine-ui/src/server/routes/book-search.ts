/**
 * GET /api/book-search?project=&q= —— 全书搜正文（⌘K 用）。
 *   → { ok, hits: [{ chapter, title?, count, snippet, quote }], chapters, occurrences }
 * 读路径不写盘、不拿锁。
 */
import { guardProjectPath, writeJson, type MiddlewareStack } from "../lib/project-io.js";
import { scrubLocalAbsolutePaths } from "../lib/local-path-scrubber.js";
import { searchBookText } from "../services/book-search.js";

/** 搜的字最长多少：再长就不是在找词了。 */
const MAX_QUERY = 100;

export function registerBookSearchRoutes(middlewares: MiddlewareStack): void {
  middlewares.use(async (req, res, next) => {
    const url = new URL(req.url ?? "", "http://localhost");
    if (url.pathname !== "/api/book-search") {
      next();
      return;
    }
    try {
      if (req.method !== "GET") {
        writeJson(res, 405, { ok: false, error: "Only GET is supported." });
        return;
      }
      const projectDir = url.searchParams.get("project")?.trim();
      if (!projectDir) {
        writeJson(res, 400, { ok: false, error: "没搜：没说是哪本书。" });
        return;
      }
      if (!guardProjectPath(res, projectDir)) return;
      const query = (url.searchParams.get("q") ?? "").trim().slice(0, MAX_QUERY);
      writeJson(res, 200, { ok: true, ...(await searchBookText(projectDir, query)) });
    } catch (error) {
      writeJson(res, 500, { ok: false, error: `没搜成：${scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error))}` });
    }
  });
}
