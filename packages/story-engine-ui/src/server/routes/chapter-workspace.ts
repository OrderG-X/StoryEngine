/**
 * GET /api/chapter-workspace — read chapter workspace snapshot.
 * PUT /api/chapter-workspace — update chapter workspace.
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { recoverProjectCommitTransactions, withProjectCommitLock } from "@actalk/story-engine";
import {
  readJsonBody,
  guardProjectPath,
  requireBodyString,
  requirePositiveBodyInteger,
  assertStoryEngineProject,
  readWorkspaceMessages,
  readWorkspaceFlowStatus,
  readChapterWorkspaceSnapshot,
  chapterWorkspacePath,
  readStringList,
  readString,
  readStringAllowEmpty,
  defaultDraftPath,
  isRecord,
  runExclusive,
  writeFileAtomic,
  writeJson,
  type MiddlewareStack,
} from "../lib/project-io.js";
import { scrubLocalAbsolutePaths } from "../lib/local-path-scrubber.js";

/** 读当前 workspace 文件的 revision（缺失/损坏视为 0），供写盘时自增。 */
async function readCurrentRevision(workspacePath: string): Promise<number> {
  try {
    const parsed = JSON.parse(await readFile(workspacePath, "utf-8")) as unknown;
    const rev = isRecord(parsed) ? parsed.revision : undefined;
    return typeof rev === "number" && Number.isFinite(rev) ? rev : 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Route registrar
// ---------------------------------------------------------------------------

export function registerChapterWorkspaceRoutes(middlewares: MiddlewareStack): void {
  middlewares.use(async (req, res, next) => {
    if (!req.url?.startsWith("/api/chapter-workspace")) {
      next();
      return;
    }

    try {
      if (req.method === "GET") {
        const url = new URL(req.url ?? "", "http://localhost");
        const projectDir = requireBodyString(url.searchParams.get("project"), "项目路径不能为空。");
        if (!guardProjectPath(res, projectDir)) return;
        const chapter = requirePositiveBodyInteger(Number(url.searchParams.get("chapter")), "章节不能为空。");
        const snapshot = await withProjectCommitLock(projectDir, async () => {
          await recoverProjectCommitTransactions(projectDir);
          await assertStoryEngineProject(projectDir);
          return readChapterWorkspaceSnapshot(projectDir, chapter);
        });
        writeJson(res, 200, { ok: true, snapshot });
        return;
      }

      if (req.method === "PUT") {
        const body = await readJsonBody(req);
        const projectDir = requireBodyString(body.projectPath, "项目路径不能为空。");
        if (!guardProjectPath(res, projectDir)) return;
        const chapter = requirePositiveBodyInteger(body.chapter, "章节不能为空。");
        await assertStoryEngineProject(projectDir);
        const messages = readWorkspaceMessages(body.messages);
        const selectedAdviceCardKeys = readStringList(body.selectedAdviceCardKeys);
        const flowStatus = readWorkspaceFlowStatus(body.flowStatus);
        const draftContent = readStringAllowEmpty(body.draftContent);
        const draftTitle = readString(body.draftTitle);
        const pendingBaseContent = readStringAllowEmpty(body.pendingBaseContent);
        const pendingChangeSource = body.pendingChangeSource === "ai" || body.pendingChangeSource === "manual"
          ? body.pendingChangeSource
          : undefined;
        const generationInterrupted = body.generationInterrupted === true;
        const expectedRevision = body.expectedRevision === undefined
          ? undefined
          : typeof body.expectedRevision === "number"
            && Number.isInteger(body.expectedRevision)
            && body.expectedRevision >= 0
            ? body.expectedRevision
            : (() => { throw new Error("expectedRevision 必须是非负整数。"); })();
        const workspacePath = chapterWorkspacePath(projectDir, chapter);
        // 审查 #5：同章节写盘串行 + 原子落盘 + revision 自增。串行杜绝并发/乱序 PUT 交叠；
        // 原子写（临时文件 + rename）杜绝半截文件；revision 记录写入代次，供追溯与未来的乐观并发。
        const result = await withProjectCommitLock(projectDir, () => runExclusive(workspacePath, async () => {
          const currentRevision = await readCurrentRevision(workspacePath);
          if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
            return {
              conflict: true as const,
              snapshot: await readChapterWorkspaceSnapshot(projectDir, chapter),
              currentRevision,
            };
          }
          const nextRevision = currentRevision + 1;
          if (body.writeDraftFile === true && draftContent !== undefined) {
            const draftPath = defaultDraftPath(projectDir, chapter);
            await mkdir(dirname(draftPath), { recursive: true });
            await writeFileAtomic(draftPath, `${draftContent.trimEnd()}\n`);
          }
          // 生成中断路径可能省略 draftContent——保留既有草稿字段，勿被 undefined 抹掉。
          const previous = await readFile(workspacePath, "utf-8")
            .then((text) => JSON.parse(text) as unknown)
            .catch(() => null);
          const previousRecord = isRecord(previous) ? previous : {};
          // 正常写完草稿文件（非中断）→ 清 generationInterrupted；中断 keepalive → 置位；其余沿用旧值。
          const nextInterrupted = generationInterrupted
            ? true
            : (body.writeDraftFile === true ? false : previousRecord.generationInterrupted === true);
          const snapshot: Record<string, unknown> = {
            chapter,
            messages,
            selectedAdviceCardKeys,
            updatedAt: new Date().toISOString(),
            revision: nextRevision,
          };
          if (flowStatus) snapshot.flowStatus = flowStatus;
          if (draftContent !== undefined) snapshot.draftContent = draftContent;
          else if (previousRecord.draftContent !== undefined) snapshot.draftContent = previousRecord.draftContent;
          if (draftTitle) snapshot.draftTitle = draftTitle;
          else if (typeof previousRecord.draftTitle === "string") snapshot.draftTitle = previousRecord.draftTitle;
          if (pendingBaseContent !== undefined) snapshot.pendingBaseContent = pendingBaseContent;
          if (pendingChangeSource) snapshot.pendingChangeSource = pendingChangeSource;
          if (nextInterrupted) snapshot.generationInterrupted = true;
          await mkdir(dirname(workspacePath), { recursive: true });
          await writeFileAtomic(workspacePath, `${JSON.stringify(snapshot, null, 2)}\n`);
          return {
            conflict: false as const,
            snapshot: await readChapterWorkspaceSnapshot(projectDir, chapter),
          };
        }));
        if (result.conflict) {
          writeJson(res, 409, {
            ok: false,
            error: `工作区 revision 冲突：预期 ${expectedRevision}，当前 ${result.currentRevision}。`,
            snapshot: result.snapshot,
          });
          return;
        }
        writeJson(res, 200, { ok: true, snapshot: result.snapshot });
        return;
      }

      writeJson(res, 405, { ok: false, error: "Only GET and PUT are supported." });
    } catch (error) {
      writeJson(res, 500, {
        ok: false,
        error: scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error)),
      });
    }
  });
}
