/**
 * GET /api/state-overview — builds a full state overview for a project.
 */
import {
  buildStateOverview,
  recoverProjectCommitTransactions,
  withProjectCommitLock,
} from "@actalk/story-engine";
import type { StateOverview } from "@actalk/story-engine";
import {
  guardProjectPath,
  parseOptionalPositiveInteger,
  withUiOverviewDetails,
  writeJson,
  type MiddlewareStack,
} from "../lib/project-io.js";
import { scrubLocalAbsolutePaths } from "../lib/local-path-scrubber.js";
import { maybeStartReadersCatchUp } from "../brain/index.js";
import { ensureBookOnCore } from "../legacy-mirror/ensure.js";
import { createSnapshot } from "../lib/snapshot.js";

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
      // 打开书 / 刷新工作台都走这里（T5 长书；R1 起三个专员默认都开）：哪个专员前文笔记还没读齐 →
      // 后台按三个角色共用的补读队列接着补。R4.3 起这一步挪到建概况之前、并等它把第一个要读的角色
      // 标成 reading（只写 progress.json，不等模型）：开书那次概况就带得上进度，不用刷新页面才看到。
      // 重构 P3：老书第一次打开时接到新核心（先存撤销点再导入老账），老格式镜像过期就重生成。
      // 没接上不挡开书：定稿预览会如实说原因。
      const onCore = await ensureBookOnCore(projectDir, { snapshot: (label) => createSnapshot(projectDir, label).then(() => undefined) });
      if (!onCore.ok) console.warn(`[state-overview] 书没接上新核心：${onCore.reason}`);
      await maybeStartReadersCatchUp(projectDir);
      const overview = await withProjectCommitLock(projectDir, async () => {
        await recoverProjectCommitTransactions(projectDir);
        const coreOverview = await buildStateOverview({
          projectDir,
          ...(chapter !== undefined ? { chapter } : {}),
          ...(maxTimelineEvents !== undefined ? { maxTimelineEvents } : {}),
        });
        return withUiOverviewDetails(projectDir, coreOverview);
      });

      writeJson(res, 200, { ok: true, overview });
    } catch (error) {
      writeJson(res, 500, {
        ok: false,
        error: scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error)),
      });
    }
  });
}
