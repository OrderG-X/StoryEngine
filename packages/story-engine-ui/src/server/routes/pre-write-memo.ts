/**
 * GET /api/pre-write-memo?project=&chapter= —— 写前备忘：动笔写第 N 章前看一眼。
 *
 * 读新核心投影（算到 N − 1 章，回头改前面的章时后文的账不露进来）：上一章停在第几天、谁在场，
 * 该接的线索（上一章刚动过的、停太久的、大伏笔），最近几章变了的状态。全是账里记的结构，不读正文、不猜。
 * 线索编号只给界面当列表键用，界面不显示。
 */
import { preWriteMemo, projectBook } from "@actalk/story-core";
import { guardProjectPath, writeJson, type MiddlewareStack } from "../lib/project-io.js";
import { scrubLocalAbsolutePaths } from "../lib/local-path-scrubber.js";
import { ensureBookOnCore } from "../book/mirror/ensure.js";
import { coreSnapshotFor } from "../lib/snapshot.js";

export function registerPreWriteMemoRoutes(middlewares: MiddlewareStack): void {
  middlewares.use(async (req, res, next) => {
    if (!req.url?.startsWith("/api/pre-write-memo")) {
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
      const rawChapter = Number(url.searchParams.get("chapter"));
      if (!Number.isInteger(rawChapter) || rawChapter < 1) {
        writeJson(res, 400, { ok: false, error: "要写第几章没说清。" });
        return;
      }
      const onCore = await ensureBookOnCore(projectDir, { snapshot: coreSnapshotFor(projectDir) });
      if (!onCore.ok) {
        writeJson(res, 200, { ok: false, error: `这本书的账还没接到新格式上：${onCore.reason}` });
        return;
      }
      const projection = await projectBook(projectDir, { upTo: rawChapter - 1 });
      writeJson(res, 200, { ok: true, memo: preWriteMemo(projection, rawChapter) });
    } catch (error) {
      writeJson(res, 500, { ok: false, error: scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error)) });
    }
  });
}
