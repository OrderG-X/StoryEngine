/**
 * 书的文件进出（P10）：
 *
 *   GET /api/books/export?project=&format=txt|docx|epub[&from=][&to=][&drafts=1]
 *     → 附件下载。默认全部定稿章；from/to 圈范围；drafts=1 带上还没定稿的工作稿。
 *     读路径不写盘、不拿锁。
 *   GET  /api/books/backup?project=      → 整本书打成 zip 下载（打包时拿书锁）。
 *   POST /api/books/restore              → body 是备份 zip（Content-Type: application/zip，上限 1GB），解成一本新书。
 *   GET  /api/backup-settings            → 自动备份开关、文件夹、上次结果。
 *   POST /api/backup-settings            → { auto?, dir? }（dir 空串 = 换回默认）。
 *   POST /api/backup-settings/open-folder → 在文件管理器里打开备份文件夹。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { exportBook } from "../services/export/book-export.js";
import type { ExportFormat } from "../services/export/formats.js";
import { mkdir } from "node:fs/promises";
import { scrubLocalAbsolutePaths } from "../lib/local-path-scrubber.js";
import { BACKUP_KEEP, backupDirOf, createBookBackup, defaultBackupDir, readBackupSettings, restoreBookFromBackup, updateBackupSettings } from "../lib/book-backup.js";
import { guardProjectPath, readJsonBody, writeJson, type MiddlewareStack } from "../lib/project-io.js";
import { openDirectoryInFileManager } from "./books.js";

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

/** 从备份恢复的上传上限。 */
export const RESTORE_UPLOAD_LIMIT = 1024 * 1024 * 1024;

function messageOf(error: unknown): string {
  return scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error));
}

async function readRawBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.byteLength;
    if (total > limit) throw new Error("备份包太大了（超过 1GB）。");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

async function handleBackup(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET") {
    writeJson(res, 405, { ok: false, error: "Only GET is supported." });
    return;
  }
  const projectDir = new URL(req.url ?? "", "http://localhost").searchParams.get("project")?.trim();
  if (!projectDir) {
    writeJson(res, 400, { ok: false, error: "没备份：没说是哪本书。" });
    return;
  }
  if (!guardProjectPath(res, projectDir)) return;
  try {
    const backup = await createBookBackup(projectDir);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Length", String(backup.data.length));
    res.setHeader("Content-Disposition", attachmentHeader(backup.filename));
    res.setHeader("Cache-Control", "no-store");
    res.end(backup.data);
  } catch (error) {
    writeJson(res, 400, { ok: false, error: `没备份：${messageOf(error)}` });
  }
}

async function handleRestore(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    writeJson(res, 405, { ok: false, error: "Only POST is supported." });
    return;
  }
  try {
    const zip = await readRawBody(req, RESTORE_UPLOAD_LIMIT);
    if (zip.length === 0) throw new Error("没收到备份包。");
    const restored = await restoreBookFromBackup(zip);
    writeJson(res, 200, { ok: true, ...restored });
  } catch (error) {
    writeJson(res, 400, { ok: false, error: `没恢复：${messageOf(error)}` });
  }
}

async function settingsPayload() {
  const settings = await readBackupSettings();
  return { ok: true, auto: settings.auto, dir: backupDirOf(settings), isDefaultDir: settings.dir === undefined, defaultDir: defaultBackupDir(), keep: BACKUP_KEEP, ...(settings.last ? { last: { ...settings.last, ...(settings.last.error ? { error: scrubLocalAbsolutePaths(settings.last.error) } : {}) } } : {}) };
}

async function handleBackupSettings(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  try {
    if (path === "/api/backup-settings/open-folder") {
      if (req.method !== "POST") {
        writeJson(res, 405, { ok: false, error: "Only POST is supported." });
        return;
      }
      const dir = backupDirOf(await readBackupSettings());
      await mkdir(dir, { recursive: true });
      await openDirectoryInFileManager(dir);
      writeJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET") {
      writeJson(res, 200, await settingsPayload());
      return;
    }
    if (req.method !== "POST") {
      writeJson(res, 405, { ok: false, error: "Only GET / POST is supported." });
      return;
    }
    const body = await readJsonBody(req);
    await updateBackupSettings({
      ...(typeof body.auto === "boolean" ? { auto: body.auto } : {}),
      ...(typeof body.dir === "string" ? { dir: body.dir } : {}),
    });
    writeJson(res, 200, await settingsPayload());
  } catch (error) {
    writeJson(res, 400, { ok: false, error: `没改成：${messageOf(error)}` });
  }
}

export function registerBookFilesRoutes(middlewares: MiddlewareStack): void {
  middlewares.use(async (req, res, next) => {
    const path = req.url?.split("?")[0] ?? "";
    if (path === "/api/books/export") {
      await handleExport(req, res);
      return;
    }
    if (path === "/api/books/backup") {
      await handleBackup(req, res);
      return;
    }
    if (path === "/api/books/restore") {
      await handleRestore(req, res);
      return;
    }
    if (path === "/api/backup-settings" || path === "/api/backup-settings/open-folder") {
      await handleBackupSettings(req, res, path);
      return;
    }
    next();
  });
}
