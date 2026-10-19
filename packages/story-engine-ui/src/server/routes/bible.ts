/**
 * 设定本（重构 P9）：
 *
 *   GET  /api/bible?project=  → 设定视图（设定卡 + 账里记的现状 + 还没建卡的），读路径不写盘、不拿锁；
 *   POST /api/cards           → 作者在设定本里改（作者档 card.write，改前存档、可撤销）。
 *     body: { projectPath, ops, requestId }。requestId 是这次点击的幂等键：网络重发、连点两次只改一次。
 */
import { CardOps, readBible } from "@actalk/story-core";
import { writeCards } from "../lib/card-write.js";
import { scrubLocalAbsolutePaths } from "../lib/local-path-scrubber.js";
import { guardProjectPath, readJsonBody, readString, writeJson, type MiddlewareStack } from "../lib/project-io.js";

export function registerBibleRoutes(middlewares: MiddlewareStack): void {
  middlewares.use(async (req, res, next) => {
    const path = req.url?.split("?")[0];
    if (path !== "/api/bible" && path !== "/api/cards") {
      next();
      return;
    }
    try {
      if (path === "/api/bible") {
        if (req.method !== "GET") {
          writeJson(res, 405, { ok: false, error: "Only GET is supported." });
          return;
        }
        const projectDir = new URL(req.url ?? "", "http://localhost").searchParams.get("project")?.trim();
        if (!projectDir) {
          writeJson(res, 400, { ok: false, error: "设定本没读出来：没说是哪本书。" });
          return;
        }
        if (!guardProjectPath(res, projectDir)) return;
        const { bible } = await readBible(projectDir);
        writeJson(res, 200, { ok: true, bible });
        return;
      }

      if (req.method !== "POST") {
        writeJson(res, 405, { ok: false, error: "只能用 POST 改设定。" });
        return;
      }
      const body = await readJsonBody(req);
      const projectDir = readString(body.projectPath);
      const requestId = readString(body.requestId);
      if (!projectDir || !requestId) {
        writeJson(res, 400, { ok: false, error: projectDir ? "没改设定：这次改动缺少防重复的编号。" : "没改设定：没说是哪本书。" });
        return;
      }
      if (!guardProjectPath(res, projectDir)) return;
      const ops = CardOps.safeParse(body.ops);
      if (!ops.success) {
        writeJson(res, 400, { ok: false, error: "没改设定：要改的内容格式不对。" });
        return;
      }
      const outcome = await writeCards(projectDir, { by: "author", ops: ops.data, idempotencyKey: `card-ui:${requestId}` });
      if (!outcome.ok) {
        writeJson(res, 409, { ok: false, code: outcome.code, error: outcome.message });
        return;
      }
      writeJson(res, 200, {
        ok: true,
        lines: outcome.lines,
        ...(outcome.snapshotId ? { snapshotId: outcome.snapshotId } : {}),
        ...(outcome.replayed ? { replayed: true } : {}),
      });
    } catch (error) {
      writeJson(res, 500, {
        ok: false,
        error: scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error)),
      });
    }
  });
}
