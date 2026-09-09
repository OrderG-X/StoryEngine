/**
 * POST /api/commit/preview — preview a commit plan.
 * POST /api/commit/apply — apply a commit plan to formal state.
 */
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  buildCommitPlanFromProject,
  buildStateOverview,
  checkCommitPlanSemanticQuality,
  checkDraftBeforeCommit,
  commitFastDraft,
  recoverProjectCommitTransactions,
  withProjectCommitLock,
} from "@actalk/story-engine";
import {
  defaultCommittedChapterPath,
  defaultDraftPath,
  extractDraftTitle,
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
import { judgeDraftQualityWithModel } from "../lib/quality-judge.js";
import { createSnapshot } from "../lib/snapshot.js";
import {
  buildCommitPreviewTransaction,
  validateCommitApplyPreflight,
  type CommitPreviewTransactionMetadata,
} from "../lib/transaction-hardening.js";
import {
  buildFormalCommitPreviewResult,
  findForbiddenFormalCommitPreviewFields,
  type FormalCommitPreviewBlockingReason,
} from "../lib/formal-commit-preview.js";

interface CommitApplySuccessPayload extends Record<string, unknown> {
  readonly ok: true;
  readonly report: unknown;
  readonly overview: unknown;
  readonly chapterContent: string;
  readonly chapterTitle: string;
}

type CommitIdempotencyEntry =
  | {
    readonly status: "running";
    readonly transaction: CommitPreviewTransactionMetadata;
  }
  | {
    readonly status: "completed";
    readonly transaction: CommitPreviewTransactionMetadata;
    readonly payload: CommitApplySuccessPayload;
  };

const commitIdempotencyEntries = new Map<string, CommitIdempotencyEntry>();
const activeProjectCommitOwners = new Map<string, string>();

interface DurableCommitReceipt {
  readonly version: 1;
  readonly status: "pending" | "completed";
  readonly projectHash: string;
  readonly chapter: number;
  readonly idempotencyKey: string;
  readonly transactionId: string;
  readonly previewHash: string;
  readonly createdAt: string;
  readonly payload?: CommitApplySuccessPayload;
}

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
    await withProjectCommitLock(projectDir, async () => {
    await recoverProjectCommitTransactions(projectDir);
    const draftPath = defaultDraftPath(projectDir, chapter);
    let draftContent: string;
    try {
      draftContent = await readFile(draftPath, "utf-8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
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
      throw error;
    }
    const commitPlan = await buildCommitPlanFromProject({ projectDir, chapter, draftPath, draftContent });
    const deterministicDraftQuality = await checkDraftBeforeCommit({ projectDir, chapter, draftContent });
    const deterministicSemanticQuality = commitPlan.commitPlan
      ? checkCommitPlanSemanticQuality(commitPlan.commitPlan)
      : undefined;
    const [draftQuality, semanticQuality] = await Promise.all([
      judgeDraftQualityWithModel({ projectDir, chapter, draftContent, deterministicQuality: deterministicDraftQuality }),
      deterministicSemanticQuality
        ? judgeDraftQualityWithModel({ projectDir, chapter, draftContent, deterministicQuality: deterministicSemanticQuality })
        : Promise.resolve(undefined),
    ]);
    const transaction = buildCommitPreviewTransaction({ projectDir, chapter, draftContent, commitPlan });
    const committedChapterContent = await readFile(defaultCommittedChapterPath(projectDir, chapter), "utf-8")
      .catch(() => "");
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
        baseHash: sha256(committedChapterContent),
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
    const requestOwner = commitIdempotencyCacheKey(projectDir, chapter, idempotencyKey);
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
    await withProjectCommitLock(projectDir, async () => {
      await recoverProjectCommitTransactions(projectDir);
      const cacheKey = commitIdempotencyCacheKey(projectDir, chapter, idempotencyKey);
      const transactionReceipt = typeof body.transactionId === "string" && typeof body.previewHash === "string"
        ? await findDurableReceiptForTransaction(projectDir, chapter, body.transactionId, body.previewHash)
        : undefined;
      if (transactionReceipt && transactionReceipt.idempotencyKey !== idempotencyKey) {
        writeJson(res, 409, {
          ok: false,
          reason: "formal_commit_apply_transaction_already_claimed",
          error: transactionReceipt.status === "completed"
            ? "该预览事务已经成功定稿；更换 idempotencyKey 不能重复写入。"
            : "该预览事务存在结果不确定的 pending 回执；更换 idempotencyKey 不能绕过保护。",
        });
        return;
      }
      const durableReceipt = isValidIdempotencyKey(idempotencyKey)
        ? await readDurableCommitReceipt(projectDir, chapter, idempotencyKey)
        : undefined;
      if (durableReceipt) {
        if (!receiptMatchesRequest(durableReceipt, body, projectDir, chapter)) {
          writeJson(res, 409, {
            ok: false,
            reason: "formal_commit_apply_idempotency_collision",
            error: "该 idempotencyKey 已绑定到另一份定稿请求，已拒绝重复使用。",
          });
          return;
        }
        if (durableReceipt.status === "pending" || !durableReceipt.payload) {
          const recoveredPayload = await recoverPendingCommitReceiptFromDisk(projectDir, chapter, durableReceipt)
            .catch(() => undefined);
          if (recoveredPayload) {
            writeJson(res, 200, { ...recoveredPayload, idempotencyRecovered: true });
            return;
          }
          writeJson(res, 409, {
            ok: false,
            reason: "formal_commit_apply_idempotency_in_progress",
            error: pendingReceiptBlockMessage(projectDir, chapter, idempotencyKey),
          });
          return;
        }
        writeJson(res, 200, { ...durableReceipt.payload, idempotencyReplayed: true });
        return;
      }
      const cached = idempotencyKey ? commitIdempotencyEntries.get(cacheKey) : undefined;
      if (cached?.status === "completed") {
        if (!receiptMatchesRequest(receiptFromCache(cached, chapter, idempotencyKey, projectDir), body, projectDir, chapter)) {
          writeJson(res, 409, { ok: false, reason: "formal_commit_apply_idempotency_collision", error: "幂等键与原请求不一致。" });
          return;
        }
        writeJson(res, 200, { ...cached.payload, idempotencyReplayed: true });
        return;
      }

      const draftPath = defaultDraftPath(projectDir, chapter);
      const draftContent = await readFile(draftPath, "utf-8");
      const commitPlan = await buildCommitPlanFromProject({ projectDir, chapter, draftPath, draftContent });
      const transaction = buildCommitPreviewTransaction({ projectDir, chapter, draftContent, commitPlan });
      const transactionPreflight = validateCommitApplyPreflight({
        transactionId: body.transactionId,
        expectedPreviewHash: body.previewHash,
        idempotencyKey: body.idempotencyKey,
        current: transaction,
        residues: [],
      });
      if (!transactionPreflight.ok) {
        writeCommitApplyPreflightFailure(res, transactionPreflight);
        return;
      }
      if (!commitPlan.passed || !commitPlan.commitPlan) {
        writeJson(res, 409, {
          ok: false,
          reason: "commit_plan_not_applyable",
          error: `Commit plan 不可用：${commitPlan.issues.join("；")}`,
          issues: commitPlan.issues,
        });
        return;
      }

      const pendingReceipt: DurableCommitReceipt = {
        version: 1,
        status: "pending",
        projectHash: sha256(resolve(projectDir)),
        chapter,
        idempotencyKey,
        transactionId: transaction.transactionId,
        previewHash: transaction.previewHash,
        createdAt: new Date().toISOString(),
      };
      let businessCommitted = false;
      try {
        await createSnapshot(projectDir, `入库前快照：第${chapter}章`);
        const draftAfterSnapshot = await readFile(draftPath, "utf-8");
        if (sha256(draftAfterSnapshot) !== transaction.draftHash) {
          await removePendingCommitReceipt(projectDir, pendingReceipt);
          commitIdempotencyEntries.delete(cacheKey);
          writeJson(res, 409, {
            ok: false,
            reason: "formal_commit_apply_draft_changed",
            error: "创建快照期间草稿已变化，请重新生成定稿预览。",
          });
          return;
        }

        // Claim after the reversible pre-write snapshot so undoing that
        // snapshot also removes the completed receipt and permits a genuine
        // future re-commit. The exclusive create is the atomic post-await gate.
        const racedReceipt = await claimDurableCommitReceipt(projectDir, pendingReceipt);
        if (racedReceipt) {
          if (!receiptMatchesRequest(racedReceipt, body, projectDir, chapter)) {
            writeJson(res, 409, { ok: false, reason: "formal_commit_apply_idempotency_collision", error: "幂等键与原请求不一致。" });
            return;
          }
          if (racedReceipt.status === "completed" && racedReceipt.payload) {
            writeJson(res, 200, { ...racedReceipt.payload, idempotencyReplayed: true });
          } else {
            writeJson(res, 409, { ok: false, reason: "formal_commit_apply_idempotency_in_progress", error: "相同幂等请求仍在执行。" });
          }
          return;
        }
        commitIdempotencyEntries.set(cacheKey, { status: "running", transaction });

        const report = await commitFastDraft({
          projectDir,
          chapter,
          draftPath,
          draftContent,
          commitPlan: commitPlan.commitPlan,
        });
        if (!report.passed) {
          await removePendingCommitReceipt(projectDir, pendingReceipt);
          commitIdempotencyEntries.delete(cacheKey);
          writeJson(res, 409, {
            ok: false,
            reason: "commit_failed",
            error: report.issues.length > 0 ? report.issues.join("；") : "入库失败。",
            report,
          });
          return;
        }
        businessCommitted = true;
        const chapterContent = typeof report.chapterPath === "string"
          ? await readFile(report.chapterPath, "utf-8").catch(() => draftContent)
          : draftContent;
        const chapterTitle = extractDraftTitle(chapterContent) ?? `第${chapter}章`;
        const warnings: string[] = [];
        const overview = await buildStateOverview({ projectDir, chapter, maxTimelineEvents: 8 })
          .catch((error: unknown) => {
            warnings.push(`overview refresh failed after successful commit: ${error instanceof Error ? error.message : String(error)}`);
            return null;
          });
        let payload: CommitApplySuccessPayload = {
          ok: true,
          report,
          overview,
          chapterContent,
          chapterTitle,
          ...(warnings.length > 0 ? { warnings } : {}),
        };
        const completedReceipt: DurableCommitReceipt = { ...pendingReceipt, status: "completed", payload };
        try {
          await writeDurableCommitReceipt(projectDir, completedReceipt);
        } catch (error) {
          const receiptWarning = `idempotency receipt persistence failed after successful commit: ${error instanceof Error ? error.message : String(error)}`;
          payload = { ...payload, warnings: [...warnings, receiptWarning] };
        }
        commitIdempotencyEntries.set(cacheKey, { status: "completed", transaction, payload });
        writeJson(res, 200, payload);
      } catch (error) {
        if (!businessCommitted) {
          await removePendingCommitReceipt(projectDir, pendingReceipt).catch(() => undefined);
          commitIdempotencyEntries.delete(cacheKey);
        }
        throw error;
      }
    });
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
  transactionPreflight: Exclude<ReturnType<typeof validateCommitApplyPreflight>, { readonly ok: true }>,
): void {
  writeJson(res, 409, {
    ok: false,
    reason: "formal_commit_apply_transaction_preflight_failed",
    error: transactionPreflight.message,
    transactionPreflight,
  });
}

function commitIdempotencyCacheKey(projectDir: string, chapter: number, idempotencyKey: string): string {
  return `${resolve(projectDir)}\u0000${chapter}\u0000${idempotencyKey}`;
}

function isValidIdempotencyKey(value: string): boolean {
  return /^[A-Za-z0-9._:-]{8,160}$/u.test(value);
}

function receiptPath(projectDir: string, chapter: number, idempotencyKey: string): string {
  const digest = sha256(commitIdempotencyCacheKey(projectDir, chapter, idempotencyKey));
  return join(projectDir, ".story-engine-ui", "commit-idempotency", `${digest}.json`);
}

async function ensureReceiptDirectory(projectDir: string): Promise<string> {
  const uiRoot = join(projectDir, ".story-engine-ui");
  const dir = join(uiRoot, "commit-idempotency");
  const projectStats = await lstat(projectDir);
  if (!projectStats.isDirectory() || projectStats.isSymbolicLink()) {
    throw new Error(`Unsafe durable commit receipt project root: ${projectDir}`);
  }
  for (const path of [uiRoot, dir]) {
    try {
      const stats = await lstat(path);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error(`Unsafe durable commit receipt directory: ${path}`);
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      await mkdir(path);
      const stats = await lstat(path);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error(`Unsafe durable commit receipt directory: ${path}`);
      }
    }
  }
  return dir;
}

async function readDurableCommitReceipt(
  projectDir: string,
  chapter: number,
  idempotencyKey: string,
): Promise<DurableCommitReceipt | undefined> {
  const path = receiptPath(projectDir, chapter, idempotencyKey);
  try {
    await validateExistingReceiptParents(projectDir);
    const parsed = JSON.parse(await readReceiptFileNoFollow(path)) as unknown;
    if (!isDurableCommitReceipt(parsed)) throw new Error(`Unreadable durable commit receipt: ${path}`);
    return parsed;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function findDurableReceiptForTransaction(
  projectDir: string,
  chapter: number,
  transactionId: string,
  previewHash: string,
): Promise<DurableCommitReceipt | undefined> {
  const dir = join(projectDir, ".story-engine-ui", "commit-idempotency");
  let entries;
  try {
    await validateExistingReceiptParents(projectDir);
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  let match: DurableCommitReceipt | undefined;
  for (const entry of entries) {
    if (!entry.name.endsWith(".json")) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Unsafe durable commit receipt entry: ${entry.name}`);
    const path = join(dir, entry.name);
    const parsed = JSON.parse(await readReceiptFileNoFollow(path)) as unknown;
    if (!isDurableCommitReceipt(parsed)) throw new Error(`Unreadable durable commit receipt: ${path}`);
    if (
      parsed.projectHash !== sha256(resolve(projectDir))
      || parsed.chapter !== chapter
      || parsed.transactionId !== transactionId
      || parsed.previewHash !== previewHash
    ) continue;
    if (match && !sameReceiptIdentity(match, parsed)) {
      throw new Error("Conflicting durable receipts exist for the same preview transaction.");
    }
    match = parsed;
  }
  return match;
}

async function validateExistingReceiptParents(projectDir: string): Promise<void> {
  for (const path of [projectDir, join(projectDir, ".story-engine-ui"), join(projectDir, ".story-engine-ui", "commit-idempotency")]) {
    const stats = await lstat(path);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`Unsafe durable commit receipt parent: ${path}`);
    }
  }
}

async function readReceiptFileNoFollow(path: string): Promise<string> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const [handleStats, pathStats] = await Promise.all([handle.stat(), lstat(path)]);
    if (
      !handleStats.isFile()
      || pathStats.isSymbolicLink()
      || !pathStats.isFile()
      || handleStats.dev !== pathStats.dev
      || handleStats.ino !== pathStats.ino
      || handleStats.nlink !== 1
    ) {
      throw new Error(`Unsafe durable commit receipt file: ${path}`);
    }
    return await handle.readFile("utf-8");
  } finally {
    await handle.close();
  }
}

async function claimDurableCommitReceipt(projectDir: string, receipt: DurableCommitReceipt): Promise<DurableCommitReceipt | undefined> {
  await ensureReceiptDirectory(projectDir);
  const path = receiptPath(projectDir, receipt.chapter, receipt.idempotencyKey);
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      return readDurableCommitReceipt(projectDir, receipt.chapter, receipt.idempotencyKey);
    }
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return undefined;
}

async function writeDurableCommitReceipt(projectDir: string, receipt: DurableCommitReceipt): Promise<void> {
  const dir = await ensureReceiptDirectory(projectDir);
  const path = receiptPath(projectDir, receipt.chapter, receipt.idempotencyKey);
  const existing = await lstat(path);
  if (!existing.isFile() || existing.isSymbolicLink()) throw new Error(`Unsafe durable commit receipt: ${path}`);
  const tmp = join(dir, `.${sha256(receipt.idempotencyKey).slice(0, 16)}.${process.pid}.${Date.now()}.tmp`);
  const handle = await open(tmp, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf-8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
}

async function removePendingCommitReceipt(projectDir: string, receipt: DurableCommitReceipt): Promise<void> {
  const existing = await readDurableCommitReceipt(projectDir, receipt.chapter, receipt.idempotencyKey);
  if (!existing || existing.status !== "pending") return;
  if (!sameReceiptIdentity(existing, receipt)) return;
  await rm(receiptPath(projectDir, receipt.chapter, receipt.idempotencyKey), { force: true });
}

/**
 * pending 回执的恢复出口（数据安全收口硬不变量 #7：先恢复或拒绝，绝不删证据后重做）。
 * pending 只证明「claim 之后、completed 回执落盘之前」中断，入库成败未知，故先做磁盘对账：
 * 引擎事务残留已在进锁时由 recoverProjectCommitTransactions 收尾（无半写），而 commitFastDraft
 * 把草稿原文写入 chapters/N.md——若该章已入库且内容与当前草稿哈希一致，说明入库其实已成功、
 * 只是回执没写完。此时按磁盘真值补写 completed 回执并重建响应，是恢复而不是重复写入。
 * 对不上（章未入库/内容被改/哈希不一致）一律返回 undefined，由调用方 fail-closed 409。
 */
async function recoverPendingCommitReceiptFromDisk(
  projectDir: string,
  chapter: number,
  receipt: DurableCommitReceipt,
): Promise<CommitApplySuccessPayload | undefined> {
  const draftContent = await readFile(defaultDraftPath(projectDir, chapter), "utf-8").catch(() => undefined);
  if (draftContent === undefined) return undefined;
  const chapterPath = defaultCommittedChapterPath(projectDir, chapter);
  const chapterContent = await readFile(chapterPath, "utf-8").catch(() => undefined);
  if (!chapterContent || sha256(chapterContent) !== sha256(draftContent)) return undefined;
  const warnings = [
    "上次定稿在入库成功后、回执落盘前中断；本次按磁盘真值补写回执并返回结果（恢复，未重复入库）。",
    "详细变更清单不可恢复：report 中 updatedCharacters / timelineEventIds / updatedHooks / updatedWorld / updatedCalendar 均为占位空值（不代表实际未更新），真实变更以磁盘上的状态文件为准。",
  ];
  const overview = await buildStateOverview({ projectDir, chapter, maxTimelineEvents: 8 })
    .catch((error: unknown) => {
      warnings.push(`overview refresh failed after recovered commit: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
  let payload: CommitApplySuccessPayload = {
    ok: true,
    report: {
      chapter,
      passed: true,
      chapterPath,
      // 引擎 CommitReport 这些字段为必填（commit-engine.ts:192-196），标 undefined 不兼容类型；
      // 占位空值的诚实性由上面第二条 warning 承担，recoveredFromPendingReceipt 供前端识别恢复场景。
      updatedCharacters: [],
      timelineEventIds: [],
      updatedHooks: [],
      updatedWorld: false,
      updatedCalendar: false,
      issues: [],
      recoveredFromPendingReceipt: true,
    },
    overview,
    chapterContent,
    chapterTitle: extractDraftTitle(chapterContent) ?? `第${chapter}章`,
    warnings,
  };
  const completedReceipt: DurableCommitReceipt = { ...receipt, status: "completed", payload };
  try {
    await writeDurableCommitReceipt(projectDir, completedReceipt);
  } catch (error) {
    // 与主路径同口径：入库确已成功，回执补写再失败只降级为警告（下次同键重试还会走这条对账）。
    const receiptWarning = `idempotency receipt persistence failed after recovered commit: ${error instanceof Error ? error.message : String(error)}`;
    payload = { ...payload, warnings: [...warnings, receiptWarning] };
  }
  return payload;
}

/** pending 对账失败时的 409 文案：fail-closed，但必须给出可执行出路（含回执文件的确切路径）。 */
function pendingReceiptBlockMessage(projectDir: string, chapter: number, idempotencyKey: string): string {
  const receiptFile = join(".story-engine-ui", "commit-idempotency", basename(receiptPath(projectDir, chapter, idempotencyKey)));
  return `检测到未完成的同键定稿记录，磁盘对账显示该章未按此次预览入库（或草稿在预览后已变化）；为避免重复写入，已拒绝自动重试。`
    + `可执行出路：1) 草稿有改动时，重新生成定稿预览会产出新凭证与新幂等键，按新预览重试即可；`
    + `2) 人工核对确认上次定稿确实未生效后，删除回执文件 ${receiptFile} 再用原预览凭证重试。`;
}

function receiptMatchesRequest(
  receipt: DurableCommitReceipt,
  body: Record<string, unknown>,
  projectDir: string,
  chapter: number,
): boolean {
  return receipt.projectHash === sha256(resolve(projectDir))
    && receipt.chapter === chapter
    && typeof body.transactionId === "string"
    && typeof body.previewHash === "string"
    && typeof body.idempotencyKey === "string"
    && body.transactionId === receipt.transactionId
    && body.previewHash === receipt.previewHash
    && body.idempotencyKey.trim() === receipt.idempotencyKey;
}

function sameReceiptIdentity(left: DurableCommitReceipt, right: DurableCommitReceipt): boolean {
  return left.projectHash === right.projectHash
    && left.chapter === right.chapter
    && left.idempotencyKey === right.idempotencyKey
    && left.transactionId === right.transactionId
    && left.previewHash === right.previewHash;
}

function receiptFromCache(
  entry: Extract<CommitIdempotencyEntry, { readonly status: "completed" }>,
  chapter: number,
  idempotencyKey: string,
  projectDir: string,
): DurableCommitReceipt {
  return {
    version: 1,
    status: "completed",
    projectHash: sha256(resolve(projectDir)),
    chapter,
    idempotencyKey,
    transactionId: entry.transaction.transactionId,
    previewHash: entry.transaction.previewHash,
    createdAt: "memory-cache",
    payload: entry.payload,
  };
}

function isDurableCommitReceipt(value: unknown): value is DurableCommitReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1
    || (record.status !== "pending" && record.status !== "completed")
    || typeof record.projectHash !== "string"
    || !/^[0-9a-f]{64}$/u.test(record.projectHash)
    || typeof record.chapter !== "number"
    || !Number.isInteger(record.chapter)
    || record.chapter <= 0
    || typeof record.idempotencyKey !== "string"
    || !isValidIdempotencyKey(record.idempotencyKey)
    || typeof record.transactionId !== "string"
    || typeof record.previewHash !== "string"
    || typeof record.createdAt !== "string"
  ) return false;
  if (record.status === "completed") {
    const payload = record.payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload) || (payload as { ok?: unknown }).ok !== true) return false;
  }
  return true;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf-8").digest("hex");
}
