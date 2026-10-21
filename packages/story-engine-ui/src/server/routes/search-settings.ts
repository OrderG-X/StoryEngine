/**
 * 联网搜索设置（P11）：
 *
 *   GET  /api/search-settings       → 用哪家、填没填密钥、可选的几家（密钥本身不回）。
 *   POST /api/search-settings       → { provider, apiKey? }：存（同一家不填密钥 = 沿用旧的）；{ provider: null } = 关掉、删密钥。
 *   POST /api/search-settings/test  → 用存好的设置真搜一次，回 { ok, works, summary }。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { probeSearchSettings } from "../agent/tools/web-search.js";
import { scrubLocalAbsolutePaths } from "../lib/local-path-scrubber.js";
import { readJsonBody, readString, writeJson, type MiddlewareStack } from "../lib/project-io.js";
import {
  SEARCH_PROVIDERS,
  clearSearchSettings,
  isSearchProviderId,
  readSearchSettings,
  saveSearchSettings,
  searchSettingsView,
} from "../lib/search-settings.js";

async function payload(): Promise<{ readonly ok: true } & Record<string, unknown>> {
  return { ok: true, ...searchSettingsView(await readSearchSettings()), providers: SEARCH_PROVIDERS };
}

async function handleSettings(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === "GET") {
    writeJson(res, 200, await payload());
    return;
  }
  if (req.method !== "POST") {
    writeJson(res, 405, { ok: false, error: "Only GET / POST is supported." });
    return;
  }
  const body = await readJsonBody(req);
  if (body.provider === null) {
    await clearSearchSettings();
    writeJson(res, 200, await payload());
    return;
  }
  if (!isSearchProviderId(body.provider)) {
    writeJson(res, 400, { ok: false, error: "没存上：没选是哪家搜索服务。" });
    return;
  }
  try {
    const apiKey = readString(body.apiKey);
    await saveSearchSettings({ provider: body.provider, ...(apiKey ? { apiKey } : {}) });
  } catch (error) {
    writeJson(res, 400, { ok: false, error: `没存上：${scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error))}` });
    return;
  }
  writeJson(res, 200, await payload());
}

async function handleTest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    writeJson(res, 405, { ok: false, error: "Only POST is supported." });
    return;
  }
  writeJson(res, 200, { ok: true, ...(await probeSearchSettings()) });
}

export function registerSearchSettingsRoutes(middlewares: MiddlewareStack): void {
  middlewares.use(async (req, res, next) => {
    const path = req.url?.split("?")[0];
    if (path !== "/api/search-settings" && path !== "/api/search-settings/test") {
      next();
      return;
    }
    try {
      if (path === "/api/search-settings") await handleSettings(req, res);
      else await handleTest(req, res);
    } catch (error) {
      writeJson(res, 500, { ok: false, error: scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error)) });
    }
  });
}
