/**
 * 用量（P10）：
 *
 *   GET  /api/usage          → 今天、本月、近 30 天每天、近 30 天按书 / 功能 / 模型（读路径：不写盘）。
 *   POST /api/usage/prices   → { key: "服务商|模型", price: { input, cachedInput?, output } | null }：填 / 清单价。
 *
 * 书的 key 是本机目录：只回给本机界面认书用，不进任何错误文案。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { scrubLocalAbsolutePaths } from "../lib/local-path-scrubber.js";
import { readJsonBody, readString, writeJson, type MiddlewareStack } from "../lib/project-io.js";
import { readUsageSummary, writeUsagePrice } from "../lib/usage-ledger.js";

async function handleSummary(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET") {
    writeJson(res, 405, { ok: false, error: "Only GET is supported." });
    return;
  }
  writeJson(res, 200, { ok: true, summary: await readUsageSummary() });
}

async function handlePrices(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    writeJson(res, 405, { ok: false, error: "Only POST is supported." });
    return;
  }
  const body = await readJsonBody(req);
  const key = readString(body.key);
  if (!key) {
    writeJson(res, 400, { ok: false, error: "没存上：没说是哪个模型。" });
    return;
  }
  try {
    const prices = await writeUsagePrice(key, body.price ?? null);
    writeJson(res, 200, { ok: true, prices });
  } catch (error) {
    writeJson(res, 400, { ok: false, error: `没存上：${scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error))}` });
  }
}

export function registerUsageRoutes(middlewares: MiddlewareStack): void {
  middlewares.use(async (req, res, next) => {
    const path = req.url?.split("?")[0];
    if (path !== "/api/usage" && path !== "/api/usage/prices") {
      next();
      return;
    }
    try {
      if (path === "/api/usage") await handleSummary(req, res);
      else await handlePrices(req, res);
    } catch (error) {
      writeJson(res, 500, { ok: false, error: scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error)) });
    }
  });
}
