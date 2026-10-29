/**
 * GET /api/state-overview — builds a full state overview for a project.
 */
import { buildStateOverview } from "../book/state-overview.js";
import {
  guardProjectPath,
  parseOptionalPositiveInteger,
  writeJson,
  type MiddlewareStack,
} from "../lib/project-io.js";
import { withUiOverviewDetails } from "../services/ui-overview.js";
import { scrubLocalAbsolutePaths } from "../lib/local-path-scrubber.js";
import { resumeBackgroundReading } from "../editorial/index.js";
import { reconcileOnOpen } from "../services/operations/executor.js";
import { migrateLegacyRereadState } from "../services/operations/recipes/index.js";
import { ensureBookOnCore } from "../book/mirror/ensure.js";
import { coreSnapshotFor } from "../lib/snapshot.js";

export function registerStateOverviewRoutes(middlewares: MiddlewareStack): void {
  middlewares.use(async (req, res, next) => {
    if (!req.url?.startsWith("/api/state-overview")) {
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

      const chapter = parseOptionalPositiveInteger(url.searchParams.get("chapter"));
      const maxTimelineEvents = parseOptionalPositiveInteger(url.searchParams.get("maxTimelineEvents"));
      // 重构 P3：老书第一次打开时接到新核心（先存撤销点再导入老账），老格式镜像过期就重生成。
      // 没接上不挡开书：定稿预览会如实说原因。
      const onCore = await ensureBookOnCore(projectDir, { snapshot: coreSnapshotFor(projectDir) });
      if (!onCore.ok) console.warn(`[state-overview] 书没接上新核心：${onCore.reason}`);
      // 写作版本 P2a：这个进程头一回开这本书时对一遍账（上个进程没跑完的操作：后台的接着做，其余停着等作者）。
      await reconcileOnOpen(projectDir);
      await migrateLegacyRereadState(projectDir);
      // 打开书 / 刷新工作台都走这里（T5 长书）：哪个专员前文笔记还没读齐 → 交一次后台补读（执行器的 background.backfill）。
      // 等它受理了再建概况（R4.3）：开书那次概况就带得上「在读」，不用刷新页面才看到。
      await resumeBackgroundReading(projectDir);
      // 读路径不拿锁、不写盘（重构 P7）：老定稿链的事务残留在上面开书那步收。
      const coreOverview = await buildStateOverview({
        projectDir,
        ...(chapter !== undefined ? { chapter } : {}),
        ...(maxTimelineEvents !== undefined ? { maxTimelineEvents } : {}),
      });
      const overview = await withUiOverviewDetails(projectDir, coreOverview);

      writeJson(res, 200, { ok: true, overview });
    } catch (error) {
      writeJson(res, 500, {
        ok: false,
        error: scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error)),
      });
    }
  });
}
