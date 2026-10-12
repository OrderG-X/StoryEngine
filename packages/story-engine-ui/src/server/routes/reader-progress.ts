/**
 * GET /api/reader-progress?project=<书目录> —— 编辑部三个跟读角色的补读进度（R4.3 老书「在读前文」看得见、会走）。
 *
 * 只读 agents/<角色>/progress.json 三个小文件，不建概况、不碰引擎状态，给前端 5 秒一次的轻量轮询用
 * （开书概况里的 readerCatchUp 是初值，在读期间界面靠这里自己走）。响应：
 * { ok: true, reading: <任一角色还在读>, roles: [{ role, reading, done, total }, …checker→ledger→planner] }
 * 没在读时 reading:false（前端收到就停轮询），roles 照给（全 0 也给，形状稳定好消费）。
 */
import { guardProjectPath, writeJson, type MiddlewareStack } from "../lib/project-io.js";
import { scrubLocalAbsolutePaths } from "../lib/local-path-scrubber.js";
import { readReadersCatchUpStatus } from "../brain/index.js";

export function registerReaderProgressRoutes(middlewares: MiddlewareStack): void {
  middlewares.use(async (req, res, next) => {
    if (!req.url?.startsWith("/api/reader-progress")) {
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

      const status = await readReadersCatchUpStatus(projectDir);
      writeJson(res, 200, { ok: true, reading: status.reading, roles: status.roles });
    } catch (error) {
      writeJson(res, 500, {
        ok: false,
        error: scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error)),
      });
    }
  });
}
