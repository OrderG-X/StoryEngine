/**
 * 工作稿的读和存（重构 P5）：
 *   GET /api/working-draft?project=…&chapter=…  → { ok, paper: { chapter, draft, committed, editedSinceCommit } }
 *     draft = { chapter, title?, body, version } | null；committed = { title?, body } | null（定稿正文）
 *   PUT /api/working-draft { projectPath, chapter, body, title?, baseVersion } → { ok, version, unchanged }
 *     baseVersion 和盘上对不上 → 409 { ok:false, code:"draft_conflict", error, current }，什么都不写。
 *   POST /api/chapter-title { projectPath, chapter, title, requestId } → { ok, title, unchanged, snapshotId? }
 *     改已定稿那一章的章名（作者档 chapter.retitle，改前存档、可撤销；正文和账单条目不动）。requestId 是这次点击的幂等键。
 *     没定稿的章不走这里：章名跟着存稿走。
 *
 * 版本号是草稿文件全文的哈希（核心包 draft.save）。外面先拿老引擎的项目锁，和 AI 改稿 / 出稿互斥
 * （它们还在老锁里写同一个文件），里面跑核心命令。
 */
import { chapterRetitle, draftSave, readChapterPaper, runCommand, type DraftConflictDetails } from "@actalk/story-core";
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
import { chapterWordsNow, recordChapterWords } from "../lib/word-stats.js";
import { runWithLazySnapshot } from "../lib/snapshot.js";
import { syncLegacyMirror } from "../book/mirror/sync.js";

const PATH = "/api/working-draft";
const TITLE_PATH = "/api/chapter-title";

export function registerWorkingDraftRoutes(middlewares: MiddlewareStack): void {
  middlewares.use(async (req, res, next) => {
    const url = new URL(req.url ?? "", "http://localhost");
    if (url.pathname !== PATH && url.pathname !== TITLE_PATH) {
      next();
      return;
    }
    try {
      if (url.pathname === TITLE_PATH) {
        if (req.method !== "POST") {
          writeJson(res, 405, { ok: false, error: "只能用 POST 改章名。" });
          return;
        }
        const body = await readJsonBody(req);
        const projectDir = requireBodyString(body.projectPath, "项目路径不能为空。");
        if (!guardProjectPath(res, projectDir)) return;
        const chapter = requirePositiveBodyInteger(body.chapter, "章节不能为空。");
        const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
        if (!requestId) {
          writeJson(res, 400, { ok: false, error: "没改章名：这次改动缺少防重复的编号。" });
          return;
        }
        await assertStoryEngineProject(projectDir);
        const { snapshotId, result } = await runWithLazySnapshot(projectDir, (snapshot) =>
          runCommand(projectDir, chapterRetitle, { chapter, title: typeof body.title === "string" ? body.title : "" }, {
            caller: "author",
            idempotencyKey: `chapter-title:${requestId}`,
            snapshot,
          }));
        if (!result.ok) {
          writeJson(res, 409, { ok: false, code: result.code, error: result.message });
          return;
        }
        // 老格式镜像（时间线里的章名）跟着定稿正文走；没同步上不算没改成，下次打开书会补。
        if (!result.result.unchanged) {
          const mirror = await syncLegacyMirror(projectDir);
          if (!mirror.ok) console.warn(`[chapter-title] 第 ${chapter} 章改章名后老格式镜像没同步上：${mirror.reason}`);
        }
        writeJson(res, 200, {
          ok: true,
          title: result.result.title,
          unchanged: result.result.unchanged,
          ...(snapshotId && !result.replayed ? { snapshotId } : {}),
        });
        return;
      }
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
        // 写作统计：写之前量一下这章多少字，存完按差值记成作者写的。
        const wordsBefore = await chapterWordsNow(projectDir, chapter).catch(() => undefined);
        const outcome = await runCommand(projectDir, draftSave, {
          chapter,
          body: body.body as string,
          ...(title ? { title } : {}),
          baseVersion,
        }, { caller: "author" });
        if (outcome.ok) {
          if (!outcome.result.unchanged) await recordChapterWords(projectDir, chapter, "author", wordsBefore);
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
