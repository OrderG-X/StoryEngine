/**
 * POST /api/commit/preview — preview a commit plan.
 * POST /api/commit/apply — apply a commit plan to formal state.
 *
 * 双轨合一（第二波·commit 簇）：preview/apply 的共享编排已收进
 * services/commit-service.ts（与 commit_preview/commit_apply 工具同调），本路由只剩 HTTP 适配层：
 * 入参解析与 400 守卫、formalCommitPreview 强化结构渲染（D9 输出面）、项目级 in-flight 忙碌门
 * （activeProjectCommitOwners，HTTP 并发外皮）、canonical result → 状态码/字段投影（D8/D13）。
 * 显式策略：预览不传 declarationChannel（暂无声明来源=空声明，D7）、judge 用默认
 * judgeDraftQualityWithModel（草稿+语义各一次，D6）；apply 用 http_durable_receipt 机制（D10：
 * 三绑死 preflight + 持久回执重放/pending 恢复出口 + 锁内快照两阶段，均在 service 内原位保留）。
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  guardProjectPath,
  isSafeProjectPath,
  readJsonBody,
  readPositiveInteger,
  readString,
  requireBodyString,
  requirePositiveBodyInteger,
  writeJson,
  type MiddlewareStack,
} from "../lib/project-io.js";
import {
  buildFormalCommitPreviewResult,
  findForbiddenFormalCommitPreviewFields,
  type FormalCommitPreviewBlockingReason,
} from "../lib/formal-commit-preview.js";
import {
  runCommitApply,
  runCommitPreview,
  type CommitApplyPreflightFailure,
} from "../services/commit-service.js";

const activeProjectCommitOwners = new Map<string, string>();

export function registerCommitRoutes(middlewares: MiddlewareStack): void {
  middlewares.use(async (req, res, next) => {
    if (req.url?.startsWith("/api/commit/preview")) {
      await handleCommitPreview(req, res);
      return;
    }
    if (req.url?.startsWith("/api/commit/apply")) {
      await handleCommitApply(req, res);
      return;
    }
    next();
  });
}

async function handleCommitPreview(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
  try {
    if (req.method !== "POST") {
      writeJson(res, 405, { ok: false, error: "Only POST is supported." });
      return;
    }
    const body = await readJsonBody(req);
    const requestId = readString(body.requestId);
    const forbiddenFields = findForbiddenFormalCommitPreviewFields(body);
    if (forbiddenFields.length > 0) {
      writeCommitPreviewBlocked(res, 400, {
        reason: "formal_commit_preview_forbidden_fields",
        error: "Formal Commit Preview rejects write-capable or arbitrary payload fields.",
        requestId,
        forbiddenFields,
        blockingReasons: forbiddenFields.map((field) => `forbidden_field:${field}` as const),
      });
      return;
    }
    const projectDir = readString(body.projectPath);
    if (!projectDir) {
      writeCommitPreviewBlocked(res, 400, {
        reason: "formal_commit_preview_missing_project_path",
        error: "Project path is required.",
        requestId,
        blockingReasons: ["missing_project_path"],
      });
      return;
    }
    if (!isSafeProjectPath(projectDir)) {
      writeCommitPreviewBlocked(res, 400, {
        reason: "formal_commit_preview_unsafe_project_path",
        error: "不安全的项目路径",
        projectPath: projectDir,
        requestId,
        blockingReasons: ["unsafe_project_path"],
      });
      return;
    }
    const chapter = readPositiveInteger(body.chapter);
    if (chapter === undefined) {
      writeCommitPreviewBlocked(res, 400, {
        reason: "formal_commit_preview_missing_chapter_target",
        error: "Chapter is required.",
        projectPath: projectDir,
        requestId,
        blockingReasons: ["missing_chapter_target"],
      });
      return;
    }
    // 共享编排在 services/commit-service.ts。本路由的显式策略：无声明通道（D7）+ 默认 AI 判定 ×2（D6）。
    const result = await runCommitPreview({ projectDir, chapter });
    if (result.kind === "no_draft") {
      // D8 路由渲染：400 + missing_workspace_diff（工具路渲染 ok:false + missing_draft）。
      writeCommitPreviewBlocked(res, 400, {
        reason: "formal_commit_preview_missing_workspace_diff",
        error: "Workspace draft is required for Formal Commit Preview.",
        projectPath: projectDir,
        chapter,
        requestId,
        blockingReasons: ["missing_workspace_diff"],
      });
      return;
    }
    const { commitPlan, draftQuality, semanticQuality, transaction } = result;
    const formalCommitPreview = buildFormalCommitPreviewResult({
      projectPath: projectDir,
      chapterTarget: chapter,
      workspaceDraftId: transaction.draftHash,
      commitPlan: commitPlan.commitPlan ?? commitPlan,
      transaction,
      confirmRequestContext: {
        projectPath: projectDir,
        chapterTarget: chapter,
        previewHash: transaction.draftHash,
        baseHash: sha256(result.committedChapterContent),
        workspaceDraftId: transaction.draftHash,
        readinessStatus: "ready_for_formal_review",
      },
      requestId,
      snapshotManifestAvailable: false,
      transactionBackupAvailable: false,
      serverValidationAvailable: false,
      confirmRouteAvailable: false,
    });
    writeJson(res, 200, {
      ok: true,
      commitPlan,
      draftQuality,
      semanticQuality,
      transaction,
      transactionId: transaction.transactionId,
      previewHash: transaction.previewHash,
      formalCommitPreview,
    });
  } catch (error) {
    writeJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function writeCommitPreviewBlocked(
  res: import("node:http").ServerResponse,
  statusCode: number,
  input: {
    readonly reason: string;
    readonly error: string;
    readonly projectPath?: string;
    readonly chapter?: number;
    readonly requestId?: string;
    readonly forbiddenFields?: readonly string[];
    readonly blockingReasons: readonly FormalCommitPreviewBlockingReason[];
  },
): void {
  writeJson(res, statusCode, {
    ok: false,
    reason: input.reason,
    error: input.error,
    ...(input.forbiddenFields ? { forbiddenFields: input.forbiddenFields } : {}),
    formalCommitPreview: buildFormalCommitPreviewResult({
      projectPath: input.projectPath ?? null,
      chapterTarget: input.chapter ?? null,
      workspaceDraftId: null,
      requestId: input.requestId,
      additionalBlockingReasons: input.blockingReasons,
      snapshotManifestAvailable: false,
      transactionBackupAvailable: false,
      serverValidationAvailable: false,
      confirmRouteAvailable: false,
    }),
  });
}

async function handleCommitApply(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
  let claimedProjectOwner: { readonly key: string; readonly owner: string } | undefined;
  try {
    if (req.method !== "POST") {
      writeJson(res, 405, { ok: false, error: "Only POST is supported." });
      return;
    }
    const body = await readJsonBody(req);
    const projectDir = requireBodyString(body.projectPath, "Project path is required.");
    if (!guardProjectPath(res, projectDir)) return;
    const chapter = requirePositiveBodyInteger(body.chapter, "Chapter is required.");
    const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
    // 项目级 in-flight 忙碌门（HTTP 并发外皮）：同项目只允许一个正式定稿在执行。
    const requestOwner = commitApplyOwnerKey(projectDir, chapter, idempotencyKey);
    const projectOwnerKey = resolve(projectDir);
    const existingOwner = activeProjectCommitOwners.get(projectOwnerKey);
    if (existingOwner && existingOwner !== requestOwner) {
      writeJson(res, 409, {
        ok: false,
        reason: "formal_commit_apply_chapter_busy",
        error: "该项目已有正式定稿正在执行，请等待完成后再重试。",
      });
      return;
    }
    if (!existingOwner) {
      activeProjectCommitOwners.set(projectOwnerKey, requestOwner);
      claimedProjectOwner = { key: projectOwnerKey, owner: requestOwner };
    }
    // 共享编排在 services/commit-service.ts（http_durable_receipt 机制，D10）；
    // 安全不变量（三绑死/锁内快照/两阶段回执/pending 恢复出口）全部在 service 内原位保留。
    const result = await runCommitApply({
      projectDir,
      chapter,
      policy: {
        kind: "http_durable_receipt",
        idempotencyKey,
        credentials: {
          transactionId: body.transactionId,
          previewHash: body.previewHash,
          idempotencyKey: body.idempotencyKey,
        },
      },
    });
    switch (result.kind) {
      case "no_draft":
        writeJson(res, 500, { ok: false, error: result.errorMessage });
        return;
      case "transaction_already_claimed":
        writeJson(res, 409, {
          ok: false,
          reason: "formal_commit_apply_transaction_already_claimed",
          error: result.receiptStatus === "completed"
            ? "该预览事务已经成功定稿；更换 idempotencyKey 不能重复写入。"
            : "该预览事务存在结果不确定的 pending 回执；更换 idempotencyKey 不能绕过保护。",
        });
        return;
      case "idempotency_collision":
        writeJson(res, 409, {
          ok: false,
          reason: "formal_commit_apply_idempotency_collision",
          error: result.collision === "durable"
            ? "该 idempotencyKey 已绑定到另一份定稿请求，已拒绝重复使用。"
            : "幂等键与原请求不一致。",
        });
        return;
      case "idempotency_in_progress":
        writeJson(res, 409, {
          ok: false,
          reason: "formal_commit_apply_idempotency_in_progress",
          error: result.error,
        });
        return;
      case "replayed":
        writeJson(res, 200, { ...result.payload, idempotencyReplayed: true });
        return;
      case "recovered":
        writeJson(res, 200, { ...result.payload, idempotencyRecovered: true });
        return;
      case "draft_changed_during_snapshot":
        writeJson(res, 409, {
          ok: false,
          reason: "formal_commit_apply_draft_changed",
          error: "创建快照期间工作稿已变化，请重新生成定稿预览。",
        });
        return;
      case "preflight_failed":
        writeCommitApplyPreflightFailure(res, result.preflight);
        return;
      case "plan_not_applyable":
        writeJson(res, 409, {
          ok: false,
          reason: "commit_plan_not_applyable",
          error: `Commit plan 不可用：${result.issues.join("；")}`,
          issues: result.issues,
        });
        return;
      case "commit_failed":
        writeJson(res, 409, {
          ok: false,
          reason: "commit_failed",
          error: result.report.issues.length > 0 ? result.report.issues.join("；") : "定稿失败。",
          report: result.report,
        });
        return;
      case "committed":
        // http_durable_receipt 机制下 committed 恒带 httpPayload（与持久回执逐字同源）；缺省即编程错误。
        if (!result.httpPayload) {
          throw new Error("commit-service committed result missing httpPayload for http_durable_receipt policy.");
        }
        writeJson(res, 200, result.httpPayload);
        return;
      default:
        // agent_preview_ticket 机制的专属 kind 不会出现在本路由；出现即编程错误。
        throw new Error(`Unexpected commit apply result for http_durable_receipt policy: ${String(result.kind)}`);
    }
  } catch (error) {
    writeJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (claimedProjectOwner && activeProjectCommitOwners.get(claimedProjectOwner.key) === claimedProjectOwner.owner) {
      activeProjectCommitOwners.delete(claimedProjectOwner.key);
    }
  }
}

function writeCommitApplyPreflightFailure(
  res: import("node:http").ServerResponse,
  transactionPreflight: CommitApplyPreflightFailure,
): void {
  writeJson(res, 409, {
    ok: false,
    reason: "formal_commit_apply_transaction_preflight_failed",
    error: transactionPreflight.message,
    transactionPreflight,
  });
}

/** 忙碌门的 owner 串（仅作唯一标识用；与 service 内持久回执键同款 \u0000 分隔格式）。 */
function commitApplyOwnerKey(projectDir: string, chapter: number, idempotencyKey: string): string {
  return `${resolve(projectDir)}\u0000${chapter}\u0000${idempotencyKey}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf-8").digest("hex");
}
