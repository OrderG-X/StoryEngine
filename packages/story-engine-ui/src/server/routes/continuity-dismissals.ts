/**
 * POST /api/continuity-dismissals —— 核账卡上点「不是问题」/「撤回」时记下或删掉一条（2026-10-10 第 2 期）。
 * body: { projectPath, chapter, quote, earlierQuote, reason?, undo? }
 *
 * 这是作者对查错结果的批注（存 .story-engine-ui/continuity-dismissals.json），不改正文、不改账本，
 * 所以不走对话：一点一条消息会把对话刷满。下次核同一章时 check_continuity 读它，标过的不再报。
 */
import {
  assertStoryEngineProject,
  guardProjectPath,
  readJsonBody,
  readString,
  requireBodyString,
  requirePositiveBodyInteger,
  writeJson,
  type MiddlewareStack,
} from "../lib/project-io.js";
import { addDismissal, removeDismissal } from "../agent/continuity-v2/dismissals.js";

export function registerContinuityDismissalsRoutes(middlewares: MiddlewareStack): void {
  middlewares.use(async (req, res, next) => {
    if (!req.url?.startsWith("/api/continuity-dismissals")) {
      next();
      return;
    }
    try {
      if (req.method !== "POST") {
        writeJson(res, 405, { ok: false, error: "Only POST is supported." });
        return;
      }
      const body = await readJsonBody(req);
      const projectDir = requireBodyString(body.projectPath, "项目路径不能为空。");
      if (!guardProjectPath(res, projectDir)) return;
      await assertStoryEngineProject(projectDir);
      const chapter = requirePositiveBodyInteger(body.chapter, "缺少有效章号。");
      const quote = requireBodyString(body.quote, "缺少本章原句。");
      const earlierQuote = requireBodyString(body.earlierQuote, "缺少前文原句。");
      if (body.undo === true) {
        const removed = await removeDismissal(projectDir, { chapter, quote, earlierQuote });
        writeJson(res, 200, { ok: true, removed });
        return;
      }
      const reason = readString(body.reason);
      const total = await addDismissal(projectDir, { chapter, quote, earlierQuote, ...(reason ? { reason } : {}) });
      writeJson(res, 200, { ok: true, total });
    } catch (error) {
      writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
}
