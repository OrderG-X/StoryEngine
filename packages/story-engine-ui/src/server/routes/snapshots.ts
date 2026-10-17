/**
 * GET /api/snapshots?project=<dir> — list snapshot history newest-first.
 * POST /api/snapshots/restore — restore project to a snapshot.
 */
import {
  readJsonBody,
  guardProjectPath,
  requireBodyString,
  assertStoryEngineProject,
  writeJson,
  type MiddlewareStack,
} from "../lib/project-io.js";
import { scrubLocalAbsolutePaths } from "../lib/local-path-scrubber.js";
import {
  attachCommitChapterDetails,
  chapterHintsFromFileChanges,
  isPostWriteSettlementSnapshot,
  listSnapshots,
  readCommitFileChanges,
  restoreSnapshot,
} from "../lib/snapshot.js";
import { attachSnapshotChanges, buildRestoreReceipt, humanizeHistoryLabel } from "../lib/snapshot-changes.js";
import { readCharacterNameById } from "../agent/presence/entity-labels.js";

// ---------------------------------------------------------------------------
// Route registrar
// ---------------------------------------------------------------------------

export function registerSnapshotsRoutes(middlewares: MiddlewareStack): void {
  middlewares.use(async (req, res, next) => {
    if (!req.url?.startsWith("/api/snapshots")) {
      next();
      return;
    }

    try {
      const url = new URL(req.url ?? "", "http://localhost");

      if (req.method === "GET" && url.pathname === "/api/snapshots") {
        const projectDir = requireBodyString(url.searchParams.get("project"), "项目路径不能为空。");
        if (!guardProjectPath(res, projectDir)) return;
        await assertStoryEngineProject(projectDir);
        // 在路由边界把 label 人话化（agent:commit_apply → 入库）；不下沉到 listSnapshots——
        // undoLastChange 依赖原始 label 做 isRestoreArtifact/^agent: 匹配，提前 humanize 会破坏它。
        // 过滤掉「落盘收尾」工程 commit（afterfix #2）：它只为把写产物收进 git、让工作树干净，不是用户动作，
        // 不该出现在操作历史里（否则每个写操作多一条无意义条目）。
        // 老「定稿」条目补章号（新存档标签已自带）：须在过滤落盘收尾之前做，它靠紧邻的收尾提交认章。
        // 「查看改动」：每个存档点之后落盘的文件翻成人话（同样要在过滤落盘收尾之前配，改动就记在收尾提交里）。
        const listed = await listSnapshots(projectDir);
        const [filesById, nameById] = await Promise.all([
          readCommitFileChanges(projectDir),
          readCharacterNameById(projectDir),
        ]);
        const withChapters = listed.some((s) => s.label === "agent:commit_apply")
          ? attachCommitChapterDetails(listed, chapterHintsFromFileChanges(filesById))
          : listed;
        const raw = attachSnapshotChanges(withChapters, filesById, nameById)
          .filter((s) => !isPostWriteSettlementSnapshot(s.label));
        const snapshots = raw.map((s) => ({ ...s, label: humanizeHistoryLabel(s.label) }));
        writeJson(res, 200, { ok: true, snapshots });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/snapshots/restore") {
        const body = await readJsonBody(req);
        const projectDir = requireBodyString(body.projectPath, "项目路径不能为空。");
        if (!guardProjectPath(res, projectDir)) return;
        await assertStoryEngineProject(projectDir);
        const id = requireBodyString(body.id, "快照 id 不能为空。");
        const { restored, reverted, revertedLater } = await restoreSnapshot(projectDir, id);
        // R4.2：恢复到更早的存档点会把那之后的所有写入一并退回，回执如实列清单 + 指明找回办法。
        const nameById = await readCharacterNameById(projectDir).catch(() => new Map<string, string>());
        const targetLabel = /^恢复到：(.+)$/u.exec(restored.label)?.[1] ?? restored.label;
        const receipt = buildRestoreReceipt({
          title: `已恢复到「${humanizeHistoryLabel(targetLabel)}」之前。`,
          reverted,
          revertedLater,
          nameById,
        });
        writeJson(res, 200, { ok: true, restored, receipt });
        return;
      }

      // 裁剪操作历史不再有 HTTP 入口（重构 P4）：只能由作者点「确认裁剪」按钮发结构化动作（prune_snapshots）。
      writeJson(res, 405, { ok: false, error: "Unsupported snapshots endpoint." });
    } catch (error) {
      writeJson(res, 500, {
        ok: false,
        error: scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error)),
      });
    }
  });
}
