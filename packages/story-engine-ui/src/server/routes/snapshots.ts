/**
 * GET /api/snapshots?project=<dir> — list snapshot history newest-first.
 * POST /api/snapshots/restore — 整本恢复到一个存档（写作版本 P2a 片 4C：交一次 history.change restore 操作，等它做完回结果）。
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
  snapshotKindOf,
} from "../lib/snapshot.js";
import { attachSnapshotChanges, humanizeHistoryLabel } from "../lib/snapshot-changes.js";
import { readCharacterNameById } from "../writing/presence/entity-labels.js";
import { parseUserAction } from "../agent/user-actions.js";
import { receiptOf } from "../agent/tools/op-tools.js";
import { reconcileOnOpen, submitOperation, untilSettled } from "../services/operations/executor.js";
import { HISTORY_CHANGE_KIND } from "../services/operations/recipes/history-change.js";
import { operationView } from "../services/operations/view.js";

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
        // 在路由边界把 label 人话化（agent:commit_apply → 入库），只做这一次。
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
        const snapshots = raw.map((s) => ({ ...s, kind: snapshotKindOf(s.label), label: humanizeHistoryLabel(s.label) }));
        writeJson(res, 200, { ok: true, snapshots });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/snapshots/restore") {
        const body = await readJsonBody(req);
        const projectDir = requireBodyString(body.projectPath, "项目路径不能为空。");
        if (!guardProjectPath(res, projectDir)) return;
        await assertStoryEngineProject(projectDir);
        // 和按钮同一套校验：存档号、请求号、issuedAt（点几次都是这一次）。
        const parsed = parseUserAction({
          kind: "new",
          type: HISTORY_CHANGE_KIND,
          mode: "restore",
          params: { snapshot: body.id },
          requestKey: body.requestKey,
          issuedAt: body.issuedAt,
        });
        if (parsed.kind !== "action" || parsed.action.kind !== "new") {
          writeJson(res, 400, { ok: false, error: parsed.kind === "invalid" ? parsed.reason : "要恢复到哪个存档没说清。" });
          return;
        }
        const action = parsed.action;
        await reconcileOnOpen(projectDir);
        const submitted = await submitOperation(projectDir, {
          kind: HISTORY_CHANGE_KIND,
          mode: "restore",
          params: action.params,
          requestKey: action.requestKey,
          issuedAt: action.issuedAt,
          origin: { kind: "button", messageId: action.requestKey },
        });
        const receipt = receiptOf(submitted, "button", { kind: HISTORY_CHANGE_KIND, mode: "restore" });
        if (!receipt.accepted || !receipt.opId) {
          writeJson(res, 409, { ok: false, error: receipt.summary });
          return;
        }
        const record = await untilSettled(projectDir, receipt.opId);
        if (!record) {
          writeJson(res, 500, { ok: false, error: "这次恢复的记录找不到了，刷新操作历史看看恢复了没有。" });
          return;
        }
        const view = operationView(record);
        if (record.state !== "succeeded") {
          writeJson(res, 409, { ok: false, error: view.conclusion || view.stateText, operation: view });
          return;
        }
        writeJson(res, 200, { ok: true, operation: view });
        return;
      }

      // 裁剪操作历史没有 HTTP 入口：对话里交，作者点「确认裁剪」才裁。
      writeJson(res, 405, { ok: false, error: "Unsupported snapshots endpoint." });
    } catch (error) {
      writeJson(res, 500, {
        ok: false,
        error: scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error)),
      });
    }
  });
}
