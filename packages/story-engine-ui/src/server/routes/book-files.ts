/**
 * 书的文件进出（P10）：
 *
 *   GET /api/books/export?project=&format=txt|docx|epub[&from=][&to=][&drafts=1]
 *     → 附件下载。默认全部定稿章；from/to 圈范围；drafts=1 带上还没定稿的工作稿。
 *     读路径不写盘、不拿锁。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { exportBook } from "../services/export/book-export.js";
import type { ExportFormat } from "../services/export/formats.js";
import { scrubLocalAbsolutePaths } from "../lib/local-path-scrubber.js";
import { guardProjectPath, writeJson, type MiddlewareStack } from "../lib/project-io.js";

const FORMATS: readonly ExportFormat[] = ["txt", "docx", "epub"];

/** 附件头：中文文件名走 RFC 5987，另给一个纯 ASCII 的兜底名。 */
export function attachmentHeader(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/gu, "_").replace(/["\\]/gu, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function readChapterParam(params: URLSearchParams, key: string): number | undefined | null {
  const raw = params.get(key)?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function handleExport(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET") {
    writeJson(res, 405, { ok: false, error: "Only GET is supported." });
    return;
  }
  const params = new URL(req.url ?? "", "http://localhost").searchParams;
  const projectDir = params.get("project")?.trim();
  if (!projectDir) {
    writeJson(res, 400, { ok: false, error: "没导出：没说是哪本书。" });
    return;
  }
  if (!guardProjectPath(res, projectDir)) return;
  const format = (params.get("format")?.trim().toLowerCase() || "txt") as ExportFormat;
  if (!FORMATS.includes(format)) {
    writeJson(res, 400, { ok: false, error: "没导出：只能导出 txt、Word 或 epub。" });
    return;
  }
  const from = readChapterParam(params, "from");
  const to = readChapterParam(params, "to");
  if (from === null || to === null || (from !== undefined && to !== undefined && from > to)) {
    writeJson(res, 400, { ok: false, error: "没导出：章节范围不对。" });
    return;
  }
  try {
    const result = await exportBook(projectDir, {
      format,
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      includeDrafts: params.get("drafts") === "1",
    });
    res.statusCode = 200;
    res.setHeader("Content-Type", result.mime);
    res.setHeader("Content-Length", String(result.data.length));
    res.setHeader("Content-Disposition", attachmentHeader(result.filename));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Export-Chapters", String(result.chapters));
    res.end(result.data);
  } catch (error) {
    writeJson(res, 400, { ok: false, error: `没导出：${scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error))}` });
  }
}

export function registerBookFilesRoutes(middlewares: MiddlewareStack): void {
  middlewares.use(async (req, res, next) => {
    const path = req.url?.split("?")[0];
    if (path === "/api/books/export") {
      await handleExport(req, res);
      return;
    }
    next();
  });
}
