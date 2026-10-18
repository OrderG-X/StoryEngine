/**
 * 工作稿的读和存（重构 P5）：
 *   GET /api/working-draft?project=…&chapter=…  → { ok, paper: { chapter, draft, committed, editedSinceCommit } }
 *     draft = { chapter, title?, body, version } | null；committed = { title?, body } | null（定稿正文）
 *   PUT /api/working-draft { projectPath, chapter, body, title?, baseVersion } → { ok, version, unchanged }
 *     baseVersion 和盘上对不上 → 409 { ok:false, code:"draft_conflict", error, current }，什么都不写。
 *
 * 版本号是草稿文件全文的哈希（核心包 draft.save）。外面先拿老引擎的项目锁，和 AI 改稿 / 出稿互斥
 * （它们还在老锁里写同一个文件），里面跑核心命令。
 */
import { withProjectCommitLock } from "@actalk/story-engine";
import { draftSave, readChapterPaper, runCommand, type DraftConflictDetails } from "@actalk/story-core";
import {
  assertStoryEngineProject,
  guardProjectPath,
  readJsonBody,
  requireBodyString,
  requirePositiveBodyInteger,
  writeJson,
  type MiddlewareStack,
} from "../lib/project-io.js";
import { scrubLocalAbsolutePaths } from "../lib/local-path-scrubber.js";

const PATH = "/api/working-draft";

export function registerWorkingDraftRoutes(middlewares: MiddlewareStack): void {
  middlewares.use(async (req, res, next) => {
    const url = new URL(req.url ?? "", "http://localhost");
    if (url.pathname !== PATH) {
      next();
      return;
    }
    try {
      if (req.method === "GET") {
        const projectDir = requireBodyString(url.searchParams.get("project"), "项目路径不能为空。");
        if (!guardProjectPath(res, projectDir)) return;
        const chapter = requirePositiveBodyInteger(Number(url.searchParams.get("chapter")), "章节不能为空。");
        // 读路径不拿锁、不写盘（重构 P7）。
        await assertStoryEngineProject(projectDir);
        const paper = await readChapterPaper(projectDir, chapter);
        writeJson(res, 200, { ok: true, paper });
        return;
      }
      if (req.method === "PUT") {
        const body = await readJsonBody(req);
        const projectDir = requireBodyString(body.projectPath, "项目路径不能为空。");
        if (!guardProjectPath(res, projectDir)) return;
        const chapter = requirePositiveBodyInteger(body.chapter, "章节不能为空。");
        if (typeof body.body !== "string") throw new Error("正文不能缺。");
        const baseVersion = body.baseVersion === null ? null
          : typeof body.baseVersion === "string" && body.baseVersion.trim() ? body.baseVersion.trim()
          : (() => { throw new Error("baseVersion 要么是上次读到的版本号，要么是 null（这一章原来没有工作稿）。"); })();
        const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : undefined;
        await assertStoryEngineProject(projectDir);
        const outcome = await withProjectCommitLock(projectDir, () => runCommand(projectDir, draftSave, {
          chapter,
          body: body.body as string,
          ...(title ? { title } : {}),
          baseVersion,
        }, { caller: "author" }));
        if (outcome.ok) {
          writeJson(res, 200, { ok: true, version: outcome.result.version, unchanged: outcome.result.unchanged });
          return;
        }
        if (outcome.code === "draft_conflict") {
          const details = outcome.details as DraftConflictDetails | undefined;
          writeJson(res, 409, { ok: false, code: outcome.code, error: outcome.message, current: details?.current ?? null });
          return;
        }
        writeJson(res, 400, { ok: false, code: outcome.code, error: outcome.message });
        return;
      }
      writeJson(res, 405, { ok: false, error: "只支持 GET 和 PUT。" });
    } catch (error) {
      writeJson(res, 500, { ok: false, error: scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error)) });
    }
  });
}
