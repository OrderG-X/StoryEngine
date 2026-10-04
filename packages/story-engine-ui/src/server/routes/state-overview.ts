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
