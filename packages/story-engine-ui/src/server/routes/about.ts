/**
 * 关于（P11）：
 *
 *   GET  /api/about       → 版本、有没有第三方许可清单 / 日志目录（桌面壳通过环境变量给，开发时没有）。
 *   POST /api/about/open  → { what: "notices" | "logs" | "books" }：在系统里打开许可清单 / 日志文件夹 / 书库文件夹。
 *
 * 路径只在本机打开，不回给界面。
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveBooksRootDir } from "../lib/data-dirs.js";
import { scrubLocalAbsolutePaths } from "../lib/local-path-scrubber.js";
import { readJsonBody, writeJson, type MiddlewareStack } from "../lib/project-io.js";
import { openDirectoryInFileManager } from "./books.js";

function envPath(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && existsSync(value) ? value : undefined;
}

export function aboutPayload(): { ok: true; version: string | null; hasNotices: boolean; hasLogs: boolean } {
  return {
    ok: true,
    version: process.env.SE_APP_VERSION?.trim() || null,
    hasNotices: Boolean(envPath("SE_NOTICES_PATH")),
    hasLogs: Boolean(process.env.SE_LOGS_DIR?.trim()),
  };
}

async function handleOpen(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    writeJson(res, 405, { ok: false, error: "Only POST is supported." });
    return;
  }
  const body = await readJsonBody(req);
  if (body.what === "notices") {
    const notices = envPath("SE_NOTICES_PATH");
    if (!notices) {
      writeJson(res, 404, { ok: false, error: "没找到许可清单（开发版不带，桌面包里才有）。" });
      return;
    }
    await openDirectoryInFileManager(notices);
  } else if (body.what === "logs") {
    const logs = process.env.SE_LOGS_DIR?.trim();
    if (!logs) {
      writeJson(res, 404, { ok: false, error: "开发版不写日志文件，看终端输出就行。" });
      return;
    }
    await mkdir(logs, { recursive: true });
    await openDirectoryInFileManager(logs);
  } else if (body.what === "books") {
    const books = resolveBooksRootDir();
    await mkdir(books, { recursive: true });
    await openDirectoryInFileManager(books);
  } else {
    writeJson(res, 400, { ok: false, error: "没说要打开什么。" });
    return;
  }
  writeJson(res, 200, { ok: true });
}

export function registerAboutRoutes(middlewares: MiddlewareStack): void {
  middlewares.use(async (req, res, next) => {
    const path = req.url?.split("?")[0];
    if (path !== "/api/about" && path !== "/api/about/open") {
      next();
      return;
    }
    try {
      if (path === "/api/about") {
        if (req.method !== "GET") writeJson(res, 405, { ok: false, error: "Only GET is supported." });
        else writeJson(res, 200, aboutPayload());
      } else {
        await handleOpen(req, res);
      }
    } catch (error) {
      writeJson(res, 500, { ok: false, error: `没打开：${scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error))}` });
    }
  });
}
