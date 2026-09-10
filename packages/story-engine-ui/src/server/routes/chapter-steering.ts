/**
 * POST /api/chapter-steering — generates a steering draft for the next chapter.
 * 薄适配层：共享编排在 services/steering-service.ts（与 generate_chapter_steering 工具同调）；
 * 本文件只剩 HTTP 入参解析、projectPath 守卫与状态码/字段包装（D26 输入面、D28 的 400 渲染）。
 */
import {
  guardProjectPath,
  readJsonBody,
  readPacing,
  readRevealLevel,
  readString,
  readStringList,
  readPositiveInteger,
  writeJson,
  type MiddlewareStack,
} from "../lib/project-io.js";
import { runChapterSteering } from "../services/steering-service.js";

export function registerChapterSteeringRoutes(middlewares: MiddlewareStack): void {
  middlewares.use(async (req, res, next) => {
    if (!req.url?.startsWith("/api/chapter-steering")) {
      next();
      return;
    }

    try {
      if (req.method !== "POST") {
        writeJson(res, 405, { ok: false, error: "Only POST is supported." });
        return;
      }

      const body = await readJsonBody(req);
      const projectDir = readString(body.projectPath);
      if (!projectDir) {
        writeJson(res, 400, { ok: false, error: "Project path is required." });
        return;
      }
      if (!guardProjectPath(res, projectDir)) return;

      const chapter = readPositiveInteger(body.chapter);
      const maxSuggestions = readPositiveInteger(body.maxSuggestions);
      const pacing = readPacing(body.pacing);
      const revealLevel = readRevealLevel(body.revealLevel);
      const result = await runChapterSteering({
        projectDir,
        userDirection: readString(body.userDirection),
        ...(chapter !== undefined ? { chapter } : {}),
        ...(maxSuggestions !== undefined ? { maxSuggestions } : {}),
        ...(pacing !== undefined ? { pacing } : {}),
        ...(revealLevel !== undefined ? { revealLevel } : {}),
        mustInclude: readStringList(body.mustInclude),
        mustAvoid: readStringList(body.mustAvoid),
      });
      if (!result.ok) {
        writeJson(res, 400, { ok: false, error: "下一章方向不能为空。" });
        return;
      }

      writeJson(res, 200, { ok: true, draft: result.draft });
    } catch (error) {
      writeJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
