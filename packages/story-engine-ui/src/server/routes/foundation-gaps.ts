/**
 * GET  /api/foundation-gaps/report
 * POST /api/foundation-gaps/suggestions
 * POST /api/foundation-gaps/chat
 * POST /api/foundation-gaps/preview
 * POST /api/foundation-gaps/apply
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  buildFoundationGapReport,
  buildFoundationGapSuggestions,
  buildFoundationGapApplyPlan,
  buildStateOverview,
  applyFoundationGapDecisions,
  collectBookExtraFieldKeys,
  toSafeCharacterId,
} from "@actalk/story-engine";
import type { StateOverview } from "@actalk/story-engine";
import type { FoundationGapDecision, FoundationGapSuggestion } from "../../api/types.js";
import {
  assertStoryEngineProject,
  guardProjectPath,
  limitFoundationChatHistory,
  readChatMessages,
  readFoundationGapActionType,
  readFoundationGapCategory,
  readFoundationGapDecisions,
  readFoundationGapSeverity,
  readFoundationGapSuggestions,
  readGeneratedFoundationGapSuggestions,
  readFoundationGapChatActions,
  readString,
  readStringList,
  readJsonBody,
  requireBodyString,
  defaultTargetFileForGapCategory,
  extractJsonObject,
  isRecord,
  withSuggestionSourcePreservation,
  extractExplicitAssetEntity,
  withUiOverviewDetails,
  writeJson,
  type FoundationKnownEntities,
  type MiddlewareStack,
} from "../lib/project-io.js";
import { resolveConfiguredChatModel, callOpenAICompatibleChatModel, type ResolvedChatModel } from "../lib/llm-client.js";
import { buildFoundationGapChatMessages, summarizeFoundationGapReport, summarizeFoundationGapSuggestion, summarizeOverviewForFoundationGapChat } from "../lib/prompt-builder.js";
import { createSnapshot } from "../lib/snapshot.js";

// 归档模型调用要「读上下文 + 决断抽取 + 吐结构化 JSON」，是一次完整推理调用。
// 旧值 15s 是全系统最短的模型超时（内层 LLM 客户端默认 60s、quality judge 25s、连读
// 项目资料都给 30s），混合输入里它常紧跟在一次重章节生成之后打，GLM 代理一慢就撞 15s
// 外层 withTimeout → 误报「模型调用超时」走兜底、把本可落盘的资料（如「她家在城南」）丢掉。
// 调到 45s：高于读资料的 30s、低于内层 60s 硬顶，给推理留足时间又不让用户无限等。
// 注意：这只治「设太短」这一确定性根因；若 45s 仍超时，则是代理/模型真慢（writer.example.com
// max_tokens / 串行调用拥塞），属服务端诊断范畴（safetyWarnings 会透出原因）。
const FOUNDATION_GAP_MODEL_TIMEOUT_MS = 45_000;
const FOUNDATION_GAP_CONTEXT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Route registrar
// ---------------------------------------------------------------------------

export function registerFoundationGapsRoutes(middlewares: MiddlewareStack): void {
  middlewares.use(async (req, res, next) => {
    if (!req.url?.startsWith("/api/foundation-gaps")) {
      next();
      return;
    }

    try {
      if (req.method === "GET" && req.url?.startsWith("/api/foundation-gaps/report")) {
        const url = new URL(req.url, "http://localhost");
        const projectDir = url.searchParams.get("project")?.trim();
        if (!projectDir) {
          writeJson(res, 400, { ok: false, error: "Project path is required." });
          return;
        }
        if (!guardProjectPath(res, projectDir)) return;
        await assertStoryEngineProject(projectDir);
        const report = await buildFoundationGapReport(projectDir);
        writeJson(res, 200, { ok: true, report });
        return;
      }

      if (req.method !== "POST") {
        writeJson(res, 405, { ok: false, error: "Only GET and POST are supported." });
        return;
      }

      const body = await readJsonBody(req);
      const projectDir = requireBodyString(body.projectPath, "项目路径不能为空。");
      if (!guardProjectPath(res, projectDir)) return;
      await assertStoryEngineProject(projectDir);
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

      if (pathname === "/api/foundation-gaps/rollback") {
        const result = await rollbackFoundationGapApply(projectDir, body);
        writeJson(res, result.statusCode, result.payload.ok
          ? { ok: true, result: result.payload.result }
          : { ok: false, error: result.payload.error });
        return;
      }

      if (pathname === "/api/foundation-gaps/confirm-character-write") {
        const result = await confirmCharacterStateWrite(projectDir, body);
        writeJson(res, result.statusCode, result.payload.ok
          ? { ok: true, result: result.payload.result }
          : { ok: false, error: result.payload.error, result: result.payload.result });
        return;
      }

      const decisions = readFoundationGapDecisions(body.decisions);
      const requestSuggestions = readFoundationGapSuggestions(body.currentSuggestions);

      if (req.url?.startsWith("/api/foundation-gaps/chat")) {
        await handleFoundationGapChat(res, body, projectDir, decisions, requestSuggestions);
        return;
      }

      if (req.url?.startsWith("/api/foundation-gaps/suggestions")) {
        const report = await buildFoundationGapReport(projectDir);
        const suggestions = await buildFoundationGapSuggestions(projectDir, report);
        writeJson(res, 200, { ok: true, report, suggestions });
        return;
      }

      if (req.url?.startsWith("/api/foundation-gaps/preview")) {
        const plan = await buildFoundationGapApplyPlan(projectDir, decisions, requestSuggestions);
        writeJson(res, 200, { ok: true, plan });
        return;
      }

      if (req.url?.startsWith("/api/foundation-gaps/apply")) {
        if (body.confirm !== true) {
          writeJson(res, 400, { ok: false, error: "写入资料补全建议需要 confirm=true。" });
          return;
        }
        await createSnapshot(projectDir, "资料写入前快照");
        const undo = await createFoundationGapUndoSnapshot(projectDir, decisions, requestSuggestions);
        const result = await applyFoundationGapDecisions(projectDir, decisions, requestSuggestions);
        writeJson(res, 200, {
          ok: true,
          result: {
            applied: result.applied,
            plan: result.plan,
            writes: result.writes,
            // 修1：透传引擎算好的写入期跳过原因（含真实实体名），让 UI 诚实回报而非自己猜通用句。
            ...(result.skippedWrites && result.skippedWrites.length > 0 ? { skippedWrites: result.skippedWrites } : {}),
            overview: await withUiOverviewDetails(projectDir, result.overview),
            ...(undo.changedFiles.length ? { undo } : {}),
          },
        });
        return;
      }

      writeJson(res, 404, { ok: false, error: "Unknown foundation gap endpoint." });
    } catch (error) {
      writeJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

interface FoundationGapUndoSnapshot {
  readonly version: 1;
  readonly undoId: string;
  readonly createdAt: string;
  readonly files: readonly {
    readonly relativePath: string;
    readonly existed: boolean;
    readonly content: string | null;
  }[];
}

async function createFoundationGapUndoSnapshot(
  projectDir: string,
  decisions: readonly FoundationGapDecision[],
  requestSuggestions: readonly FoundationGapSuggestion[],
): Promise<{ readonly undoId: string; readonly changedFiles: readonly string[] }> {
  const plan = await buildFoundationGapApplyPlan(projectDir, decisions, requestSuggestions);
  const changedFiles = [...new Set(plan.fileChanges.map((item) => item.targetFile))].sort();
  const undoId = `foundation-${Date.now()}-${randomUUID()}`;
  if (changedFiles.length === 0) return { undoId, changedFiles };
  const files = await Promise.all(changedFiles.map(async (relativePath) => {
    const content = await readFile(join(projectDir, relativePath), "utf-8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    return {
      relativePath,
      existed: content !== null,
      content,
    };
  }));
  const snapshot: FoundationGapUndoSnapshot = {
    version: 1,
    undoId,
    createdAt: new Date().toISOString(),
    files,
  };
  const snapshotPath = foundationGapUndoSnapshotPath(projectDir, undoId);
  await mkdir(dirname(snapshotPath), { recursive: true });
  await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
  return { undoId, changedFiles };
}

async function rollbackFoundationGapApply(
  projectDir: string,
  body: Record<string, unknown>,
): Promise<{
  readonly statusCode: number;
  readonly payload:
    | { readonly ok: true; readonly result: { readonly undoId: string; readonly restoredFiles: readonly string[]; readonly overview: StateOverview } }
    | { readonly ok: false; readonly error: string };
}> {
  const undoId = readString(body.undoId);
  if (!undoId || !/^foundation-\d+-[0-9a-f-]{36}$/u.test(undoId)) {
    return { statusCode: 400, payload: { ok: false, error: "撤回记录无效。" } };
  }
  const snapshotPath = foundationGapUndoSnapshotPath(projectDir, undoId);
  const snapshotRaw = await readFile(snapshotPath, "utf-8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!snapshotRaw) {
    return { statusCode: 404, payload: { ok: false, error: "没有找到这次修改的撤回记录。" } };
  }
  const snapshot = JSON.parse(snapshotRaw) as FoundationGapUndoSnapshot;
  if (snapshot.version !== 1 || snapshot.undoId !== undoId || !Array.isArray(snapshot.files)) {
    return { statusCode: 400, payload: { ok: false, error: "撤回记录已损坏。" } };
  }
  const restoredFiles: string[] = [];
  for (const file of snapshot.files) {
    if (!isSafeFoundationUndoPath(file.relativePath)) {
      return { statusCode: 400, payload: { ok: false, error: "撤回记录包含非法路径。" } };
    }
    const absolutePath = join(projectDir, file.relativePath);
    if (file.existed) {
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, file.content ?? "", "utf-8");
    } else {
      await rm(absolutePath, { force: true });
    }
    restoredFiles.push(file.relativePath);
  }
  const overview = await buildStateOverview({ projectDir, maxTimelineEvents: 8 });
  return {
    statusCode: 200,
    payload: {
      ok: true,
      result: {
        undoId,
        restoredFiles,
        overview: await withUiOverviewDetails(projectDir, overview),
      },
    },
  };
}

function foundationGapUndoSnapshotPath(projectDir: string, undoId: string): string {
  return join(projectDir, ".story-engine-ui", "foundation-undo", `${undoId}.json`);
}

function isSafeFoundationUndoPath(relativePath: string): boolean {
  return /^(?:story\/(?:writing-rules|world-bible|location-bible|assets|character-matrix|character-bible)\.json|characters\/[^/]+\/(?:profile|core|state)\.json)$/u.test(relativePath);
}

// ---------------------------------------------------------------------------
// Character state confirm write
// ---------------------------------------------------------------------------

type CharacterStateConfirmStatus = "committed" | "blocked" | "failed";

interface CharacterStateConfirmResult {
  readonly status: CharacterStateConfirmStatus;
  readonly scope: "character_state_only";
  readonly reason?: string;
  readonly changedFiles: readonly string[];
  readonly didWriteCharacterState: boolean;
  readonly didWriteCharacterProfile: false;
  readonly didWriteCharacterBible: false;
  readonly didWriteCharacterMatrix: false;
  readonly didWriteChapterMarkdown: false;
  readonly didWriteTimeline: false;
  readonly didWriteWorld: false;
  readonly didWriteMemory: false;
  readonly didCallCommitEngine: false;
  readonly didCallApplyCommit: false;
  readonly stateOverviewRefreshRequested: boolean;
  readonly stateOverviewRefreshSucceeded: boolean;
  readonly stateOverviewRefreshError: string | null;
  readonly rollbackAttempted: boolean;
  readonly rollbackSucceeded: boolean | null;
  readonly residue: readonly string[];
  readonly idempotencyReplayed?: boolean;
  readonly overview?: StateOverview;
}

interface CharacterStateConfirmPayload {
  readonly ok: boolean;
  readonly error?: string;
  readonly result: CharacterStateConfirmResult;
}

interface JsonSnapshot {
  readonly exists: boolean;
  readonly value: Record<string, unknown>;
}

interface CharacterStateBackup {
  readonly exists: boolean;
  readonly content: string;
}

const CHARACTER_STATE_PATCH_ALLOWED_KEYS = new Set([
  "currentGoal",
  "mood",
  "relationshipToProtagonist",
  "recentEvents",
  "currentArc",
  "notes",
  "updatedAt",
]);

const CHARACTER_STATE_CONFIRM_ALLOWED_FIELDS = new Set([
  "projectPath",
  "characterId",
  "targetFile",
  "previewHash",
  "baseHash",
  "idempotencyKey",
  "explicitConfirm",
  "suggestionIds",
  "statePatch",
]);

async function confirmCharacterStateWrite(
  projectDir: string,
  body: Record<string, unknown>,
): Promise<{ readonly statusCode: number; readonly payload: CharacterStateConfirmPayload }> {
  const forbiddenFields = Object.keys(body).filter((field) => !CHARACTER_STATE_CONFIRM_ALLOWED_FIELDS.has(field)).sort();
  if (forbiddenFields.length > 0) {
    return blockedCharacterStateWrite(400, `forbidden_fields:${forbiddenFields.join(",")}`);
  }
  const parsed = parseCharacterStateConfirmBody(body);
  if (!parsed.ok) return blockedCharacterStateWrite(parsed.statusCode, parsed.reason);

  const input = parsed.input;
  const idempotencyPath = characterStateIdempotencyPath(projectDir, input.characterId, input.idempotencyKey);
  const requestFingerprint = sha256(stableJson(input));
  const idempotency: Record<string, unknown> = await readJsonRecordOrEmpty(idempotencyPath).catch(() => ({}));
  if (typeof idempotency.requestFingerprint === "string") {
    if (idempotency.requestFingerprint !== requestFingerprint) {
      return blockedCharacterStateWrite(409, "idempotency_conflict");
    }
    return {
      statusCode: 200,
      payload: {
        ok: true,
        result: {
          ...committedCharacterStateResult(input.targetFile),
          idempotencyReplayed: true,
        },
      },
    };
  }

  const targetPath = join(projectDir, input.targetFile);
  const currentSnapshot = await readJsonRecordSnapshot(targetPath);
  const current = currentSnapshot.value;
  if (sha256(stableJson(current)) !== input.baseHash) {
    return blockedCharacterStateWrite(409, "base_hash_mismatch");
  }
  if (sha256(stableJson({
    characterId: input.characterId,
    targetFile: input.targetFile,
    suggestionIds: input.suggestionIds,
    statePatch: input.statePatch,
  })) !== input.previewHash) {
    return blockedCharacterStateWrite(409, "preview_hash_mismatch");
  }

  const next = { ...current, ...input.statePatch };
  const backup: CharacterStateBackup = {
    exists: currentSnapshot.exists,
    content: stableJson(current),
  };
  const nextContent = `${JSON.stringify(next, null, 2)}\n`;
  const tempPath = `${targetPath}.tmp-${sha256(input.idempotencyKey).slice(0, 12)}`;
  let didWrite = false;
  // 幂等/哈希等只读校验全部通过，确认要写角色状态文件，先留可撤销快照
  await createSnapshot(projectDir, "角色资料写入前快照");
  try {
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(tempPath, nextContent, "utf-8");
    await rename(tempPath, targetPath);
    didWrite = true;
    const refresh = await refreshOverview(projectDir);
    const result: CharacterStateConfirmResult = {
      ...committedCharacterStateResult(input.targetFile),
      stateOverviewRefreshRequested: true,
      stateOverviewRefreshSucceeded: Boolean(refresh.overview),
      stateOverviewRefreshError: refresh.error,
      overview: refresh.overview,
    };
    await mkdir(dirname(idempotencyPath), { recursive: true });
    await writeFile(idempotencyPath, `${JSON.stringify({
      requestFingerprint,
      result: { ...result, overview: undefined },
    }, null, 2)}\n`, "utf-8");
    return { statusCode: 200, payload: { ok: true, result } };
  } catch (error) {
    // tmp 残留给快照扫进 git 的前科（writeFileAtomic 同口径）：rename 未成功时临时文件还在原地，必须清掉；
    // didWrite=true 时 rename 已消费掉 tempPath，force rm 对其自然空转。清理失败绝不盖过原始错误。
    await rm(tempPath, { force: true }).catch(() => undefined);
    const rollback = didWrite ? await rollbackCharacterStateWrite(targetPath, backup) : { attempted: false, succeeded: null };
    return {
      statusCode: 500,
      payload: {
        ok: false,
        error: "character_state_write_failed",
        result: {
          ...baseCharacterStateResult("failed", "character_state_write_failed"),
          rollbackAttempted: rollback.attempted,
          rollbackSucceeded: rollback.succeeded,
          residue: rollback.succeeded === false ? [input.targetFile] : [],
          stateOverviewRefreshRequested: false,
          stateOverviewRefreshSucceeded: false,
          stateOverviewRefreshError: error instanceof Error ? error.message : String(error),
        },
      },
    };
  }
}

function parseCharacterStateConfirmBody(body: Record<string, unknown>):
  | { readonly ok: true; readonly input: {
    readonly projectPath: string;
    readonly characterId: string;
    readonly targetFile: `characters/${string}/state.json`;
    readonly previewHash: string;
    readonly baseHash: string;
    readonly idempotencyKey: string;
    readonly explicitConfirm: true;
    readonly suggestionIds: readonly string[];
    readonly statePatch: Readonly<Record<string, unknown>>;
  } }
  | { readonly ok: false; readonly statusCode: number; readonly reason: string } {
  const projectPath = readString(body.projectPath);
  const characterId = readString(body.characterId);
  const targetFile = readString(body.targetFile);
  const previewHash = readString(body.previewHash);
  const baseHash = readString(body.baseHash);
  const idempotencyKey = readString(body.idempotencyKey);
  if (!projectPath) return { ok: false, statusCode: 400, reason: "missing_project_path" };
  if (!characterId) return { ok: false, statusCode: 400, reason: "missing_character_id" };
  if (!targetFile) return { ok: false, statusCode: 400, reason: "missing_target_file" };
  if (!previewHash) return { ok: false, statusCode: 400, reason: "missing_preview_hash" };
  if (!baseHash) return { ok: false, statusCode: 400, reason: "missing_base_hash" };
  if (!idempotencyKey) return { ok: false, statusCode: 400, reason: "missing_idempotency_key" };
  if (body.explicitConfirm !== true) return { ok: false, statusCode: 400, reason: "missing_explicit_confirm" };
  if (isAbsolute(targetFile) || targetFile.includes("..") || targetFile.includes("\0")) {
    return { ok: false, statusCode: 400, reason: "invalid_target_file" };
  }
  const safeCharacterId = toSafeCharacterId(characterId);
  const expectedTargetFile: `characters/${string}/state.json` = `characters/${safeCharacterId}/state.json`;
  if (targetFile !== expectedTargetFile) {
    return { ok: false, statusCode: 400, reason: "target_file_must_be_character_state_only" };
  }
  const suggestionIds = readStringList(body.suggestionIds);
  if (suggestionIds.length === 0) return { ok: false, statusCode: 400, reason: "missing_suggestion_ids" };
  if (!isRecord(body.statePatch)) return { ok: false, statusCode: 400, reason: "missing_state_patch" };
  const forbiddenPatchKeys = Object.keys(body.statePatch).filter((key) => !CHARACTER_STATE_PATCH_ALLOWED_KEYS.has(key)).sort();
  if (forbiddenPatchKeys.length > 0) {
    return { ok: false, statusCode: 400, reason: `forbidden_state_patch_keys:${forbiddenPatchKeys.join(",")}` };
  }
  if (Object.keys(body.statePatch).length === 0) return { ok: false, statusCode: 400, reason: "empty_state_patch" };
  return {
    ok: true,
    input: {
      projectPath,
      characterId: safeCharacterId,
      targetFile: expectedTargetFile,
      previewHash,
      baseHash,
      idempotencyKey,
      explicitConfirm: true,
      suggestionIds,
      statePatch: body.statePatch,
    },
  };
}

function blockedCharacterStateWrite(statusCode: number, reason: string): { readonly statusCode: number; readonly payload: CharacterStateConfirmPayload } {
  return {
    statusCode,
    payload: {
      ok: false,
      error: reason,
      result: baseCharacterStateResult("blocked", reason),
    },
  };
}

function baseCharacterStateResult(status: CharacterStateConfirmStatus, reason?: string): CharacterStateConfirmResult {
  return {
    status,
    scope: "character_state_only",
    ...(reason ? { reason } : {}),
    changedFiles: [],
    didWriteCharacterState: false,
    didWriteCharacterProfile: false,
    didWriteCharacterBible: false,
    didWriteCharacterMatrix: false,
    didWriteChapterMarkdown: false,
    didWriteTimeline: false,
    didWriteWorld: false,
    didWriteMemory: false,
    didCallCommitEngine: false,
    didCallApplyCommit: false,
    stateOverviewRefreshRequested: false,
    stateOverviewRefreshSucceeded: false,
    stateOverviewRefreshError: null,
    rollbackAttempted: false,
    rollbackSucceeded: null,
    residue: [],
  };
}

function committedCharacterStateResult(targetFile: string): CharacterStateConfirmResult {
  return {
    ...baseCharacterStateResult("committed"),
    changedFiles: [targetFile],
    didWriteCharacterState: true,
  };
}

async function readJsonRecordOrEmpty(path: string): Promise<Record<string, unknown>> {
  const source = await readFile(path, "utf-8").catch(() => "{}");
  const parsed = JSON.parse(source) as unknown;
  return isRecord(parsed) ? parsed : {};
}

async function readJsonRecordSnapshot(path: string): Promise<JsonSnapshot> {
  try {
    const source = await readFile(path, "utf-8");
    const parsed = JSON.parse(source) as unknown;
    return { exists: true, value: isRecord(parsed) ? parsed : {} };
  } catch (error) {
    if (isNodeEnoent(error)) return { exists: false, value: {} };
    throw error;
  }
}

async function rollbackCharacterStateWrite(targetPath: string, backup: CharacterStateBackup): Promise<{ readonly attempted: true; readonly succeeded: boolean } | { readonly attempted: false; readonly succeeded: null }> {
  try {
    if (backup.exists) {
      await writeFile(targetPath, `${JSON.stringify(JSON.parse(backup.content) as unknown, null, 2)}\n`, "utf-8");
    } else {
      await rm(targetPath, { force: true });
    }
    return { attempted: true, succeeded: true };
  } catch {
    return { attempted: true, succeeded: false };
  }
}

function isNodeEnoent(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

async function refreshOverview(projectDir: string): Promise<{ readonly overview?: StateOverview; readonly error: string | null }> {
  try {
    return {
      overview: await withUiOverviewDetails(projectDir, await buildStateOverview({ projectDir, maxTimelineEvents: 8 })),
      error: null,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function characterStateIdempotencyPath(projectDir: string, characterId: string, idempotencyKey: string): string {
  return join(projectDir, ".story-engine-tx", "foundation-character-state", characterId, `idempotency-${sha256(idempotencyKey).slice(0, 16)}.json`);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf-8").digest("hex");
}

// 写入承诺的语言指纹：模型嘴上说「会写/已写/写进去」时常用的表述。
// 命中其一即视为「这句话承诺了写入」。当结构化 suggestions 实际为空，这类承诺就是空头支票。
const FOUNDATION_WRITE_PROMISE_PATTERN =
  /(?:整理|归纳|提取|抽取|梳理)(?:出|了)?\s*\d+\s*条|马上写入|立即写入|现在写入|这就写入|已写入|已经写入|都写进去|都写入|写进资料|写入资料|帮你写入|为你写入|这就(?:记|写)下|已记入|已落盘|这就落盘|马上落盘/u;

const FOUNDATION_NO_WRITE_HONEST_REPLY =
  "这次没有谈妥可以直接落盘的资料点，所以没有写入任何文件。你可以把要记的资料点说得更具体些，我再整理。";

/**
 * 一致性兜底（问题 A）：当 reply 含写入承诺、但实际没有可落盘 suggestions 时，
 * 把这句空头承诺从 reply 里剔除/改写成如实文案，绝不把「说了没写」透传给用户。
 *
 * 策略：按句切分，逐句剔除含写入承诺指纹的句子；若剔光了就回退到统一的如实文案，
 * 否则保留其余非承诺内容（模型可能还说了有用的话）并附一句如实说明。
 */
function rewriteUnfulfilledFoundationWritePromise(reply: string): string {
  if (!FOUNDATION_WRITE_PROMISE_PATTERN.test(reply)) return reply;
  // 以中英文句末标点切句，保留分隔符以便判断空白。
  const sentences = reply.split(/(?<=[。！？!?\n])/u);
  const kept = sentences
    .filter((sentence) => !FOUNDATION_WRITE_PROMISE_PATTERN.test(sentence))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
  if (kept.length === 0) return FOUNDATION_NO_WRITE_HONEST_REPLY;
  return `${kept.join("")}\n\n${FOUNDATION_NO_WRITE_HONEST_REPLY}`;
}

// ---------------------------------------------------------------------------
// Chat handler
// ---------------------------------------------------------------------------

async function handleFoundationGapChat(
  res: import("node:http").ServerResponse,
  body: Record<string, unknown>,
  projectDir: string,
  decisions: readonly import("@actalk/story-engine").FoundationGapDecision[],
  requestSuggestions: readonly FoundationGapSuggestion[],
): Promise<void> {
  const userMessage = requireBodyString(body.userMessage, "资料补全对话内容不能为空。");
  const context = await withTimeout(
    buildFoundationGapChatContext(body, projectDir),
    FOUNDATION_GAP_CONTEXT_TIMEOUT_MS,
    "资料 Agent 读取项目资料超时。",
  ).catch(() => null);
  if (!context) {
    writeJson(res, 200, {
      ok: true,
      result: {
        reply: "资料读取超时，未写入任何文件。请稍后重试。",
        focusedGapIds: [],
        focusedSuggestionIds: [],
        generatedSuggestions: [],
        suggestedActions: [],
        safetyWarnings: ["foundation_context_timeout"],
        fallbackUsed: true,
      },
    });
    return;
  }
  const {
    report,
    suggestions,
    overview,
    explicitWriteOptions,
    history,
    selectedCategory,
    currentDraft,
    currentIntent,
    currentDraftContent,
    existingExtraFieldKeys,
    directArchive,
  } = context;
  const fallback = deterministicFoundationGapChat({
    currentDraft,
    currentIntent,
    message: userMessage,
    report,
    suggestions,
    selectedCategory,
    explicitWriteOptions,
    directArchive,
  });

  try {
    const configured = await resolveConfiguredChatModel("chapterSteering");
    const modelResult = await withTimeout(
      callFoundationGapChatModel({
        configured,
        history,
        message: userMessage,
        currentDraftContent,
        overview,
        report,
        selectedCategory,
        currentDraft,
        currentIntent,
        suggestions,
        existingExtraFieldKeys,
        directArchive,
      }),
      FOUNDATION_GAP_MODEL_TIMEOUT_MS,
      "资料 Agent 模型调用超时，已切换确定性兜底。",
    );
    let resolvedSuggestions = resolveFoundationChatSuggestions({
      currentDraft,
      currentIntent,
      message: userMessage,
      modelResult,
      selectedCategory,
      explicitWriteOptions,
    });
    // H4 兜底安全网（成功路径）：directArchive 下模型返回了合法 JSON 但没吐出任何可写卡时
    //（如「她家在城南」——模型听懂了却退回交互式「没有谈妥」话术、出空卡），对「<主语>家在/住在<地点>」
    // 这类高把握句式确定性补一条角色居所卡，保证简单事实不因模型不吐卡而漏存。reply 同步改成如实文案。
    let residenceNetReply: string | undefined;
    if (
      directArchive
      && resolvedSuggestions.generatedSuggestions.length === 0
      && !resolvedSuggestions.draftSuggestion
    ) {
      const residenceDraft = buildDirectArchiveResidenceSuggestion(userMessage, explicitWriteOptions);
      if (residenceDraft) {
        const place = (residenceDraft.after as { readonly extraFields?: Record<string, unknown> } | undefined)?.extraFields?.["居所"];
        // 对齐已验证的模型生成路径（旗舰「林晚突破金丹期」）：只放 generatedSuggestions（apply 的落盘源），
        // 不另设 draftSuggestion，避免 UI 把同一条当草案卡 + 建议卡双重渲染。
        resolvedSuggestions = {
          ...resolvedSuggestions,
          intent: residenceDraft.actionType,
          generatedSuggestions: [residenceDraft],
          focusedSuggestionIds: [residenceDraft.id],
        };
        residenceNetReply = `我整理了 1 条：把「${residenceDraft.extractedEntityName}」的居所记为${place ?? ""}，确认后写入、可在操作历史撤销。`;
      }
    }
    // 一致性兜底（问题 A）：模型的 reply（自由文本）与 generatedSuggestions/draftSuggestion
    // （结构化）是同一份 JSON 里分别填的两个字段。当最终可落盘的 suggestions 真为空、但 reply
    // 含「整理了 N 条 / 马上写入 / 已写入」这类写入承诺时，不能把这句承诺透传给用户——
    // 改写成如实文案，消除「说了没写」。只在 suggestions 真为空时改写；有 suggestions 时不动。
    const hasResolvedSuggestions = resolvedSuggestions.generatedSuggestions.length > 0
      || Boolean(resolvedSuggestions.draftSuggestion);
    const honestModelReply = residenceNetReply
      ?? (hasResolvedSuggestions
        ? modelResult.reply
        : rewriteUnfulfilledFoundationWritePromise(modelResult.reply));
    const reply = resolvedSuggestions.explicitSuggestions.length > 0
      ? `${honestModelReply}\n\n我已按你明确列出的内容整理出 ${resolvedSuggestions.explicitSuggestions.length} 条资料草案，确认前不会写入正式资料。`
      : resolvedSuggestions.usedDeterministicDraft
        ? `${honestModelReply}\n\n我也先按你给的信息整理了一张固定格式草案卡。你可以继续补充，也可以先看草案。`
      : honestModelReply;
    writeJson(res, 200, {
      ok: true,
      result: {
        ...modelResult,
        reply,
        ...(resolvedSuggestions.intent ? { intent: resolvedSuggestions.intent } : {}),
        draftSuggestion: resolvedSuggestions.draftSuggestion,
        generatedSuggestions: resolvedSuggestions.generatedSuggestions,
        focusedSuggestionIds: resolvedSuggestions.focusedSuggestionIds,
        modelProfile: `${configured.profile.id} / ${configured.profile.model}`,
        fallbackUsed: false,
      },
    });
  } catch (error) {
    // 绝不静默吞掉模型调用失败（超时 / 空内容 / 非 JSON / 上游抛错）：
    // 1) 记日志（带 directArchive 上下文，供 Codex 诊断「是模型调用挂了」而非逻辑空建议）。
    // 2) 在响应里透出诊断字段 safetyWarnings:["foundation_model_call_failed: <reason>"]
    //    （已有 foundation_context_timeout 先例）。reason 仅取错误 message 摘要、不带 stack。
    // 3) reply 仍走兜底的友好文案、绝不把 stack/原始错误透传给终端用户。
    const reason = summarizeFoundationModelError(error);
    console.error(
      `[foundation-gaps] foundation chat model call failed (directArchive=${directArchive}): ${reason}`,
    );
    writeJson(res, 200, {
      ok: true,
      result: {
        ...fallback,
        fallbackUsed: true,
        safetyWarnings: [`foundation_model_call_failed: ${reason}`],
      },
    });
  }
}

/**
 * 把模型调用错误压成一行可诊断的摘要：只取 message 首行、截断，绝不带 stack。
 * 供 safetyWarnings 诊断字段与日志使用——让 Codex/前端能看到「模型挂了」的原因，
 * 但不把完整 stack 透给终端用户。
 */
function summarizeFoundationModelError(error: unknown): string {
  const raw = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "unknown_error";
  const firstLine = raw.split("\n")[0]?.trim() ?? "unknown_error";
  const collapsed = firstLine.replace(/\s+/gu, " ");
  return collapsed.length > 200 ? `${collapsed.slice(0, 200)}…` : (collapsed || "unknown_error");
}

async function buildFoundationGapChatContext(
  body: Record<string, unknown>,
  projectDir: string,
): Promise<{
  readonly report: Awaited<ReturnType<typeof buildFoundationGapReport>>;
  readonly suggestions: readonly FoundationGapSuggestion[];
  readonly overview: StateOverview;
  readonly explicitWriteOptions: ReturnType<typeof foundationWriteOptionsFromOverview>;
  readonly history: ReturnType<typeof readChatMessages>;
  readonly selectedCategory: string | undefined;
  readonly currentDraft: FoundationGapSuggestion | undefined;
  readonly currentIntent: FoundationGapSuggestion["actionType"] | undefined;
  readonly currentDraftContent: string | undefined;
  readonly existingExtraFieldKeys: readonly string[];
  readonly directArchive: boolean;
}> {
  const report = await buildFoundationGapReport(projectDir);
  const existingSuggestions = readFoundationGapSuggestions(body.currentSuggestions);
  const suggestions = existingSuggestions.length ? existingSuggestions : await buildFoundationGapSuggestions(projectDir, report);
  const overview = await buildStateOverview({ projectDir, maxTimelineEvents: 5 });
  // 采集本书四类卡已有的自定义字段键，喂进归档 prompt 以闭合「字段复用」环。
  // 采集器内部已优雅降级（读失败返回 []），这里不让它阻断归档。
  const existingExtraFieldKeys = await collectBookExtraFieldKeys(projectDir).catch(() => [] as const);
  return {
    report,
    suggestions,
    overview,
    explicitWriteOptions: foundationWriteOptionsFromOverview(overview),
    history: limitFoundationChatHistory(readChatMessages(body.chatHistory)),
    selectedCategory: readString(body.selectedCategory),
    currentDraft: readFoundationGapSuggestions(body.currentDraft ? [body.currentDraft] : [])[0],
    currentIntent: readFoundationGapActionType(body.currentIntent),
    currentDraftContent: readFoundationGapDraftContent(body.currentDraftContent),
    existingExtraFieldKeys,
    // triage 分诊出的归档请求带 directArchive:true：走决断式抽取契约（见 buildFoundationGapChatSystemPrompt）。
    directArchive: body.directArchive === true,
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(resolve, reject).finally(() => {
      if (timeoutId) clearTimeout(timeoutId);
    });
  });
}

// ---------------------------------------------------------------------------
// Model call
// ---------------------------------------------------------------------------

type FoundationGapChatModelResult = {
  readonly reply: string;
  readonly intent?: FoundationGapSuggestion["actionType"];
  readonly askedQuestions: readonly string[];
  readonly draftSuggestion?: FoundationGapSuggestion;
  readonly missingFields: readonly string[];
  readonly focusedCategory?: FoundationGapSuggestion["category"];
  readonly focusedGapIds: readonly string[];
  readonly focusedSuggestionIds: readonly string[];
  readonly generatedSuggestions: readonly FoundationGapSuggestion[];
  readonly suggestedActions: readonly { readonly id: string; readonly label: string }[];
  readonly safetyWarnings: readonly string[];
};

function readFoundationGapDraftContent(value: unknown): string | undefined {
  const source = readString(value);
  if (!source) return undefined;
  const normalized = source.replace(/\s+/gu, " ").trim();
  return normalized.length > 6000 ? normalized.slice(0, 6000) : normalized;
}

async function callFoundationGapChatModel(input: {
  readonly configured: ResolvedChatModel;
  readonly currentDraft?: FoundationGapSuggestion;
  readonly currentDraftContent?: string;
  readonly currentIntent?: FoundationGapSuggestion["actionType"];
  readonly history: readonly { readonly role: "user" | "assistant"; readonly content: string }[];
  readonly message: string;
  readonly overview: StateOverview;
  readonly report: Awaited<ReturnType<typeof buildFoundationGapReport>>;
  readonly selectedCategory?: string;
  readonly suggestions: readonly FoundationGapSuggestion[];
  readonly existingExtraFieldKeys?: readonly string[];
  readonly directArchive?: boolean;
}): Promise<FoundationGapChatModelResult> {
  const messages = buildFoundationGapChatMessages(input);
  const { content, raw } = await callOpenAICompatibleChatModel({
    configured: input.configured,
    messages,
    temperature: input.configured.profile.temperature ?? 0.45,
    responseFormat: { type: "json_object" },
    stream: false,
  });
  if (!content) throw new Error("模型返回了空内容。");
  const json = extractJsonObject(content);
  if (!json) throw new Error("模型没有返回合法 JSON。");
  return normalizeFoundationGapChatResult(JSON.parse(json) as unknown, input.suggestions, input.report, input.message, buildFoundationKnownEntities(input.overview));
}

// ---------------------------------------------------------------------------
// Deterministic fallback
// ---------------------------------------------------------------------------

function deterministicFoundationGapChat(input: {
  readonly currentDraft?: FoundationGapSuggestion;
  readonly currentIntent?: FoundationGapSuggestion["actionType"];
  readonly explicitWriteOptions?: ExplicitFoundationWriteOptions;
  readonly message: string;
  readonly report: Awaited<ReturnType<typeof buildFoundationGapReport>>;
  readonly selectedCategory?: string;
  readonly suggestions: readonly FoundationGapSuggestion[];
  readonly directArchive?: boolean;
}): FoundationGapChatModelResult {
  const intent = inferFoundationGapChatIntent(input.message, input.currentIntent);
  const category = categoryForFoundationGapIntent(intent) ?? inferFoundationGapChatCategory(input.message, input.selectedCategory);
  if (isFoundationCompletenessQuestion(input.message)) {
    return buildFoundationCompletenessReply(input, intent, category);
  }
  if (intent === "delete_foundation_entry") {
    return buildDeterministicDeleteReply(input.message, input.explicitWriteOptions);
  }
  // 修 2（directArchive 兜底加固）：归档模式下，模型偶发失败时仍尽力兜底。
  // 既有交互门槛（写入动词 / intent + shouldDraftFoundationSchema 的长度/关键词阈值）
  // 对「城南有家面馆叫老周面馆」这类无写入动词的裸陈述句会产 0 条。directArchive=true 时
  // 绕过这道门槛，对带「明确命名实体」的裸陈述句做一次决断式抽取——抽得出可靠结构就返回草案，
  // 抽不出就如实返回空（不硬造卡）。非 directArchive 不走这条，保持交互门槛不变。
  if (input.directArchive) {
    const decisiveDraft = buildDirectArchiveResidenceSuggestion(input.message, input.explicitWriteOptions)
      ?? buildDirectArchiveDecisiveSuggestion(input.message, intent, input.currentDraft);
    if (decisiveDraft) {
      return {
        reply: "我先按你说的信息直接整理成一张固定格式草案，写入前自动快照、可在操作历史撤销。",
        ...(decisiveDraft.actionType ? { intent: decisiveDraft.actionType } : {}),
        askedQuestions: [],
        draftSuggestion: decisiveDraft,
        missingFields: [],
        ...(decisiveDraft.category ? { focusedCategory: decisiveDraft.category } : {}),
        focusedGapIds: [],
        focusedSuggestionIds: [decisiveDraft.id],
        generatedSuggestions: [decisiveDraft],
        suggestedActions: [
          { id: "accept-visible", label: "接受草案" },
          { id: "edit-visible", label: "改一下" },
        ],
        safetyWarnings: [],
      };
    }
    // directArchive 但抽不出可靠结构（如指代不明「她家在城南」——whose home?）：
    // 不绕到下面的「intent 追问」分支硬造卡，直接如实返回空 writes + 诚实文案（保 G1）。
    if (!intent) {
      return {
        reply: FOUNDATION_NO_WRITE_HONEST_REPLY,
        askedQuestions: [],
        missingFields: [],
        focusedGapIds: [],
        focusedSuggestionIds: [],
        generatedSuggestions: [],
        suggestedActions: [{ id: "continue-chat", label: "继续补充" }],
        safetyWarnings: [],
      };
    }
  }
  const draftSuggestion = shouldDraftFoundationSchema(input.message, intent, input.currentDraft)
    ? buildDeterministicSchemaSuggestion(input.message, intent, input.currentDraft)
    : undefined;
  const explicitSuggestions = draftSuggestion ? [] : buildExplicitFoundationWriteSuggestions(input.message, input.explicitWriteOptions);
  if (explicitSuggestions.length > 0) {
    return {
      reply: `我已按你明确列出的内容整理出 ${explicitSuggestions.length} 条资料草案。请检查是否准确；确认前不会写入正式资料。`,
      ...(intent ? { intent } : {}),
      askedQuestions: [],
      missingFields: [],
      ...(category ? { focusedCategory: category } : {}),
      focusedGapIds: [],
      focusedSuggestionIds: explicitSuggestions.map((suggestion) => suggestion.id),
      generatedSuggestions: explicitSuggestions,
      suggestedActions: [
        { id: "accept-visible", label: "接受草案" },
        { id: "preview-write", label: "生成写入预览" },
      ],
      safetyWarnings: [],
    };
  }
  if (intent && !draftSuggestion) {
    const questions = requiredQuestionsForFoundationIntent(intent);
    return {
      reply: `${schemaAssistantQuestionReply(intent)}\n\n${questions.map((question, index) => `${index + 1}. ${question}`).join("\n")}`,
      intent,
      askedQuestions: questions,
      missingFields: missingFieldsForFoundationIntent(intent),
      ...(category ? { focusedCategory: category } : {}),
      focusedGapIds: [],
      focusedSuggestionIds: [],
      generatedSuggestions: [],
      suggestedActions: [
        { id: "continue-chat", label: "继续补充" },
        { id: "scan-gaps", label: "检查缺口" },
      ],
      safetyWarnings: [],
    };
  }
  if (draftSuggestion) {
    return {
      reply: "我先按你提供的信息整理成一张固定格式草案。请检查是否准确；你接受后会直接写入，写入前自动快照，可在操作历史撤销。",
      ...(intent ? { intent } : {}),
      askedQuestions: [],
      draftSuggestion,
      missingFields: [],
      ...(category ? { focusedCategory: category } : {}),
      focusedGapIds: [],
      focusedSuggestionIds: [draftSuggestion.id],
      generatedSuggestions: [draftSuggestion],
      suggestedActions: [
        { id: "accept-visible", label: "接受草案" },
        { id: "edit-visible", label: "改一下" },
        { id: "preview-write", label: "生成写入预览" },
      ],
      safetyWarnings: [],
    };
  }
  const focusedSuggestions = category
    ? input.suggestions.filter((suggestion) => suggestion.category === category).slice(0, 3)
    : input.suggestions.slice(0, 3);
  const topGaps = category
    ? (input.report.byCategory[category] ?? []).slice(0, 3)
    : [...input.report.riskyItems, ...input.report.missingItems].slice(0, 3);
  return {
    reply: topGaps.length
      ? `我先按当前资料帮你抓重点：最影响继续写作的是 ${topGaps.map((item) => item.title).join("、")}。你可以选一个方向继续聊，我会整理成草案卡，确认前不会写入。`
      : "当前扫描结果里没有明显高风险缺口。你可以继续指定要补角色、地点、资产或世界观。",
    ...(intent ? { intent } : {}),
    askedQuestions: [],
    missingFields: [],
    ...(category ? { focusedCategory: category } : {}),
    focusedGapIds: topGaps.map((item) => item.id),
    focusedSuggestionIds: focusedSuggestions.map((item) => item.id),
    generatedSuggestions: [],
    suggestedActions: [
      { id: "accept-visible", label: "没问题" },
      { id: "edit-visible", label: "改一下" },
      { id: "preview-write", label: "生成写入预览" },
    ],
    safetyWarnings: [],
  };
}

/**
 * 修 2：directArchive 决断式兜底抽取。
 *
 * 当模型调用失败、且既有 intent/写入动词门槛产不出草案时，对「带明确命名实体的裸陈述句」
 * 尽力抽一条结构化草案。「尽力抽」≠「硬造」：
 *  - 抽得出可靠的命名实体（如「X叫Y」里的 Y、或带地点/资产类型名词的实体）→ 复用既有确定性
 *    schema 构建器产草案。
 *  - 命名实体缺失 / 指代不明（如「她家在城南」whose home?）→ 返回 undefined，由调用方诚实回报空。
 *  - 构建出的草案若实体名仍是占位（「新地点」「关键道具」等）或抽出的名字根本没出现在原文里
 *    （疑似造名）→ 也返回 undefined，绝不凭空造卡。
 */
function buildDirectArchiveDecisiveSuggestion(
  message: string,
  inferredIntent: FoundationGapSuggestion["actionType"] | undefined,
  currentDraft: FoundationGapSuggestion | undefined,
): FoundationGapSuggestion | undefined {
  const intent = inferredIntent ?? inferDirectArchiveBareStatementIntent(message);
  if (!intent) return undefined;
  if (intent === "delete_foundation_entry" || intent === "defer" || intent === "fill_missing_field") {
    return undefined;
  }
  const draft = buildDeterministicSchemaSuggestion(message, intent, currentDraft);
  if (!draft) return undefined;
  // 防造卡：抽出的实体名必须既非占位、又真的出现在原文里（证明是「抽」而非「编」）。
  const entityName = suggestionEntityName(draft);
  if (!entityName || isGenericFoundationEntityName(entityName)) return undefined;
  if (/待确认|待定|未知|未设定/u.test(entityName)) return undefined;
  if (!message.includes(entityName)) return undefined;
  return draft;
}

/**
 * 仅在 directArchive 兜底里用：从「无写入动词、无显式 intent」的裸陈述句里，
 * 凭「命名实体 + 类型名词」线索推一个归档 intent。线索不足就返回 undefined（交给诚实失败）。
 */
function inferDirectArchiveBareStatementIntent(
  message: string,
): FoundationGapSuggestion["actionType"] | undefined {
  // 必须有一个明确命名实体锚点（「X叫Y」/「名叫Y」），否则不绕门槛。
  const hasNamedEntity = /(?:叫|名叫|名字是)\s*[一-鿿A-Za-z0-9]{2,16}/u.test(message);
  if (!hasNamedEntity) return undefined;
  // 资产类（武器/道具/卡证）优先于地点：「主角的剑叫赤霄」「他有把枪叫黑星」。
  if (/剑|刀|枪|弓|杖|戒指|项链|护符|卡|钥匙|证件|手机|背包|车/u.test(message)) {
    return "create_asset";
  }
  // 地点类：店铺/餐饮/场所类型名词 + 命名实体。
  if (/面馆|餐厅|饭店|酒馆|酒吧|咖啡馆|茶馆|客栈|旅店|商铺|店铺|店|馆|楼|阁|寺|庙|广场|公园|街|巷|区|城|镇|村|山|河|湖/u.test(message)) {
    return "create_location";
  }
  return undefined;
}

/**
 * H4 兜底安全网：directArchive 下模型「听懂了却没吐出可写卡」(返回空 generatedSuggestions / 非法 JSON) 时，
 * 对「<主语>家在/住在 <地点>」这一类**高把握度居所陈述句**确定性地补一条角色居所卡——
 * 居所装不进内置 typed 字段，走 extraFields.居所（与模型自己的判断一致）。
 *
 * 严格界定为兜底、只认这一个句式：
 *  - 必须能抽出非泛化、且真出现在原文里的地点（防造卡）。
 *  - 主语必须能唯一解析到一个角色（句中出现的角色名 / 裸代词她他它/主角→唯一主角 / 全书唯一角色）；
 *    多候选或解析不到 → 返回 undefined（诚实空，绝不硬归给谁）。
 */
function buildDirectArchiveResidenceSuggestion(
  message: string,
  options: ExplicitFoundationWriteOptions = {},
): FoundationGapSuggestion | undefined {
  const placeMatch = message.match(
    /(?:家(?:在|住)|住在|定居在?|老家(?:在|是)?)\s*([一-鿿A-Za-z0-9·]{1,12}?)(?=的|里|内|那|[，。！？、；;,.!?\s]|$)/u,
  );
  const place = cleanEntityName(placeMatch?.[1]);
  if (!place || isGenericFoundationEntityName(place)) return undefined;
  if (/待确认|待定|未知|未设定/u.test(place)) return undefined;
  if (!message.includes(place)) return undefined;
  const target = resolveResidenceCharacterTarget(message, options);
  if (!target) return undefined;
  const id = stableFoundationId("update-character-residence", `${target.id}:${place}`);
  return {
    id: `ai-${id}`,
    gapId: "ai-gap-update-character-residence",
    category: "characters",
    actionType: "update_character_detail",
    targetFile: "story/character-bible.json",
    targetPath: "characters",
    targetId: target.id,
    before: undefined,
    after: { extraFields: { 居所: place } },
    rationale: `用户提到「${target.name}」的居所在${place}，归档为角色自定义字段「居所」。`,
    risk: "info",
    requiresUserConfirm: true,
    sourceUserMessage: message,
    extractedEntityName: target.name,
    sourceEvidence: message,
    writeMode: "replace",
  };
}

/**
 * 居所兜底专用的主语解析：在 resolveExplicitCharacterTarget 基础上额外认**裸代词「她/他/它」→ 唯一主角**
 * （居所句常用裸代词，如「她家在城南」）。仍只在能唯一确定一个角色时返回，多候选则交给调用方诚实空。
 */
function resolveResidenceCharacterTarget(
  message: string,
  options: ExplicitFoundationWriteOptions,
): { readonly id: string; readonly name: string } | undefined {
  const known = [
    ...(options.knownCharacters ?? []),
    ...(options.protagonistId && options.protagonistName ? [{ id: options.protagonistId, name: options.protagonistName }] : []),
  ].filter((character, index, list) => character.id && character.name && list.findIndex((item) => item.id === character.id) === index);
  const named = known
    .filter((character) => message.includes(character.name))
    .sort((left, right) => right.name.length - left.name.length)[0];
  if (named) return named;
  if (/(?:她|他|它|主角|男主|女主)/u.test(message) && options.protagonistId) {
    return { id: options.protagonistId, name: options.protagonistName ?? "主角" };
  }
  if (known.length === 1) return known[0];
  return undefined;
}

function buildDeterministicDeleteReply(
  message: string,
  options: ExplicitFoundationWriteOptions = {},
): FoundationGapChatModelResult {
  const base = {
    intent: "delete_foundation_entry" as const,
    askedQuestions: [],
    missingFields: [],
    focusedCategory: "characters" as const,
    focusedGapIds: [],
    focusedSuggestionIds: [],
    generatedSuggestions: [],
    suggestedActions: [{ id: "continue-chat", label: "继续说明" }],
    safetyWarnings: [],
  };
  const known = options.knownCharacters ?? [];
  const candidates = known.filter((character) => character.name && message.includes(character.name));
  if (candidates.length === 0) {
    const names = known.map((character) => character.name).filter(Boolean);
    return {
      ...base,
      reply: names.length > 0
        ? `我没有从这句话里确定要删除哪条资料。当前已记录的角色有：${names.join("、")}。请直接说"删除角色XX"；要删地点、资产或规则时，请说出它的完整名字。`
        : "我没有从这句话里确定要删除哪条资料。请直接说出要删除的角色、地点、资产或规则的名字。",
    };
  }
  if (candidates.length > 1) {
    return {
      ...base,
      reply: `你要删除的是${candidates.map((character) => `「${character.name}」`).join("还是")}？请指明一个，我一次只删一条。`,
    };
  }
  const target = candidates[0]!;
  if (target.id === options.protagonistId) {
    return {
      ...base,
      reply: `「${target.name}」是主角，不能删除。如果要换主角，可以改主角的名字或修改主角资料。`,
    };
  }
  const suggestion: FoundationGapSuggestion = {
    id: `ai-${stableFoundationId("delete-character", target.id)}`,
    gapId: "ai-gap-delete-character",
    category: "characters",
    actionType: "delete_foundation_entry",
    targetFile: "story/character-bible.json",
    targetPath: "$",
    targetId: target.id,
    before: { name: target.name },
    after: null,
    rationale: "用户明确要求删除该角色资料，将同步清理角色矩阵和角色档案。",
    risk: "warning",
    requiresUserConfirm: true,
    sourceUserMessage: message,
    extractedEntityName: target.name,
  };
  return {
    ...base,
    reply: `我会删除角色「${target.name}」的资料，并同步清理角色矩阵和角色档案。删除完成后可以撤回。`,
    focusedSuggestionIds: [suggestion.id],
    generatedSuggestions: [suggestion],
    suggestedActions: [{ id: "accept-visible", label: "确认删除" }],
  };
}

function isFoundationCompletenessQuestion(message: string): boolean {
  return /全吗|完整吗|够不够|缺什么|缺啥|有没有问题|会不会污染|哪里不完整|哪些没补|还差什么/u.test(message);
}

function buildFoundationCompletenessReply(
  input: {
    readonly message: string;
    readonly report: Awaited<ReturnType<typeof buildFoundationGapReport>>;
    readonly suggestions: readonly FoundationGapSuggestion[];
  },
  intent: FoundationGapSuggestion["actionType"] | undefined,
  category: FoundationGapSuggestion["category"] | undefined,
): FoundationGapChatModelResult {
  const gaps = category
    ? (input.report.byCategory[category] ?? [])
    : [...input.report.riskyItems, ...input.report.missingItems, ...input.report.conflictItems];
  const topGaps = gaps
    .filter((item) => !("severity" in item) || item.severity === "high" || item.severity === "warning")
    .slice(0, 5);
  const focusedSuggestions = category
    ? input.suggestions.filter((suggestion) => suggestion.category === category).slice(0, 3)
    : input.suggestions.slice(0, 3);
  const categoryLabel = category ? foundationCategoryLabel(category) : "当前资料";
  const reply = topGaps.length
    ? `${categoryLabel}还不算完全够用。最需要先看的缺口是：${topGaps.map((item) => item.title).join("、")}。这些会影响继续写作时的连续性或信息边界；其他低风险项可以暂时观察。`
    : `${categoryLabel}当前没有明显高风险缺口，可以支撑继续写作。后续如果要新增剧情、角色或地点，再按新内容补资料即可。`;
  return {
    reply,
    ...(intent ? { intent } : {}),
    askedQuestions: [],
    missingFields: topGaps.flatMap((item) => "missingFields" in item ? item.missingFields : []).slice(0, 12),
    ...(category ? { focusedCategory: category } : {}),
    focusedGapIds: topGaps.map((item) => item.id),
    focusedSuggestionIds: focusedSuggestions.map((item) => item.id),
    generatedSuggestions: [],
    suggestedActions: topGaps.length
      ? [
        { id: "scan-gaps", label: "查看缺口" },
        { id: "continue-chat", label: "继续补充" },
      ]
      : [
        { id: "continue-chat", label: "继续聊" },
      ],
    safetyWarnings: [],
  };
}

function foundationCategoryLabel(category: FoundationGapSuggestion["category"]): string {
  const labels: Record<FoundationGapSuggestion["category"], string> = {
    story: "故事设定",
    world: "世界观",
    writingRules: "写作规则",
    characters: "角色资料",
    characterRelationships: "角色关系",
    locations: "地点资料",
    assets: "资产资料",
    knowledgeBoundary: "知识边界",
    hooks: "伏笔资料",
    threads: "线索资料",
    arcGoals: "主线目标",
    timeline: "时间线",
  };
  return labels[category] ?? "当前资料";
}

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

/**
 * 从 StateOverview 抽取已落盘实体的名字→id 清单，喂给解析器回填 targetId（修1）。
 * characterMatrix / assetSummary / locationDetailSummary 比 report.byCategory 全，但受 overview 展示上限
 * （MAX_ITEMS=12，见 state-overview.ts）约束：超出前 12 条的实体不在此清单内，其回填会查不到 → 走诚实 skip。
 */
export function buildFoundationKnownEntities(overview: StateOverview): FoundationKnownEntities {
  return {
    characters: (overview.characterMatrix?.characters ?? [])
      .filter((item) => item.id && item.name)
      .map((item) => ({ id: item.id, name: item.name })),
    locations: (overview.locationDetailSummary?.locations ?? [])
      .filter((item) => item.id && item.name)
      .map((item) => ({ id: item.id, name: item.name })),
    assets: (overview.assetSummary?.assetItems ?? [])
      .filter((item) => item.id && item.name)
      .map((item) => ({ id: item.id, name: item.name })),
  };
}

function normalizeFoundationGapChatResult(
  value: unknown,
  existingSuggestions: readonly FoundationGapSuggestion[],
  report: Awaited<ReturnType<typeof buildFoundationGapReport>>,
  sourceUserMessage?: string,
  knownEntities?: FoundationKnownEntities,
): FoundationGapChatModelResult {
  if (!isRecord(value)) throw new Error("AI JSON 根节点不是对象。");
  const reply = readString(value.reply);
  if (!reply) throw new Error("AI JSON 缺少 reply。");
  const intent = readFoundationGapActionType(value.intent);
  const focusedCategory = readFoundationGapCategory(value.focusedCategory);
  const focusedGapIds = readStringList(value.focusedGapIds).slice(0, 12);
  const focusedSuggestionIds = readStringList(value.focusedSuggestionIds).slice(0, 12);
  const generatedSuggestions = readGeneratedFoundationGapSuggestions(value.generatedSuggestions, existingSuggestions, report, sourceUserMessage, knownEntities).slice(0, 12);
  const draftSuggestion = readGeneratedFoundationGapSuggestions(value.draftSuggestion ? [value.draftSuggestion] : [], existingSuggestions, report, sourceUserMessage, knownEntities)[0];
  const suggestedActions = readFoundationGapChatActions(value.suggestedActions);
  return {
    reply,
    ...(intent ? { intent } : {}),
    askedQuestions: readStringList(value.askedQuestions).slice(0, 6),
    ...(draftSuggestion ? { draftSuggestion } : {}),
    missingFields: readStringList(value.missingFields).slice(0, 20),
    ...(focusedCategory ? { focusedCategory } : {}),
    focusedGapIds,
    focusedSuggestionIds: [...focusedSuggestionIds, ...(draftSuggestion ? [draftSuggestion.id] : [])].filter((id, index, array) => array.indexOf(id) === index),
    generatedSuggestions,
    suggestedActions: suggestedActions.length ? suggestedActions : [
      { id: "accept-visible", label: "没问题" },
      { id: "edit-visible", label: "改一下" },
      { id: "preview-write", label: "生成写入预览" },
    ],
    safetyWarnings: readStringList(value.safetyWarnings),
  };
}

// ---------------------------------------------------------------------------
// Intent inference
// ---------------------------------------------------------------------------

function foundationIntentFromCategory(category: string | undefined): FoundationGapSuggestion["actionType"] | undefined {
  switch (category) {
    case "characters": return "create_character";
    case "characterRelationships": return "create_relationship";
    case "locations": return "create_location";
    case "assets": return "create_asset";
    case "world":
    case "story": return "update_world_rule";
    case "writingRules": return "update_writing_rule";
    case "knowledgeBoundary": return "update_knowledge_boundary";
    default: return undefined;
  }
}

function inferFoundationGapChatIntent(message: string, currentIntent: FoundationGapSuggestion["actionType"] | undefined): FoundationGapSuggestion["actionType"] | undefined {
  if (
    /(?:删除|删掉|移除|去掉|清除)/u.test(message)
    && !/(?:草稿|正文|文章|章节|本章|这一章|下一章|书|项目)/u.test(message)
  ) {
    return "delete_foundation_entry";
  }
  if (extractProtagonistRenameName(message)) return "rename_character";
  if (/世界观|世界规则|世界设定|故事设定|社会规则|阶层|资源|势力|世界规则|城市|社会现实|实际社会运转|对标上海/u.test(message)) return "update_world_rule";
  if (/写作规则|文风|节奏|人称|视角|字数/u.test(message)) return "update_writing_rule";
  if (/关系|暧昧|朋友|敌人|导师.*主角|主角.*导师/u.test(message)) return "create_relationship";
  if (/新角色|角色|导师|反派|配角|人物/u.test(message)) return "create_character";
  if (/(?:年龄|身份|定位|职业|说话|语气|心境|情绪|当前目标|目标|知道|不知道|不能透露|关系).{0,16}(?:改成|改为|设为|是|为|更)|(?:改成|改为|设为).{0,16}(?:年龄|身份|定位|职业|说话|语气|心境|情绪|当前目标|目标|关系)/u.test(message)) return "update_character_detail";
  if (/地点|住处|别墅|房间|楼|空间结构|孵化楼/u.test(message)) return "create_location";
  if (/资产|道具|枪|手机|车|现金|背包|物品|十亿|资金|存款|理财账户/u.test(message)) return "create_asset";
  if (/秘密|知道|不知道|知识边界/u.test(message)) return "update_knowledge_boundary";
  if (currentIntent && /岁|男|女|知道|秘密|风格|克制|随身|可用|楼|分钟|资源|风险/u.test(message)) return currentIntent;
  return currentIntent;
}

function categoryForFoundationGapIntent(intent: FoundationGapSuggestion["actionType"] | undefined): FoundationGapSuggestion["category"] | undefined {
  if (intent === "create_character" || intent === "rename_character" || intent === "update_character_detail" || intent === "update_character_boundary") return "characters";
  if (intent === "create_relationship") return "characterRelationships";
  if (intent === "create_location" || intent === "update_location_detail") return "locations";
  if (intent === "create_asset" || intent === "update_asset_status") return "assets";
  if (intent === "update_world_rule") return "world";
  if (intent === "update_writing_rule") return "writingRules";
  if (intent === "update_knowledge_boundary") return "knowledgeBoundary";
  return undefined;
}

function inferFoundationGapChatCategory(message: string, selectedCategory: string | undefined): FoundationGapSuggestion["category"] | undefined {
  const selected = readFoundationGapCategory(selectedCategory);
  if (/资产|物品|随身|枪|现金|背包|车/u.test(message)) return "assets";
  if (/角色|导师|主角|人物|关系|知道|不知道/u.test(message)) return "characters";
  if (/地点|空间|楼|房间|城市|孵化楼/u.test(message)) return "locations";
  if (/世界|阶层|规则|势力|阵营/u.test(message)) return "world";
  if (/写作规则|文风|节奏|视角/u.test(message)) return "writingRules";
  return selected;
}

// ---------------------------------------------------------------------------
// Schema drafting
// ---------------------------------------------------------------------------

function shouldDraftFoundationSchema(message: string, intent: FoundationGapSuggestion["actionType"] | undefined, currentDraft: FoundationGapSuggestion | undefined): boolean {
  if (!intent) return false;
  if (intent === "delete_foundation_entry") return false;
  if (currentDraft && /确认|写入|预览/u.test(message)) return false;
  if (currentDraft && message.trim().length > 4) return true;
  if (intent === "create_character") return /岁|男|女|身份|说话|知道|秘密|帮主角|观察|导师|反派/u.test(message) && message.length > 16;
  if (intent === "create_location") return /层|楼|房间|入口|出口|分钟|区域|进入|空间|视觉|声音|气味|触感|叙事功能|风险|资源|总部/u.test(message) && message.length > 12;
  if (intent === "create_asset") return /谁|主角|归|拥有|持有|随身|可用|限制|状态|数量|位置|地点|抢来|哪里|权限|打开|遗失|安保|卡|钥匙|证件|文件/u.test(message) && message.length > 8;
  if (intent === "update_world_rule") {
    return /现实世界|现实|都市|世界|社会|规则|资源|阶层|掌握|冲突|普通人|强者|势力|权力|金钱|阶级|财团|组织/u.test(message) && message.length > 6;
  }
  if (intent === "update_writing_rule") return /风格|人称|节奏|揭|字数|不要/u.test(message) && message.length > 10;
  if (intent === "create_relationship") return /表面|真实|知道|秘密|态度|信任|怀疑/u.test(message) && message.length > 10;
  return message.length > 20;
}

function schemaAssistantQuestionReply(intent: FoundationGapSuggestion["actionType"]): string {
  const intro: Record<string, string> = {
    create_character: "可以。这个角色会影响后续写作，我先帮你建角色资料。",
    create_location: "可以。地点资料会影响场景、移动和空间连续性，我先帮你建地点资料。",
    create_asset: "可以。资产资料会影响后续能不能使用、消耗或遗失，我先帮你建资产草案。",
    update_world_rule: "可以。世界观规则会影响所有章节的冲突和限制，我先帮你梳理核心规则。",
    update_writing_rule: "可以。写作规则会约束后续文风、节奏和信息揭示，我先帮你整理。",
    create_relationship: "可以。角色关系会影响群像和后续冲突，我先帮你建关系草案。",
    update_knowledge_boundary: "可以。知识边界会决定谁知道什么、谁不能提前知道什么。",
    fill_missing_field: "可以。我先确认几个关键信息。",
    update_character_boundary: "可以。我先确认角色边界。",
    update_location_detail: "可以。我先确认地点细节。",
    update_asset_status: "可以。我先确认资产状态。",
    defer: "可以，先暂不处理。",
  };
  return `${intro[intent] ?? "可以。"}\n\n我需要先确认几个关键信息。`;
}

function requiredQuestionsForFoundationIntent(intent: FoundationGapSuggestion["actionType"]): readonly string[] {
  const questions: Record<string, readonly string[]> = {
    create_character: ["这个角色的身份是什么？", "他和主角是什么关系？", "年龄/性别大概是什么？", "他说话风格是什么？", "他知道哪些主角不知道的秘密？"],
    create_location: ["这个地点是什么？", "属于哪个上级地点？", "有几层或几个区域？", "主角从哪里进入？", "到关键地点需要多久？"],
    create_asset: ["这是什么资产？", "谁拥有它？", "它现在在哪里？", "是否随身携带？", "能不能使用，有什么限制？"],
    update_world_rule: ["这是哪种类型的世界？", "核心资源或力量是什么？", "谁掌握资源？", "普通人和强者差距在哪里？", "规则制造什么冲突？"],
    update_writing_rule: ["想写成什么风格？", "第几人称？", "节奏快慢？", "信息慢慢揭还是直接讲？", "不想写成什么样？"],
    create_relationship: ["哪两个角色？", "表面关系是什么？", "真实关系是什么？", "谁知道秘密？", "当前态度如何？"],
    update_knowledge_boundary: ["谁知道这件事？", "谁不知道？", "这是不是禁止提前揭开的秘密？", "什么时候可以透露？"],
  };
  return questions[intent] ?? ["你想补哪类资料？", "这项资料会影响哪一章？", "有哪些不能违背的限制？"];
}

function missingFieldsForFoundationIntent(intent: FoundationGapSuggestion["actionType"]): readonly string[] {
  const fields: Record<string, readonly string[]> = {
    create_character: ["name", "age", "gender", "identity", "role", "desire", "fear", "weakness", "moralBoundary", "behaviorBoundaries", "speechStyle", "speechSamples", "knowledgeKnown", "knowledgeUnknown", "cannotDo", "relationshipToProtagonist", "currentLocation", "currentGoal"],
    create_location: ["name", "parentLocation", "locationType", "floors", "rooms", "entrances", "exits", "connectedLocations", "travelRules", "resources", "risks", "fixedFacts"],
    create_asset: ["name", "type", "owner", "currentLocation", "carriedBy", "quantity", "status", "isConsumable", "isPlotCritical", "rules", "container"],
    update_world_rule: ["worldPremise", "coreRules", "resourceRules", "socialOrder", "factions", "conflictSources", "fixedFacts", "protectedSecrets"],
    update_writing_rule: ["narrativePerspective", "proseStyle", "pacing", "targetChapterWords", "revealPolicy", "forbiddenContent", "readerExperienceRules", "doNotDo"],
    create_relationship: ["sourceCharacter", "targetCharacter", "relationType", "attitude", "trustLevel", "conflict", "secret", "lastChangedChapter"],
  };
  return fields[intent] ?? [];
}

// ---------------------------------------------------------------------------
// Schema suggestion builder
// ---------------------------------------------------------------------------

function buildDeterministicSchemaSuggestion(message: string, intent: FoundationGapSuggestion["actionType"] | undefined, currentDraft: FoundationGapSuggestion | undefined): FoundationGapSuggestion | undefined {
  if (!intent) return undefined;
  if (currentDraft) {
    return {
      ...currentDraft,
      id: currentDraft.id,
      after: mergeDraftAfter(currentDraft.after, message),
      rationale: "根据你的补充更新资料草案，确认前不会写入正式资料。",
    };
  }
  const seed = `${intent}:${message}`;
  const idSuffix = createHash("sha1").update(seed).digest("hex").slice(0, 8);
  if (intent === "create_character") {
    const name = extractName(message, "待定导师");
    const identity = extractCharacterIdentity(message) ?? (/导师/u.test(message) ? "主角导师" : "待确认身份");
    const speechStyle = extractCharacterSpeechStyle(message) ?? (/克制/u.test(message) ? "克制、冷静、很少夸人" : "待确认");
    const relationshipToProtagonist = extractRelationshipToProtagonist(message) ?? (/观察/u.test(message) ? "表面帮助主角，实际观察主角" : "待确认");
    const knowledgeKnown = extractKnowledgeKnown(message);
    const knowledgeUnknown = extractKnowledgeUnknown(message);
    const currentGoal = extractCurrentGoal(message, identity);
    const appearanceAnchors = extractCharacterAppearanceAnchors(message);
    const personality = extractCharacterPersonality(message);
    const desire = extractCharacterDesire(message);
    const fear = extractCharacterFear(message);
    const weakness = extractCharacterWeakness(message);
    const cannotReveal = extractCharacterCannotReveal(message);
    const privateMotive = extractCharacterPrivateMotive(message, desire);
    const id = `char-${idSuffix}`;
    return {
      id: `ai-${id}`,
      gapId: "ai-gap-create-character",
      category: "characters",
      actionType: "create_character",
      targetFile: "story/character-bible.json",
      targetPath: "characters",
      targetId: id,
      before: undefined,
      after: {
        bibleEntry: {
          id,
          name,
          role: /反派/u.test(message) ? "反派" : /导师/u.test(message) ? "导师" : "重要角色",
          age: extractFirst(message, /(\d{2})岁/u) ?? "待确认",
          gender: /女/u.test(message) ? "女" : /男/u.test(message) ? "男" : "待确认",
          identity,
          appearanceAnchors,
          desire,
          fear,
          weakness,
          moralBoundary: "待确认",
          privateMotive,
          relationshipToProtagonist,
          speechStyle,
          speechSamples: speechStyle !== "待确认" ? [`${name}说话${speechStyle}。`] : [],
          personalityBaseline: personality,
          behaviorBoundaries: buildCharacterBehaviorBoundaries(message),
          knowledgeKnown,
          knowledgeUnknown: knowledgeUnknown.length ? knowledgeUnknown : ["主角的最终潜力仍需后续揭示。"],
          cannotReveal,
          cannotDo: ["不能替主角直接解决核心冲突。"],
        },
        profile: { id, name, identity, age: extractFirst(message, /(\d{2})岁/u) ?? "待确认", appearanceAnchors, tags: [] },
        core: {
          characterId: id,
          personality,
          speechStyle,
          taboos: cannotReveal,
          desire,
          fear,
          weakness,
          behaviorHabits: buildCharacterBehaviorHabits(message),
        },
        state: {
          characterId: id,
          emotion: "待确认",
          goal: currentGoal,
          knowledgeKnown,
          knowledgeUnknown: knowledgeUnknown.length ? knowledgeUnknown : ["主角的最终潜力仍需后续揭示。"],
          cannotReveal,
          lastUpdatedChapter: null,
        },
      },
      rationale: "新角色需要固定身份、说话风格和知识边界，避免后续人物漂移。",
      risk: "warning",
      requiresUserConfirm: true,
    };
  }
  if (intent === "create_location") {
    const parsedLocation = extractLocationDetailFromMessage(message);
    const name = parsedLocation.name ?? extractName(message, /住处/u.test(message) ? "主角住处" : "新地点");
    const id = `loc-${idSuffix}`;
    return {
      id: `ai-${id}`,
      gapId: "ai-gap-create-location",
      category: "locations",
      actionType: "create_location",
      targetFile: "story/location-bible.json",
      targetPath: "locations",
      targetId: id,
      before: undefined,
      after: {
        id,
        name,
        type: parsedLocation.locationType ?? "地点",
        parentLocation: parsedLocation.parentLocation ?? "待确认",
        locationType: parsedLocation.locationType ?? "待确认",
        spatialStructure: {
          floors: parsedLocation.floors.length ? parsedLocation.floors : ["待确认楼层"],
          rooms: parsedLocation.rooms.length ? parsedLocation.rooms : ["待确认房间"],
          entrances: parsedLocation.entrances.length ? parsedLocation.entrances : ["待确认入口"],
          exits: parsedLocation.exits.length ? parsedLocation.exits : ["待确认出口"],
        },
        connectedLocations: parsedLocation.connectedLocations,
        knownFeatures: parsedLocation.rooms,
        sensoryDetails: parsedLocation.sensoryDetails,
        narrativeFunction: parsedLocation.narrativeFunction,
        possibleConflicts: parsedLocation.possibleConflicts,
        currentStatus: parsedLocation.currentStatus,
        hiddenFacts: parsedLocation.hiddenFacts,
        travelRules: parsedLocation.travelRules,
        resources: parsedLocation.resources,
        risks: parsedLocation.risks,
        fixedFacts: parsedLocation.fixedFacts,
      },
      rationale: "地点需要固定空间结构和移动规则，避免楼层、距离和场景漂移。",
      risk: "warning",
      requiresUserConfirm: true,
    };
  }
  if (intent === "create_asset") {
    const entity = extractExplicitAssetEntity(message);
    const name = entity?.name ?? extractAssetName(message);
    const ownerName = extractAssetOwner(message);
    const currentLocationName = extractAssetCurrentLocation(message, ownerName);
    const carriedBy = extractAssetCarriedBy(message, ownerName);
    const status = inferAssetStatus(message);
    const rules = extractAssetRules(message);
    const usageRules = extractAssetUsageRules(message);
    const lossRules = extractAssetLossRules(message);
    const id = `asset-${idSuffix}`;
    return withSuggestionSourcePreservation({
      id: `ai-${id}`,
      gapId: "ai-gap-create-asset",
      category: "assets",
      actionType: "create_asset",
      targetFile: "story/assets.json",
      targetPath: "assets",
      targetId: id,
      before: undefined,
      after: {
        id,
        name,
        type: entity?.type ?? inferAssetTypeFromName(name, message),
        ownerName,
        currentLocationName,
        ...(carriedBy ? { carriedByCharacterId: carriedBy } : {}),
        status,
        quantity: 1,
        isConsumable: entity?.type === "money" ? false : false,
        isPlotCritical: entity?.type !== "money",
        canAiModify: false,
        rules: uniqueStrings([
          ...rules,
          /抢来/u.test(message) ? "来源为抢夺所得，后续使用可能带来追踪风险。" : "状态变化必须经过入库预览确认。",
          ...(entity?.type === "container" ? ["只能存放用户确认过的物品，不能凭空装出新资产。"] : []),
        ]),
        usageRules,
        lossRules,
        notes: [message.slice(0, 120)],
      },
      rationale: "关键资产需要固定归属、位置和使用限制，避免凭空出现或消失。",
      risk: "warning",
      requiresUserConfirm: true,
    }, message);
  }
  if (intent === "update_world_rule") {
    const targetPath = inferWorldRuleTargetPath(message);
    const ruleText = normalizeRuleText(message);
    return {
      id: `ai-world-${idSuffix}`,
      gapId: "ai-gap-update-world-rule",
      category: "world",
      actionType: "update_world_rule",
      targetFile: "story/world-bible.json",
      targetPath,
      before: undefined,
      after: [ruleText],
      rationale: "世界观规则需要固定到资料文件，避免后续写作临场改规则。",
      risk: "warning",
      requiresUserConfirm: true,
    };
  }
  if (intent === "update_writing_rule") {
    const targetPath = inferWritingRuleTargetPath(message);
    const ruleText = normalizeRuleText(message);
    return {
      id: `ai-writing-${idSuffix}`,
      gapId: "ai-gap-update-writing-rule",
      category: "writingRules",
      actionType: "update_writing_rule",
      targetFile: "story/writing-rules.json",
      targetPath,
      before: undefined,
      after: [ruleText],
      rationale: "写作规则需要固定到资料文件，避免后续章节风格和边界漂移。",
      risk: "warning",
      requiresUserConfirm: true,
    };
  }
  if (intent === "update_knowledge_boundary") {
    const name = extractKnowledgeBoundaryCharacterName(message);
    if (!name) return undefined;
    return buildExplicitKnowledgeBoundarySuggestion(name, message);
  }
  return undefined;
}

interface ExplicitFoundationWriteOptions {
  readonly protagonistId?: string;
  readonly protagonistName?: string;
  readonly knownCharacters?: readonly {
    readonly id: string;
    readonly name: string;
  }[];
}

function buildExplicitFoundationWriteSuggestions(message: string, options: ExplicitFoundationWriteOptions = {}): readonly FoundationGapSuggestion[] {
  const protagonistRename = buildExplicitProtagonistRenameSuggestion(message, options);
  if (protagonistRename) return [protagonistRename];
  if (!isDirectFoundationWritePhrase(message)) return [];
  const directCharacterUpdate = buildExplicitCharacterDetailUpdateSuggestion(message, options);
  if (directCharacterUpdate) return [directCharacterUpdate];
  const directIntent = inferFoundationGapChatIntent(message, undefined);
  const directCharacterName = directIntent === "create_character" ? extractSingleCharacterWriteName(message) : undefined;
  if (directCharacterName) return [buildExplicitCharacterSuggestion(directCharacterName, message)];
  const attributeCharacterName = extractCharacterAttributeTargetName(message);
  if (attributeCharacterName) return [buildExplicitCharacterSuggestion(attributeCharacterName, message)];
  const directLocationName = directIntent === "create_location" ? extractSingleLocationWriteName(message) : undefined;
  if (directLocationName) return [buildExplicitLocationSuggestion(directLocationName, message)];
  const directAssetName = directIntent === "create_asset" ? (extractSingleAssetWriteName(message) ?? extractAssetName(message)) : undefined;
  if (directAssetName) return [buildExplicitAssetSuggestion(directAssetName, message)];
  if (directIntent === "update_world_rule") {
    const worldRule = extractExplicitWorldRule(message) ?? normalizeRuleText(message);
    return worldRule ? [buildExplicitWorldRuleSuggestion(worldRule, message)] : [];
  }
  if (directIntent === "update_writing_rule") {
    const writingRule = extractExplicitWritingRule(message) ?? normalizeRuleText(message);
    return writingRule ? [buildExplicitWritingRuleSuggestion(writingRule, message)] : [];
  }
  if (directIntent === "update_knowledge_boundary") {
    const characterName = extractKnowledgeBoundaryCharacterName(message);
    return characterName ? [buildExplicitKnowledgeBoundarySuggestion(characterName, message)] : [];
  }
  const suggestions: FoundationGapSuggestion[] = [];
  const singleCharacterName = extractSingleCharacterWriteName(message);
  if (singleCharacterName) {
    suggestions.push(buildExplicitCharacterSuggestion(singleCharacterName, message));
  } else {
    const characterNames = extractExplicitSectionItems(message, ["角色", "人物"]);
    for (const name of characterNames) {
      suggestions.push(buildExplicitCharacterSuggestion(name, message));
    }
  }
  const singleLocationName = extractSingleLocationWriteName(message);
  if (singleLocationName) {
    suggestions.push(buildExplicitLocationSuggestion(singleLocationName, message));
  } else {
    const locationNames = extractExplicitSectionItems(message, ["地点", "场景", "位置"]);
    for (const name of locationNames) {
      suggestions.push(buildExplicitLocationSuggestion(name, message));
    }
  }
  const singleAssetName = extractSingleAssetWriteName(message);
  if (singleAssetName) {
    suggestions.push(buildExplicitAssetSuggestion(singleAssetName, message));
  } else {
    const assetNames = extractExplicitSectionItems(message, ["资产", "道具", "物品"]);
    for (const name of assetNames) {
      suggestions.push(buildExplicitAssetSuggestion(name, message));
    }
  }
  const worldRule = extractExplicitWorldRule(message);
  if (worldRule) {
    suggestions.push(buildExplicitWorldRuleSuggestion(worldRule, message));
  }
  const writingRule = extractExplicitWritingRule(message);
  if (writingRule) {
    suggestions.push(buildExplicitWritingRuleSuggestion(writingRule, message));
  }
  const knowledgeCharacter = extractKnowledgeBoundaryCharacterName(message);
  if (knowledgeCharacter) {
    suggestions.push(buildExplicitKnowledgeBoundarySuggestion(knowledgeCharacter, message));
  }
  return suggestions;
}

function isDirectFoundationWritePhrase(message: string): boolean {
  return /(?:入库|写入|记录|保存|整理|梳理|补充|补一下|新增|创建|添加|加一|加个|加一辆|加一把|加一个|给.{0,12}加|安排|配一|改成|改为|设为|设定为|知道|不知道|不能透露|当前目标|说话更|语气更|心境|情绪|以后|从现在起|就是|对标|符合|来源|给了|获得|\d{1,3}\s*岁?|职业无|刚毕业|外冷内热)/u.test(message);
}

function foundationWriteOptionsFromOverview(overview: StateOverview): ExplicitFoundationWriteOptions {
  const protagonistName = overview.characters.protagonist;
  const protagonist = protagonistName
    ? overview.characters.knownCharacters.find((character) => character.name === protagonistName)
    : overview.characters.knownCharacters[0];
  return {
    ...(protagonist?.id ? { protagonistId: protagonist.id } : {}),
    ...(protagonist?.name ? { protagonistName: protagonist.name } : protagonistName ? { protagonistName } : {}),
    knownCharacters: overview.characters.knownCharacters
      .map((character) => ({ id: character.id, name: character.name }))
      .filter((character) => character.id && character.name),
  };
}

function buildExplicitProtagonistRenameSuggestion(
  message: string,
  options: ExplicitFoundationWriteOptions,
): FoundationGapSuggestion | undefined {
  const name = extractProtagonistRenameName(message);
  if (!name) return undefined;
  const targetId = options.protagonistId;
  if (!targetId) return undefined;
  const beforeName = options.protagonistName;
  const id = stableFoundationId("rename-character", `${targetId}:${name}`);
  return {
    id: `ai-${id}`,
    gapId: "ai-gap-rename-character",
    category: "characters",
    actionType: "rename_character",
    targetFile: "story/character-bible.json",
    targetPath: "characters.name",
    targetId,
    before: beforeName,
    after: { name },
    rationale: "用户明确要求修改主角显示名，直接同步到已提交角色资料。",
    risk: "info",
    requiresUserConfirm: true,
    sourceUserMessage: message,
    extractedEntityName: name,
    sourceEvidence: message,
    writeMode: "replace",
  };
}

function extractProtagonistRenameName(message: string): string | undefined {
  const patterns = [
    /(?:把|将)?(?:主角|男主|女主)(?:的)?(?:名字|名称|姓名)?(?:改成|改为|换成|设为|改叫|叫|名叫|名字叫)\s*[「“"']?([一-鿿A-Za-z0-9·_\-\s]{2,32})/iu,
    /(?:以后|之后|从现在起)?(?:主角|男主|女主)(?:都|就)?(?:叫|名叫|名字叫)\s*[「“"']?([一-鿿A-Za-z0-9·_\-\s]{2,32})/iu,
    /(?:主角|男主|女主)(?:名字|名称|姓名)?(?:别叫|不要叫|不叫)[一-鿿A-Za-z0-9·_\-\s]{1,32}(?:了)?[，,。；;\s]*(?:改成|改为|换成|叫)\s*[「“"']?([一-鿿A-Za-z0-9·_\-\s]{2,32})/iu,
    /(?:hero|protagonist|main character).{0,48}(?:rename to|change to|should be|make it|call it|call him|call her)\s+([A-Za-z][A-Za-z0-9'’_\-\s]{1,40})/iu,
    /(?:dont|don't)\s+call\s+the\s+(?:hero|protagonist|main character).{0,48}(?:anymore|again).{0,24}(?:make it|call it|call him|call her)\s+([A-Za-z][A-Za-z0-9'’_\-\s]{1,40})/iu,
  ];
  for (const pattern of patterns) {
    const name = cleanRenameTargetName(message.match(pattern)?.[1]);
    if (name) return name;
  }
  return undefined;
}

function cleanRenameTargetName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value
    .replace(/[」”"'].*$/u, "")
    .split(/[，,。；;!！?？\n]/u)[0]
    ?.replace(/(?:吧|了|啦|哈|就行|可以)$/u, "")
    .trim()
    .replace(/\s+/gu, " ");
  return cleaned && cleaned.length >= 2 ? cleaned : undefined;
}

function buildExplicitCharacterDetailUpdateSuggestion(
  message: string,
  options: ExplicitFoundationWriteOptions,
): FoundationGapSuggestion | undefined {
  const target = resolveExplicitCharacterTarget(message, options);
  if (!target) return undefined;
  const after = extractCharacterDetailPatch(message);
  if (!hasCharacterDetailPatch(after)) return undefined;
  const id = stableFoundationId("update-character", `${target.id}:${message}`);
  return {
    id: `ai-${id}`,
    gapId: "ai-gap-update-character-detail",
    category: "characters",
    actionType: "update_character_detail",
    targetFile: "story/character-bible.json",
    targetPath: "characters",
    targetId: target.id,
    before: undefined,
    after,
    rationale: "用户明确要求修改已有角色资料，直接更新已提交角色记录。",
    risk: "info",
    requiresUserConfirm: true,
    sourceUserMessage: message,
    extractedEntityName: target.name,
    sourceEvidence: message,
    writeMode: "replace",
  };
}

function resolveExplicitCharacterTarget(
  message: string,
  options: ExplicitFoundationWriteOptions,
): { readonly id: string; readonly name: string } | undefined {
  const known = [
    ...(options.knownCharacters ?? []),
    ...(options.protagonistId && options.protagonistName ? [{ id: options.protagonistId, name: options.protagonistName }] : []),
  ].filter((character, index, list) => character.id && character.name && list.findIndex((item) => item.id === character.id) === index);
  const named = known
    .filter((character) => message.includes(character.name))
    .sort((left, right) => right.name.length - left.name.length)[0];
  if (named) return named;
  if (/(?:主角|男主|女主)/u.test(message) && options.protagonistId) {
    return { id: options.protagonistId, name: options.protagonistName ?? "主角" };
  }
  if (known.length === 1 && hasCharacterDetailPatch(extractCharacterDetailPatch(message))) {
    return known[0];
  }
  return undefined;
}

function extractCharacterDetailPatch(message: string): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const age = extractAfterLabel(message, /(?:年龄|年纪)(?:改成|改为|设为|是|为|：|:)?\s*(\d{1,3}\s*岁?)/u)
    ?? message.match(/(\d{1,3})\s*岁/u)?.[0]?.replace(/\s+/gu, "");
  if (age) patch.age = age.endsWith("岁") ? age : `${age}岁`;
  const identity = extractAfterLabel(message, /(?:身份|定位|职业)(?:改成|改为|设为|是|为|：|:)\s*([^，。；;]{2,40})/u)
    ?? extractCompactField(message, /(?:身份|定位|职业)\s*([^，。；;\s]{1,24})/u);
  if (identity) patch.identity = identity;
  const relationshipToProtagonist = extractRelationshipToProtagonist(message);
  if (relationshipToProtagonist) patch.relationshipToProtagonist = relationshipToProtagonist;
  const speechStyle = extractCharacterDetailSpeechStyle(message);
  if (speechStyle) patch.speechStyle = speechStyle;
  const mood = extractAfterLabel(message, /(?:心境|情绪|状态)(?:改成|改为|设为|是|为|：|:)\s*([^，。；;]{2,30})/u);
  const currentGoal = extractAfterLabel(message, /(?:当前)?目标(?:改成|改为|设为|是|为|：|:)\s*([^，。；;]{2,50})/u);
  const recentEvent = extractAfterLabel(message, /(?:最近事件|近况|刚刚发生)(?:改成|改为|设为|是|为|：|:)?\s*([^，。；;]{2,80})/u);
  const state: Record<string, unknown> = {};
  if (mood) state.mood = mood;
  if (currentGoal) state.currentGoal = currentGoal;
  if (recentEvent) state.recentEvents = [recentEvent];
  if (Object.keys(state).length > 0) patch.state = state;
  const knowledgeKnown = extractKnowledgeKnown(message);
  if (knowledgeKnown.length > 0) patch.knowledgeKnown = knowledgeKnown;
  const knowledgeUnknown = extractKnowledgeUnknown(message);
  if (knowledgeUnknown.length > 0) patch.knowledgeUnknown = knowledgeUnknown;
  const cannotReveal = extractCannotRevealFromMessage(message);
  if (cannotReveal.length > 0) patch.cannotReveal = cannotReveal;
  const behaviorBoundaries = extractExplicitBehaviorBoundaries(message);
  if (behaviorBoundaries.length > 0) patch.behaviorBoundaries = behaviorBoundaries;
  return patch;
}

function extractCharacterDetailSpeechStyle(message: string): string | undefined {
  return extractAfterLabel(message, /(?:说话|语气|口吻|台词风格)(?:改成|改为|设为|是|为|：|:)\s*([^，。；;]{2,40})/u)
    ?? message.match(/(?:说话|语气|口吻)(更[^，。；;]{2,40})/u)?.[1]?.trim();
}

function extractCompactField(message: string, pattern: RegExp): string | undefined {
  const value = message.match(pattern)?.[1]?.trim();
  return value && value.length >= 1 ? value : undefined;
}

function extractCannotRevealFromMessage(message: string): readonly string[] {
  return [...message.matchAll(/(?:不能|不许|不要)(?:提前)?(?:透露|说出|揭露)([^，。；;]+)/gu)]
    .map((match) => match[1]?.trim())
    .filter((item): item is string => Boolean(item));
}

function hasCharacterDetailPatch(patch: Record<string, unknown>): boolean {
  return Object.values(patch).some((value) => {
    if (Array.isArray(value)) return value.length > 0;
    if (isRecord(value)) return hasCharacterDetailPatch(value);
    return value !== undefined && value !== null && String(value).trim().length > 0;
  });
}

function extractSingleCharacterWriteName(message: string): string | undefined {
  if (!/(?:补|新增|创建|添加|整理|写入).{0,8}(?:一个|1个|新)?(?:角色|人物)/u.test(message)) return undefined;
  if (/(?:角色|人物)(?:包括|包含|有)[：:\s]/u.test(message)) return undefined;
  return extractName(message, "");
}

function extractCharacterAttributeTargetName(message: string): string | undefined {
  const patterns = [
    /(?:^|[，。；;\s])(?:把|将|给)?([一-鿿A-Za-z0-9]{2,12})(?:的)?(?:身份|定位|职业|行为边界|能力边界|边界|说话|语气|性格|目标)(?:改成|改为|设为|是|为|：|:)/u,
    /(?:^|[，。；;\s])(?:把|将|给)?([一-鿿A-Za-z0-9]{2,12})(?:和|与)[一-鿿A-Za-z0-9]{1,8}关系(?:改成|改为|设为|是|为|：|:)/u,
    /(?:^|[，。；;\s])(?:把|将|给)?([一-鿿A-Za-z0-9]{2,12})(?:知道|不知道|不清楚|不能知道)/u,
  ];
  for (const pattern of patterns) {
    const cleaned = cleanEntityName(message.match(pattern)?.[1]);
    if (cleaned) return cleaned;
  }
  return undefined;
}

function extractSingleLocationWriteName(message: string): string | undefined {
  if (!/(?:补|新增|创建|添加|整理|写入).{0,8}(?:一个|1个|新)?(?:地点|场景|位置)/u.test(message)) return undefined;
  if (/(?:地点|场景|位置)(?:包括|包含|有)[：:\s]/u.test(message)) return undefined;
  return extractLocationName(message);
}

function extractSingleAssetWriteName(message: string): string | undefined {
  if (!/(?:补|新增|创建|添加|整理|写入)(?:一下|充)?\s*(?:一个|1个|新)?\s*(?:资产|道具|物品)/u.test(message)) return undefined;
  if (/(?:资产|道具|物品)(?:包括|包含|有)[：:\s]/u.test(message)) return undefined;
  return extractAssetName(message);
}

type ResolvedFoundationChatSuggestions = {
  readonly intent?: FoundationGapSuggestion["actionType"];
  readonly draftSuggestion?: FoundationGapSuggestion;
  readonly explicitSuggestions: readonly FoundationGapSuggestion[];
  readonly generatedSuggestions: readonly FoundationGapSuggestion[];
  readonly focusedSuggestionIds: readonly string[];
  readonly usedDeterministicDraft: boolean;
};

function resolveFoundationChatSuggestions(input: {
  readonly currentDraft?: FoundationGapSuggestion;
  readonly currentIntent?: FoundationGapSuggestion["actionType"];
  readonly explicitWriteOptions?: ExplicitFoundationWriteOptions;
  readonly message: string;
  readonly modelResult: FoundationGapChatModelResult;
  readonly selectedCategory?: string;
}): ResolvedFoundationChatSuggestions {
  const inferredIntent = inferFoundationGapChatIntent(input.message, input.currentIntent);
  const schemaIntent = input.modelResult.intent
    ?? inferredIntent
    ?? input.currentIntent
    ?? foundationIntentFromCategory(input.modelResult.focusedCategory ?? input.selectedCategory);
  const deterministicDraft = shouldDraftFoundationSchema(input.message, schemaIntent, input.currentDraft)
    ? buildDeterministicSchemaSuggestion(input.message, schemaIntent, input.currentDraft)
    : undefined;
  const usefulModelDraft = input.modelResult.draftSuggestion && isUsefulFoundationModelSuggestion(input.modelResult.draftSuggestion)
    ? enrichFoundationSuggestionWithDeterministicFacts(input.modelResult.draftSuggestion, deterministicDraft)
    : undefined;
  const usefulModelGeneratedSuggestions = input.modelResult.generatedSuggestions
    .filter(isUsefulFoundationModelSuggestion)
    .map((suggestion) => enrichFoundationSuggestionWithDeterministicFacts(suggestion, deterministicDraft));
  const hasUsefulModelSuggestions = Boolean(usefulModelDraft) || usefulModelGeneratedSuggestions.length > 0;
  const canUseDeterministicFallback = !hasUsefulModelSuggestions
    && Boolean(deterministicDraft)
    && (isFoundationWriteRequest(input.message) || Boolean(input.currentDraft))
    && deterministicDraft !== undefined
    && shouldUseDeterministicDraft(deterministicDraft, input.modelResult);
  const explicitSuggestions = !hasUsefulModelSuggestions && !canUseDeterministicFallback
    ? buildExplicitFoundationWriteSuggestions(input.message, input.explicitWriteOptions)
    : [];
  const draftSuggestion = canUseDeterministicFallback
    ? deterministicDraft
    : usefulModelDraft;
  const generatedSuggestions = canUseDeterministicFallback && deterministicDraft
    ? [deterministicDraft]
    : usefulModelGeneratedSuggestions;
  const mergedGeneratedSuggestions = mergeFoundationSuggestions(explicitSuggestions, generatedSuggestions);
  const focusedSuggestionIds = [
    ...input.modelResult.focusedSuggestionIds,
    ...(draftSuggestion ? [draftSuggestion.id] : []),
    ...mergedGeneratedSuggestions.map((suggestion) => suggestion.id),
  ].filter((id, index, array) => array.indexOf(id) === index);

  return {
    ...(schemaIntent ? { intent: schemaIntent } : {}),
    ...(draftSuggestion ? { draftSuggestion } : {}),
    explicitSuggestions,
    generatedSuggestions: mergedGeneratedSuggestions,
    focusedSuggestionIds,
    usedDeterministicDraft: Boolean(canUseDeterministicFallback),
  };
}

function isUsefulFoundationModelSuggestion(suggestion: FoundationGapSuggestion): boolean {
  if (suggestion.actionType === "delete_foundation_entry") {
    return Boolean(suggestion.targetId) || typeof suggestion.before === "string";
  }
  if (suggestion.actionType === "defer" || suggestion.actionType === "fill_missing_field") return false;
  if (!suggestion.targetFile || suggestion.after === undefined) return false;
  const entityName = suggestionEntityName(suggestion);
  if (entityName) return !isGenericFoundationEntityName(entityName);
  return hasMeaningfulSuggestionAfter(suggestion.after);
}

function hasMeaningfulSuggestionAfter(value: unknown): boolean {
  if (typeof value === "string") return isMeaningfulSuggestionText(value);
  if (Array.isArray(value)) return value.some(hasMeaningfulSuggestionAfter);
  if (!isRecord(value)) return value !== undefined && value !== null;
  return Object.values(value).some(hasMeaningfulSuggestionAfter);
}

function isMeaningfulSuggestionText(value: string): boolean {
  const text = value.trim();
  return text.length >= 2 && !/^(?:待定|待确认|未知|未设定)$/u.test(text);
}

function isFoundationWriteRequest(message: string): boolean {
  return /(?:写入|记录|保存|入库|补充|补一下|新增|创建|添加|整理|梳理|改成|改为|设为|设定为)/u.test(message);
}

function enrichFoundationSuggestionWithDeterministicFacts(
  suggestion: FoundationGapSuggestion,
  deterministicDraft: FoundationGapSuggestion | undefined,
): FoundationGapSuggestion {
  if (!deterministicDraft) return suggestion;
  if (suggestion.actionType !== deterministicDraft.actionType) return suggestion;
  const modelName = suggestionEntityName(suggestion);
  const deterministicName = suggestionEntityName(deterministicDraft);
  if (
    modelName
    && deterministicName
    && !isGenericFoundationEntityName(modelName)
    && !isGenericFoundationEntityName(deterministicName)
    && modelName !== deterministicName
  ) {
    return suggestion;
  }
  return {
    ...suggestion,
    after: mergeMissingFoundationAfter(suggestion.after, deterministicDraft.after),
    ...(suggestion.sourceUserMessage || !deterministicDraft.sourceUserMessage ? {} : { sourceUserMessage: deterministicDraft.sourceUserMessage }),
    ...(suggestion.sourceEvidence || !deterministicDraft.sourceEvidence ? {} : { sourceEvidence: deterministicDraft.sourceEvidence }),
  };
}

function mergeMissingFoundationAfter(primary: unknown, fallback: unknown): unknown {
  if (isEmptyFoundationValue(primary)) return fallback;
  if (Array.isArray(primary) && Array.isArray(fallback)) {
    return uniqueStrings([...primary.map(String), ...fallback.map(String)]);
  }
  if (isRecord(primary) && isRecord(fallback)) {
    const next: Record<string, unknown> = { ...primary };
    for (const [key, fallbackValue] of Object.entries(fallback)) {
      const primaryValue = next[key];
      if (isEmptyFoundationValue(primaryValue)) {
        next[key] = fallbackValue;
      } else {
        next[key] = mergeMissingFoundationAfter(primaryValue, fallbackValue);
      }
    }
    return next;
  }
  return primary;
}

function isEmptyFoundationValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return !trimmed || /^(待定|待确认|未知|未设定|尚未配置|尚未设定)$/u.test(trimmed);
  }
  if (Array.isArray(value)) return value.length === 0;
  if (isRecord(value)) return Object.keys(value).length === 0;
  return false;
}

function mergeFoundationSuggestions(
  preferred: readonly FoundationGapSuggestion[],
  fallback: readonly FoundationGapSuggestion[],
): readonly FoundationGapSuggestion[] {
  const seen = new Set<string>();
  const merged: FoundationGapSuggestion[] = [];
  for (const suggestion of [...preferred, ...fallback]) {
    const key = `${suggestion.actionType}:${suggestion.targetFile}:${suggestion.targetPath}:${suggestion.targetId ?? ""}:${suggestionEntityName(suggestion) ?? suggestionScalarValue(suggestion) ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(suggestion);
  }
  return merged;
}

function extractExplicitSectionItems(message: string, labels: readonly string[]): readonly string[] {
  const labelPattern = labels.join("|");
  const stopPattern = "(?:角色|人物|地点|场景|位置|资产|道具|物品|世界观|故事设定|写作规则|知识边界)";
  const pattern = new RegExp(`(?:${labelPattern})(?:包括|包含|有|补充|新增|创建|整理|写入)?[：:\\s]*([\\s\\S]*?)(?=(?:；|;|。|\\n)?\\s*${stopPattern}(?:包括|包含|有|补充|新增|创建|整理|写入|[：:])|$)`, "u");
  const raw = message.match(pattern)?.[1];
  if (!raw) return [];
  return uniqueStrings(raw
    .split(/[、，,；;\n]/u)
    .map((item) => item.replace(/^(?:和|以及|还有|包括|包含|有|补充|新增|创建|整理|写入)\s*/u, "").trim())
    .map((item) => item.replace(/(?:等|等等|这些|信息|资料|设定|已经正式出现的资料)$/u, "").trim())
    .map((item) => item.replace(/^(?:角色|人物|地点|场景|位置|资产|道具|物品)[：:\s]+/u, "").trim())
    .filter((item) => /^[一-鿿A-Za-z0-9（）()·\-\s]{2,30}$/u.test(item))
    .map((item) => item.replace(/\s+/gu, "")));
}

function extractExplicitWorldRule(message: string): string | undefined {
  const match = message.match(/(?:世界观|故事设定)(?:规则)?(?:补充|包括|写入|记录|：|:)?\s*([^。；;\n]{8,160})/u);
  const rule = match?.[1]?.trim();
  if (!rule) return undefined;
  return cleanRuleText(rule);
}

function extractExplicitWritingRule(message: string): string | undefined {
  const match = message.match(/(?:写作规则|文风规则|禁止事项|规则)(?:补充|包括|写入|记录|：|:)?\s*([^。；;\n]{8,180})/u);
  const rule = match?.[1]?.trim();
  if (!rule) return undefined;
  return cleanRuleText(rule);
}

function buildExplicitCharacterSuggestion(name: string, message: string): FoundationGapSuggestion {
  const id = stableFoundationId("char", name);
  const identity = inferExplicitCharacterIdentity(name, message);
  const relationshipToProtagonist = inferExplicitRelationshipToProtagonist(name, identity, message);
  const behaviorBoundaries = extractExplicitBehaviorBoundaries(message);
  return {
    id: `ai-${id}`,
    gapId: "ai-gap-explicit-character",
    category: "characters",
    actionType: "create_character",
    targetFile: "story/character-bible.json",
    targetPath: "characters",
    targetId: id,
    before: undefined,
    after: {
      bibleEntry: {
        id,
        name,
        role: inferExplicitCharacterRole(name, identity),
        identity,
        desire: "按已出现剧情继续承担当前职责",
        relationshipToProtagonist,
        speechStyle: "按已出现章节口吻保持一致",
        speechSamples: [],
        behaviorBoundaries: behaviorBoundaries.length ? behaviorBoundaries : ["不能脱离已出现剧情突然改变立场或能力。"],
        knowledgeKnown: ["知道第1章中已经公开或亲历的信息。"],
        knowledgeUnknown: ["不知道尚未在正文中揭示的隐藏真相。"],
        cannotDo: uniqueStrings(["不能提前揭示作者尚未公开的秘密。", ...behaviorBoundaries.filter((item) => /不|不能|不可|禁止/u.test(item))]),
      },
      profile: { id, name, identity, tags: ["章节已出现"] },
      core: { characterId: id, personality: [], speechStyle: "按已出现章节口吻保持一致", taboos: [] },
      state: { characterId: id, emotion: "待确认", goal: relationshipToProtagonist !== "与主角关系待后续确认" ? relationshipToProtagonist : "承接已出现剧情继续行动", lastUpdatedChapter: null },
    },
    rationale: "用户明确要求把已出现角色写入资料库，避免后续章节丢失角色承接。",
    risk: "warning",
    requiresUserConfirm: true,
    sourceUserMessage: message,
    extractedEntityName: name,
    sourceEvidence: message,
  };
}

function buildExplicitLocationSuggestion(name: string, message: string): FoundationGapSuggestion {
  const id = stableFoundationId("loc", name);
  return {
    id: `ai-${id}`,
    gapId: "ai-gap-explicit-location",
    category: "locations",
    actionType: "create_location",
    targetFile: "story/location-bible.json",
    targetPath: "locations",
    targetId: id,
    before: undefined,
    after: {
      id,
      name,
      type: inferExplicitLocationType(name),
      locationType: inferExplicitLocationType(name),
      spatialStructure: {
        floors: [],
        rooms: [],
        entrances: [],
        exits: [],
      },
      connectedLocations: [],
      knownFeatures: [],
      travelRules: [],
      resources: [],
      risks: [],
      fixedFacts: ["第1章已出现或被明确提及。"],
    },
    rationale: "用户明确要求把已出现地点写入资料库，避免后续空间和移动信息漂移。",
    risk: "warning",
    requiresUserConfirm: true,
    sourceUserMessage: message,
    extractedEntityName: name,
    sourceEvidence: message,
  };
}

function buildExplicitAssetSuggestion(name: string, message: string): FoundationGapSuggestion {
  const id = stableFoundationId("asset", name);
  const ownerName = extractAssetOwner(message);
  const currentLocationName = extractAssetCurrentLocation(message, ownerName);
  const carriedBy = extractAssetCarriedBy(message, ownerName);
  return {
    id: `ai-${id}`,
    gapId: "ai-gap-explicit-asset",
    category: "assets",
    actionType: "create_asset",
    targetFile: "story/assets.json",
    targetPath: "assets",
    targetId: id,
    before: undefined,
    after: {
      id,
      name,
      type: inferAssetTypeFromName(name, message),
      ownerName,
      currentLocationName,
      ...(carriedBy ? { carriedByCharacterId: carriedBy } : {}),
      status: inferAssetStatus(message),
      quantity: 1,
      isConsumable: false,
      isPlotCritical: true,
      canAiModify: false,
      rules: uniqueStrings([
        ...extractAssetRules(message),
        "状态变化必须通过正文或确认写入更新，不能凭空消失或新增能力。",
      ]),
      usageRules: extractAssetUsageRules(message),
      lossRules: extractAssetLossRules(message),
      notes: [message.slice(0, 120)],
    },
    rationale: "用户明确要求把已出现资产写入资料库，避免后续凭空出现、消失或能力漂移。",
    risk: "warning",
    requiresUserConfirm: true,
    sourceUserMessage: message,
    extractedEntityName: name,
    sourceEvidence: message,
  };
}

function buildExplicitWorldRuleSuggestion(rule: string, message: string): FoundationGapSuggestion {
  const id = stableFoundationId("world", rule);
  return {
    id: `ai-${id}`,
    gapId: "ai-gap-explicit-world-rule",
    category: "world",
    actionType: "update_world_rule",
    targetFile: "story/world-bible.json",
    targetPath: inferWorldRuleTargetPath(rule),
    before: undefined,
    after: [rule],
    rationale: "用户明确要求把世界观补充写入资料库，避免后续规则漂移。",
    risk: "warning",
    requiresUserConfirm: true,
    sourceUserMessage: message,
    extractedEntityName: rule,
    sourceEvidence: message,
  };
}

function buildExplicitWritingRuleSuggestion(rule: string, message: string): FoundationGapSuggestion {
  const id = stableFoundationId("writing", rule);
  return {
    id: `ai-${id}`,
    gapId: "ai-gap-explicit-writing-rule",
    category: "writingRules",
    actionType: "update_writing_rule",
    targetFile: "story/writing-rules.json",
    targetPath: inferWritingRuleTargetPath(rule),
    before: undefined,
    after: [rule],
    rationale: "用户明确要求把写作规则写入资料库，避免后续章节写法边界漂移。",
    risk: "warning",
    requiresUserConfirm: true,
    sourceUserMessage: message,
    extractedEntityName: rule,
    sourceEvidence: message,
  };
}

function buildExplicitKnowledgeBoundarySuggestion(name: string, message: string): FoundationGapSuggestion {
  const id = stableFoundationId("char", name);
  const known = extractKnowledgeKnown(message);
  const unknown = extractKnowledgeUnknown(message);
  return {
    id: `ai-${id}-knowledge`,
    gapId: "ai-gap-explicit-knowledge-boundary",
    category: "characters",
    actionType: "create_character",
    targetFile: "story/character-bible.json",
    targetPath: "characters",
    targetId: id,
    before: undefined,
    after: {
      bibleEntry: {
        id,
        name,
        role: "important",
        knowledgeKnown: known,
        knowledgeUnknown: unknown,
        cannotReveal: unknown.map((item) => `不能提前透露：${item}`),
      },
      profile: { id, name, tags: ["知识边界已登记"] },
      core: { characterId: id, personality: [], taboos: [] },
      state: {
        characterId: id,
        emotion: "待确认",
        goal: "按已登记知识边界参与剧情",
        knowledgeKnown: known,
        knowledgeUnknown: unknown,
        cannotReveal: unknown.map((item) => `不能提前透露：${item}`),
        lastUpdatedChapter: null,
      },
    },
    rationale: "用户明确要求写入角色知识边界，避免后续章节让角色提前知道或遗忘关键信息。",
    risk: "warning",
    requiresUserConfirm: true,
    sourceUserMessage: message,
    extractedEntityName: name,
    sourceEvidence: message,
  };
}

function stableFoundationId(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha1").update(value).digest("hex").slice(0, 10)}`;
}

function inferExplicitCharacterIdentity(name: string, message: string): string {
  const explicit = extractCharacterIdentity(message);
  if (explicit) return explicit;
  const around = contextAround(message, name);
  const titleAfterName = around.match(new RegExp(`${escapeRegExp(name)}(?:是|为|，|,|、)?([^，。；;]{2,24}(?:专员|负责人|顾问|秘书|律师|导师|经理|总监))`, "u"))?.[1]?.trim();
  if (titleAfterName) return titleAfterName;
  // 只按【消息上下文关键词】推断，绝不按具体人名特判（题材中立 + 隐私：任何用户书里
  // 出现同名角色都不能被打上别人书里的身份标签——这曾是硬编码真名的双重实害）。
  if (/生活秘书|秘书/u.test(around)) return "主角的秘书";
  if (/父亲|爸爸/u.test(around)) return "主角的父亲";
  if (/母亲|妈妈/u.test(around)) return "主角的母亲";
  if (/爷爷|创始人/u.test(around)) return "主角的爷爷/创始人长辈";
  if (/法务|律师/u.test(around)) return "法务/律师";
  return "第1章已出现角色";
}

function inferExplicitCharacterRole(_name: string, identity: string): string {
  if (identity.includes("秘书")) return "support";
  if (identity.includes("父亲") || identity.includes("母亲") || identity.includes("爷爷")) return "family";
  if (identity.includes("法务")) return "support";
  return "important";
}

function inferExplicitRelationshipToProtagonist(name: string, identity: string, message = ""): string {
  const explicit = extractRelationshipToProtagonist(message);
  if (explicit) return explicit;
  if (identity.includes("父亲")) return "父亲";
  if (identity.includes("母亲")) return "母亲";
  if (identity.includes("爷爷")) return "爷爷";
  if (identity.includes("秘书")) return "负责主角生活、行程和资料交接";
  if (identity.includes("法务")) return "为主角提供法律支持";
  return "与主角关系待后续确认";
}

function inferExplicitLocationType(name: string): string {
  if (/家|老房子|住处/u.test(name)) return "居住地点";
  if (/楼道/u.test(name)) return "过渡空间";
  if (/总部|集团/u.test(name)) return "办公地点";
  if (/市|区/u.test(name)) return "城市区域";
  return "地点";
}

function contextAround(message: string, needle: string): string {
  const index = message.indexOf(needle);
  if (index < 0) return message;
  return message.slice(Math.max(0, index - 24), Math.min(message.length, index + needle.length + 36));
}

function shouldUseDeterministicDraft(draft: FoundationGapSuggestion, result: FoundationGapChatModelResult): boolean {
  const current = [result.draftSuggestion, ...result.generatedSuggestions].filter((item): item is FoundationGapSuggestion => Boolean(item));
  const sameAction = current.filter((suggestion) => suggestion.actionType === draft.actionType);
  if (sameAction.length === 0) return true;
  if (draft.actionType === "update_world_rule" || draft.actionType === "update_writing_rule") {
    const draftValue = suggestionScalarValue(draft);
    if (!draftValue) return false;
    return sameAction.every((suggestion) => suggestionScalarValue(suggestion) !== draftValue);
  }
  const draftName = suggestionEntityName(draft);
  if (!draftName || isGenericFoundationEntityName(draftName)) return false;
  return sameAction.every((suggestion) => suggestionEntityName(suggestion) !== draftName);
}

function suggestionScalarValue(suggestion: FoundationGapSuggestion): string | undefined {
  if (typeof suggestion.after === "string") return suggestion.after.trim();
  if (Array.isArray(suggestion.after)) return suggestion.after.map(String).join("；").trim();
  if (isRecord(suggestion.after)) {
    return readString(suggestion.after.value)
      ?? readString(suggestion.after.rule)
      ?? readString(suggestion.after.text)
      ?? readString(suggestion.after.content);
  }
  return undefined;
}

function suggestionEntityName(suggestion: FoundationGapSuggestion): string | undefined {
  if (suggestion.extractedEntityName) return suggestion.extractedEntityName;
  if (isRecord(suggestion.after)) {
    if (isRecord(suggestion.after.bibleEntry)) return readString(suggestion.after.bibleEntry.name);
    return readString(suggestion.after.name);
  }
  return undefined;
}

function isGenericFoundationEntityName(name: string): boolean {
  return /^(新角色|待确认角色|待定导师|新地点|待确认地点|关键道具|待登记关键资产)$/u.test(name.trim());
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function mergeDraftAfter(after: unknown, message: string): unknown {
  if (!isRecord(after)) return after;
  const next = structuredClone(after) as Record<string, unknown>;
  if (isRecord(next.bibleEntry)) {
    if (/岁/u.test(message)) next.bibleEntry.age = extractFirst(message, /(\d{2})岁/u) ?? next.bibleEntry.age;
    if (/克制/u.test(message)) next.bibleEntry.speechStyle = "克制、冷静、很少夸人";
    if (/知道/u.test(message)) next.bibleEntry.knowledgeKnown = extractKnowledgeKnown(message);
  }
  return next;
}

function extractName(message: string, fallback: string): string {
  const patterns = [
    /(?:叫|名叫|名字是)\s*([一-鿿A-Za-z0-9]{2,12})/u,
    /补(?:一个|1个)?\s*(?:新)?(?:角色|人物)[：:\s]*([一-鿿A-Za-z0-9]{2,12})/u,
    /(?:新增|创建|添加|补充|补一下)?\s*(?:一个)?\s*(?:测试)?角色[：:\s]*([一-鿿A-Za-z0-9]{2,12})/u,
    /补(?:一下|充)?\s*([一-鿿A-Za-z0-9]{2,12})(?:这个)?角色/u,
  ];
  for (const pattern of patterns) {
    const cleaned = cleanEntityName(message.match(pattern)?.[1]);
    if (cleaned) return cleaned;
  }
  return fallback;
}

function extractFirst(message: string, pattern: RegExp): string | undefined {
  return message.match(pattern)?.[1];
}

function cleanEntityName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value
    .split(/[，。；;、,\s]/u)[0]
    ?.replace(/^(?:(?:请|麻烦)?(?:你)?(?:直接)?(?:帮我)?(?:测试)?(?:写入|记录|保存|新增|新建|创建|添加|补充|补一下|整理)?(?:一个|1个|新)?(?:测试)?(?:角色|地点|人物|资产|道具|物品)?)+/u, "")
    .replace(/这个(?:角色|地点)$/u, "")
    .trim();
  return cleaned && cleaned.length >= 2 ? cleaned : undefined;
}

function extractCharacterIdentity(message: string): string | undefined {
  const explicit = message.match(/(?:身份|定位|职业)(?:是|为|改成|改为|设为|：|:)?\s*([^，。；;]{2,24})/u)?.[1]?.trim();
  if (explicit) return explicit;
  const afterAge = message.match(/\d{2}岁[，,、\s]*([^，。；;]{2,24})/u)?.[1]?.trim();
  if (afterAge && /总监|经理|负责人|秘书|律师|顾问|导师|保镖|司机|医生|学生|同学|朋友|亲属|助手/u.test(afterAge)) return afterAge;
  const professionalTitle = message.match(/([^，。；;]{0,12}(?:风控合规部专员|风控专员|合规专员|公关总监|财务总监|法务总监|生活秘书|商业顾问|私人律师|审计部负责人|投融资负责人|负责人|专员|保镖|司机|医生|导师|助手))/u)?.[1]?.trim();
  if (professionalTitle) return professionalTitle;
  return message.match(/([一-鿿A-Za-z0-9]{2,8}的(?:商业顾问|生活秘书|秘书|顾问|导师|保镖|司机|医生|同学|朋友|亲属|助手))/u)?.[1]?.trim();
}

function extractCharacterSpeechStyle(message: string): string | undefined {
  const trait = message.match(/(?:性格|说话|语气)(?:是|为|：|:)?\s*([^，。；;]{2,24})/u)?.[1]?.trim();
  if (trait) return trait;
  if (/冷静/u.test(message) && /直接/u.test(message)) return "冷静直接";
  if (/克制/u.test(message)) return "克制、冷静、很少夸人";
  return undefined;
}

function extractRelationshipToProtagonist(message: string): string | undefined {
  const explicit = message.match(/(?:与|和)[一-鿿A-Za-z0-9]{1,8}关系(?:是|为|改成|改为|设为|：|:)?\s*([^，。；;]{2,40})/u)?.[1]?.trim();
  if (explicit) return explicit;
  const relation = message.match(/([一-鿿A-Za-z0-9]{2,8}的(?:商业顾问|生活秘书|秘书|顾问|导师|保镖|司机|医生|同学|朋友|亲属|助手))/u)?.[1]?.trim();
  if (relation) return relation;
  return undefined;
}

function extractExplicitBehaviorBoundaries(message: string): readonly string[] {
  const raw = message.match(/(?:边界|行为边界|能力边界)(?:是|为|改成|改为|设为|：|:)?\s*([^。；;]{2,100})/u)?.[1]?.trim();
  if (!raw) return [];
  return uniqueStrings(raw
    .split(/[、，,]/u)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2)
    .slice(0, 6));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function extractCurrentGoal(message: string, identity: string): string {
  const explicit = message.match(/(?:当前)?目标(?:是|为|：|:)?\s*([^，。；;]{2,40})/u)?.[1]?.trim();
  if (explicit) return explicit;
  const desire = extractCharacterDesire(message);
  if (desire !== "待确认") return desire;
  if (/顾问|秘书|助手/u.test(identity)) return "为主角提供专业支持并推动当前事务";
  return "观察主角并提供有限指导";
}

function extractCharacterAppearanceAnchors(message: string): readonly string[] {
  const raw = message.match(/(?:外貌|外形|长相|形象|穿着)(?:是|为|：|:)?\s*([^。；;]{2,80})/u)?.[1]?.trim();
  const labeled = raw
    ? raw
      .split(/[、，,]/u)
      .map((item) => item.trim())
      .filter((item) => item.length >= 2)
    : [];
  const inferred = [
    ...matchCharacterAppearanceAnchors(message, /[黑白灰银金棕红蓝紫青深浅]{0,2}(?:色)?(?:短发|长发|卷发|马尾|寸头)/gu),
    ...matchCharacterAppearanceAnchors(message, /[黑白灰银金棕红蓝紫青深浅]{0,2}(?:色)?(?:耳钉|耳环|眼镜|手表|项链|戒指)/gu),
    ...matchCharacterAppearanceAnchors(message, /(?:常穿|穿着|一身)?[黑白灰银金棕红蓝紫青深浅]{0,2}(?:色)?(?:西装|风衣|衬衫|制服|连衣裙|外套|夹克)/gu),
  ].map((item) => item.replace(/^(?:常穿|穿着|一身)/u, "").trim());
  return uniqueStrings([...labeled, ...inferred]).slice(0, 8);
}

function matchCharacterAppearanceAnchors(message: string, pattern: RegExp): readonly string[] {
  return Array.from(message.matchAll(pattern))
    .map((match) => match[0]?.trim())
    .filter((item): item is string => Boolean(item && item.length >= 2));
}

function extractCharacterPersonality(message: string): readonly string[] {
  const raw = message.match(/(?:性格|气质|作风)(?:是|为|：|:)?\s*([^。；;]{2,80})/u)?.[1]?.trim();
  if (!raw) return [];
  return uniqueStrings(raw
    .split(/[、，,但而和]/u)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2)
    .slice(0, 8));
}

function extractCharacterDesire(message: string): string {
  return message.match(/(?:欲望|目标|想要|想)(?:是|为|：|:)?\s*([^。；;]{2,80})/u)?.[1]?.trim() ?? "待确认";
}

function extractCharacterFear(message: string): string {
  return message.match(/(?:恐惧|害怕|怕)(?:是|为|：|:)?\s*([^。；;]{2,80})/u)?.[1]?.trim() ?? "待确认";
}

function extractCharacterWeakness(message: string): string {
  return message.match(/(?:弱点|短板|软肋)(?:是|为|：|:)?\s*([^。；;]{2,80})/u)?.[1]?.trim() ?? "待确认";
}

function extractCharacterCannotReveal(message: string): readonly string[] {
  const raw = message.match(/(?:禁忌|不能提前透露|不可提前透露|禁止透露)(?:是|为|：|:)?\s*([^。；;]{2,120})/u)?.[1]?.trim();
  if (!raw) return ["不能提前说出受保护秘密。"];
  return uniqueStrings(raw
    .split(/[、，,]/u)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2)
    .slice(0, 6));
}

function extractCharacterPrivateMotive(message: string, desire: string): string {
  const explicit = message.match(/(?:私心|隐藏动机|真实动机)(?:是|为|：|:)?\s*([^。；;]{2,80})/u)?.[1]?.trim();
  return explicit ?? (desire !== "待确认" ? desire : "待确认");
}

function buildCharacterBehaviorBoundaries(message: string): readonly string[] {
  const boundaries = ["不能替主角直接解决核心冲突。"];
  const cannotReveal = extractCharacterCannotReveal(message);
  return uniqueStrings([...boundaries, ...cannotReveal.map((item) => `不能提前透露：${item}`)]);
}

function buildCharacterBehaviorHabits(message: string): readonly string[] {
  const habits: string[] = [];
  if (/保护主角|保护他|保护她/u.test(message)) habits.push("会主动保护主角，但不越权替其完成核心选择。");
  if (/公关|舆论/u.test(message)) habits.push("优先从舆论、公关和外部观感角度判断风险。");
  if (/冷静|强势/u.test(message)) habits.push("处理问题时冷静强势，倾向直接压住场面。");
  return habits;
}

function inferWorldRuleTargetPath(message: string): string {
  if (/资源|金钱|钱|权力|服务|身份/u.test(message)) return "powerOrSurvivalSystems";
  if (/社会|阶层|圈子|规则|潜规则|结构/u.test(message)) return "socialOrder";
  if (/秘密|真相|隐藏/u.test(message)) return "protectedSecrets";
  if (/历史|过去|背景/u.test(message)) return "historyFacts";
  return "rules";
}

function inferWritingRuleTargetPath(message: string): string {
  if (/不要|禁止|不能|避免/u.test(message)) return "doNotDo";
  if (/文风|风格|语言|句子/u.test(message)) return "proseStyle";
  if (/爽点|读者|体验|期待/u.test(message)) return "readerExperienceRules";
  if (/揭示|秘密|真相|信息/u.test(message)) return "revealPolicy";
  if (/节奏|推进/u.test(message)) return "pacing";
  return "readerExperienceRules";
}

function normalizeRuleText(message: string): string {
  return cleanRuleText(message)
    || message.trim();
}

function cleanRuleText(value: string): string {
  return value
    .replace(/^(?:请)?(?:直接)?(?:加一条|补一条|新增一条|添加一条|加|补|新增|添加|补充|写入|记录|设定)?\s*(?:世界观规则|世界观|故事设定|写作规则|文风规则|禁止事项|规则)?[：:\s]*/u, "")
    .replace(/(?:。?\s*)?请(?:整理|生成|做成|形成)[^。]*?(?:草案|卡|建议)?(?:，|,)?(?:确认后)?(?:写入|保存|记录)?(?:。)?$/u, "")
    .replace(/(?:请)?(?:整理[^。]*?草案，?)?(?:确认后)?(?:直接)?(?:写入|保存|记录)(?:到)?(?:当前书籍)?(?:世界观|故事设定|写作规则|文风规则|规则|资料|设定)?(?:资料)?(?:里|中)?(?:。)?$/u, "")
    .replace(/[。；;\s]*(?:写入|保存|记录)(?:到)?(?:当前书籍)?(?:世界观|故事设定|写作规则|文风规则|规则|资料|设定)?(?:资料)?(?:里|中)?$/u, "")
    .replace(/[。；;]+$/u, "")
    .trim();
}

function extractKnowledgeBoundaryCharacterName(message: string): string | undefined {
  const patterns = [
    /(?:知识边界|秘密边界)[：:\s]*([一-鿿A-Za-z0-9]{2,12})(?:知道|不知道|不清楚|不能知道)/u,
    /(?:^|[，。；;\s])(?:把|将|给)?([一-鿿A-Za-z0-9]{2,12})(?:知道|不知道|不清楚|不能知道)/u,
  ];
  for (const pattern of patterns) {
    const cleaned = cleanEntityName(message.match(pattern)?.[1]);
    if (cleaned && !/^(?:补知识|知识边界|秘密边界)$/u.test(cleaned)) return cleaned;
  }
  return undefined;
}

function extractKnowledgeKnown(message: string): readonly string[] {
  const explicit = [...message.matchAll(/(?<!不)知道([^，。；;]+)/gu)]
    .map((match) => match[1]?.trim())
    .filter((item): item is string => Boolean(item));
  if (explicit.length) return explicit;
  if (/检测系统/u.test(message)) return ["财团检测系统存在问题。"];
  if (/秘密/u.test(message)) return ["知道一项暂未公开的秘密。"];
  return [];
}

function extractKnowledgeUnknown(message: string): readonly string[] {
  return [...message.matchAll(/(?:不知道|不清楚|不能知道)([^，。；;]+)/gu)]
    .map((match) => match[1]?.trim())
    .filter((item): item is string => Boolean(item));
}

function extractAssetName(message: string): string {
  const entity = extractExplicitAssetEntity(message);
  if (entity) return entity.name;
  if (/十亿|资金|存款|理财账户/u.test(message)) return "十个亿资金";
  const explicit = message.match(/(?:补|新增|创建|添加|整理|写入).{0,8}(?:一个|1个|新)?(?:资产|道具|物品)[：:\s]*([^，。；;、\n]{2,24})/u)?.[1]?.trim();
  if (explicit) return cleanAssetName(explicit) ?? explicit;
  const directAdd = message.match(/(?:给[^，。；;]{0,12}?加|加|配|安排)(?:一辆|一台|一个|一把|一部|一件|一双)?\s*([一-鿿A-Za-z0-9]{2,18}(?:权限卡|门禁卡|银行卡|卡|钥匙|证件|证|文件|清单|登记表|手机|双肩包|背包|枪|车辆|越野车|轿车|车))/u)?.[1]?.trim();
  if (directAdd) return cleanAssetName(directAdd) ?? directAdd;
  const named = message.match(/([一-鿿A-Za-z0-9]{2,18}(?:权限卡|门禁卡|银行卡|卡|钥匙|证件|证|文件|清单|登记表|手机|双肩包|背包|枪|车辆|车))/u)?.[1]?.trim();
  if (named) return cleanAssetName(named) ?? named;
  if (/枪/u.test(message)) return "来历不明的枪";
  if (/背包/u.test(message)) return "双肩包";
  if (/手机/u.test(message)) return "手机";
  if (/车/u.test(message)) return "车辆";
  return "关键道具";
}

function cleanAssetName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value
    .replace(/^(?:一个|1个|一辆|一台|一把|一部|一件|一双|新|资产|道具|物品)[：:\s]*/u, "")
    .replace(/(?:这个)?(?:资产|道具|物品)$/u, "")
    .trim();
  return cleaned.length >= 2 ? cleaned : undefined;
}

function inferAssetTypeFromName(name: string, message: string): string {
  if (/现金|金额|钱/u.test(name) || /现金|金额/u.test(message)) return "money";
  if (/双肩包|背包|箱|盒/u.test(name)) return "container";
  if (/卡|钥匙|证件|证/u.test(name)) return "keyItem";
  if (/文件|清单|登记表/u.test(name)) return "document";
  if (/手机/u.test(name)) return "item";
  if (/车|车辆/u.test(name)) return "vehicle";
  if (/枪/u.test(name)) return "keyItem";
  return "item";
}

function extractAssetOwner(message: string): string {
  const explicit = message.match(/(?:归属(?:是|为)?|拥有者是|属于|归|由)([一-鿿A-Za-z0-9]{2,12})(?:持有|拥有|保管)?/u)?.[1]?.trim()
    ?? message.match(/([一-鿿A-Za-z0-9]{2,12})(?:持有|拥有|保管|随身携带)/u)?.[1]?.trim();
  const cleaned = cleanPersonName(explicit);
  if (cleaned && !/当前|现在|可以|可用|限制|位置/u.test(cleaned)) return cleaned;
  if (/主角/u.test(message)) return "主角";
  return "待确认";
}

function extractAssetCurrentLocation(message: string, ownerName: string): string {
  const explicit = message.match(/(?:当前位置|位置|地点)(?:是|为|在|：|:)?\s*([^，。；;]{2,24})/u)?.[1]?.trim();
  if (explicit) return explicit;
  if (/随身|身上|携带|持有/u.test(message)) return "随身";
  if (ownerName !== "待确认" && /持有|保管/u.test(message)) return `${ownerName}随身`;
  return "待确认";
}

function extractAssetCarriedBy(message: string, ownerName: string): string | undefined {
  const carried = message.match(/([一-鿿A-Za-z0-9]{2,12})(?:随身携带|持有|保管)/u)?.[1]?.trim();
  const cleaned = cleanPersonName(carried);
  if (cleaned && !/当前|现在|可以|限制/u.test(cleaned)) return cleaned;
  if (/随身|身上|携带|持有/u.test(message) && ownerName !== "待确认") return ownerName;
  if (/主角/u.test(message) && /随身|身上|携带|持有/u.test(message)) return "主角";
  return undefined;
}

function cleanPersonName(value: string | undefined): string | undefined {
  const cleaned = value
    ?.replace(/^(?:归|由|属于)/u, "")
    .replace(/(?:持有|拥有|保管|随身携带)$/u, "")
    .trim();
  return cleaned && cleaned.length >= 2 ? cleaned : undefined;
}

function inferAssetStatus(message: string): string {
  if (/不能用|不可用|锁定|冻结|失效/u.test(message)) return "locked";
  if (/损坏|破损/u.test(message)) return "damaged";
  if (/可用|可以|能打开|可打开|持有|随身/u.test(message)) return "available";
  if (/(?:已经|已|当前|现在)(?:遗失|丢失)|(?:遗失|丢失)(?:了|在外|状态)/u.test(message)) return "lost";
  return "unknown";
}

function extractAssetRules(message: string): readonly string[] {
  const limits = splitShortClauses(extractAfterLabel(message, /(?:限制|规则)(?:是|为|：|:)?\s*([^，。；;]{2,80})/u));
  const rules = [
    ...limits.filter((item) => !/^遗失|^丢失/u.test(item)),
    extractAfterLabel(message, /(?:可|可以|能)(打开[^，。；;]{2,60})/u),
  ].filter((item): item is string => Boolean(item));
  return uniqueStrings(rules);
}

function extractAssetUsageRules(message: string): readonly string[] {
  const usage = extractAfterLabel(message, /(?:(?:用途|使用方式)(?:是|为|：|:)?|可用于|用来|可以)\s*([^，。；;]{2,80})/u);
  return uniqueStrings([
    ...(usage ? [usage] : []),
    ...(/打开|权限/u.test(message) ? [message.match(/(?:可|可以|能)(打开[^，。；;]{2,60})/u)?.[1]?.trim()].filter((item): item is string => Boolean(item)) : []),
  ]);
}

function extractAssetLossRules(message: string): readonly string[] {
  const loss = extractAfterLabel(message, /(?:遗失|丢失)(?:会|将|则|触发)?([^，。；;]{2,80})/u);
  const copied = /不能复制|不可复制/u.test(message) ? "不能复制。" : undefined;
  return uniqueStrings([
    ...(copied ? [copied] : []),
    ...(loss ? [`遗失会${loss.replace(/^会/u, "")}`] : []),
  ]);
}

function extractAfterLabel(message: string, pattern: RegExp): string | undefined {
  const value = message.match(pattern)?.[1]?.trim();
  return value && value.length >= 2 ? value : undefined;
}

function splitShortClauses(value: string | undefined): readonly string[] {
  if (!value) return [];
  return value
    .split(/[、，,]/u)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
}

// ---------------------------------------------------------------------------
// Location extraction
// ---------------------------------------------------------------------------

function extractLocationDetailFromMessage(message: string): {
  readonly name?: string;
  readonly parentLocation?: string;
  readonly locationType?: string;
  readonly floors: readonly string[];
  readonly rooms: readonly string[];
  readonly entrances: readonly string[];
  readonly exits: readonly string[];
  readonly connectedLocations: readonly string[];
  readonly travelRules: readonly Record<string, unknown>[];
  readonly resources: readonly string[];
  readonly risks: readonly string[];
  readonly fixedFacts: readonly string[];
  readonly sensoryDetails: {
    readonly visual?: readonly string[];
    readonly sound?: readonly string[];
    readonly smell?: readonly string[];
    readonly touch?: readonly string[];
  };
  readonly narrativeFunction?: string;
  readonly possibleConflicts: readonly string[];
  readonly currentStatus?: string;
  readonly hiddenFacts: readonly string[];
} {
  const name = extractLocationName(message)
    ?? (message.includes("创业孵化楼")
    ? "海天市旧城区创业孵化楼"
    : message.match(/给([^，。,.]{2,16})(?:补|完善|添加).*?(?:空间结构|地点|细节)/u)?.[1]?.trim());
  const spatialText = splitLocationClauses(message)
    .filter((clause) => !isLocationTravelClause(clause))
    .join("，");
  const floorMatches = [...spatialText.matchAll(/([一二三四五六七八九十\d]+楼[^，。,.、\s]*)/gu)].map((match) => match[1]).filter(Boolean) as string[];
  const basementFloorMatches = [
    ...spatialText.matchAll(/(?:^|[^A-Za-z0-9])((?:B|b)\s*\d+\s*(?:层|停车区|停车场|车库)?)/gu),
  ].map((match) => match[1]?.replace(/\s+/gu, "")).filter(Boolean) as string[];
  const floors = uniqueStrings([
    ...floorMatches,
    ...basementFloorMatches,
  ]);
  const explicitRooms = ["大厅", "包厢", "地下停车场", "地下车库", "停车场", "车辆调度位置"]
    .filter((item) => spatialText.includes(item));
  const inferredRooms = [...spatialText.matchAll(/([^，。,.、\s]{2,12}(?:窗口|大厅|包厢|停车场|办公区|终端区|楼梯间|正门))/gu)]
    .map((match) => match[1])
    .filter((item): item is string => Boolean(item) && !/^(?:入口|出口)(?:是|为|在)?/u.test(item));
  const rooms = uniqueStrings([
    ...explicitRooms,
    ...floorMatches,
    ...inferredRooms,
  ]);
  const entrance = message.match(/入口(?:是|为|在)?([^，。；;、]{2,12})/u)?.[1]?.trim();
  const exit = message.match(/出口(?:是|为|在)?([^，。；;、]{2,12})/u)?.[1]?.trim();
  const explicitType = message.match(/类型(?:是|为|：|:)?\s*([^，。；;]{2,24})/u)?.[1]?.trim();
  const resource = message.match(/资源(?:是|为|有)?([^，。；;]{2,24})/u)?.[1]?.trim();
  const risk = message.match(/风险(?:是|为|有)?([^，。；;]{2,30})/u)?.[1]?.trim();
  const visual = extractLocationSensoryField(message, "视觉");
  const sound = extractLocationSensoryField(message, "声音");
  const smell = extractLocationSensoryField(message, "气味");
  const touch = extractLocationSensoryField(message, "触感");
  const narrativeFunction = message.match(/叙事功能(?:是|为|：|:)?\s*([^，。；;]{2,80})/u)?.[1]?.trim();
  const currentStatus = message.match(/(?:当前状态|状态)(?:是|为|：|:)?\s*([^，。；;]{2,60})/u)?.[1]?.trim();
  const hiddenFact = message.match(/(?:隐藏事实|隐藏信息|秘密)(?:是|为|：|:)?\s*([^，。；;]{2,80})/u)?.[1]?.trim();
  const connectedLocations = uniqueStrings([
    ...(message.includes("公交站") ? ["旧城区公交站"] : []),
    ...(message.includes("市中心") ? ["市中心"] : []),
  ]);
  const travelRules: readonly Record<string, unknown>[] = [
    ...parseInternalFloorTravelRules(message),
    ...(message.match(/(?:到|去)(?:旧城区)?公交站(?:走路|步行)([一二三四五六七八九十\d]+)分钟/u)
      ? [{
          from: name?.replace(/^海天市旧城区/u, "") ?? "当前地点",
          targetLocation: "旧城区公交站",
          method: "walk",
          durationMinutes: parseChineseNumber(message.match(/(?:到|去)(?:旧城区)?公交站(?:走路|步行)([一二三四五六七八九十\d]+)分钟/u)?.[1]),
        }]
      : []),
    ...(message.match(/(?:到|去)市中心(?:要)?打车([一二三四五六七八九十\d]+)分钟/u)
      ? [{
          from: name?.replace(/^海天市旧城区/u, "") ?? "当前地点",
          targetLocation: "市中心",
          method: "taxi",
          durationMinutes: parseChineseNumber(message.match(/(?:到|去)市中心(?:要)?打车([一二三四五六七八九十\d]+)分钟/u)?.[1]),
        }]
      : []),
  ];
  return {
    ...(name ? { name } : {}),
    ...(name?.includes("旧城区") ? { parentLocation: "海天市旧城区" } : {}),
    locationType: explicitType ?? (name?.includes("楼") ? "building" : "地点"),
    floors,
    rooms,
    entrances: uniqueStrings([
      ...(entrance ? [entrance] : []),
      ...(message.includes("正门") || message.includes("一楼大厅") ? ["一楼大厅正门"] : []),
    ]),
    exits: uniqueStrings([
      ...(exit ? [exit] : []),
      ...(message.includes("正门") || message.includes("一楼大厅") ? ["正门"] : []),
      ...(message.includes("楼梯") ? ["楼梯间"] : []),
    ]),
    connectedLocations,
    travelRules,
    resources: uniqueStrings([
      ...(resource ? [resource] : []),
      ...(message.includes("终端") ? ["公共查询终端"] : []),
    ]),
    risks: uniqueStrings([
      ...(risk ? [risk] : []),
      ...(message.includes("检测") || message.includes("异常") ? ["检测系统可能记录异常反应"] : []),
    ]),
    fixedFacts: uniqueStrings([
      ...(message.includes("二楼申请窗口") ? ["申请窗口位于2楼，不能随意改到其他楼层"] : []),
      ...floors.map((floor) => `${floor}已登记为固定空间结构`),
    ]),
    sensoryDetails: {
      ...(visual.length ? { visual } : {}),
      ...(sound.length ? { sound } : {}),
      ...(smell.length ? { smell } : {}),
      ...(touch.length ? { touch } : {}),
    },
    ...(narrativeFunction ? { narrativeFunction } : {}),
    possibleConflicts: uniqueStrings([
      ...(risk ? [risk] : []),
      ...(narrativeFunction && /危机|压力|冲突|战场/u.test(narrativeFunction) ? [narrativeFunction] : []),
    ]),
    ...(currentStatus ? { currentStatus } : {}),
    hiddenFacts: uniqueStrings([
      ...(hiddenFact ? [hiddenFact] : []),
      ...(/监控|监听/u.test(message) ? ["此处存在被监控风险，角色交流需要注意信息边界。"] : []),
    ]),
  };
}

function extractLocationSensoryField(message: string, label: "视觉" | "声音" | "气味" | "触感"): readonly string[] {
  const raw = message.match(new RegExp(`${label}(?:是|为|：|:)?\\s*([^。；;]{2,80})`, "u"))?.[1]?.trim();
  if (!raw) return [];
  return uniqueStrings(raw
    .split(/[、，,]/u)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2)
    .slice(0, 8));
}

function extractLocationName(message: string): string | undefined {
  const patterns = [
    /(?:新增|创建|添加|补充|补一下)?\s*(?:一个)?\s*(?:测试)?地点[：:\s]*([一-鿿A-Za-z0-9]{2,16})/u,
    /(?:叫|名叫|名字是)\s*([一-鿿A-Za-z0-9]{2,16})/u,
  ];
  for (const pattern of patterns) {
    const cleaned = cleanEntityName(message.match(pattern)?.[1]);
    if (cleaned) return cleaned;
  }
  return undefined;
}

function splitLocationClauses(message: string): readonly string[] {
  return message.split(/[。；;，,、\n]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function isLocationTravelClause(clause: string): boolean {
  return /(?:走路|步行|打车|开车|坐车|公交).{0,12}(?:分钟|小时|公里)?/u.test(clause)
    || /(?:到|去).{0,16}(?:公交站|市中心).{0,12}(?:走路|步行|打车|开车|坐车|公交|分钟|小时|公里)/u.test(clause)
    || /[一二三四五六七八九十\d]+楼.{0,8}到[一二三四五六七八九十\d]+楼.{0,12}(?:楼梯|分钟)/u.test(clause);
}

function parseInternalFloorTravelRules(message: string): readonly Record<string, unknown>[] {
  const rules: Record<string, unknown>[] = [];
  const match = message.match(/(?:二楼|2楼)(?:申请窗口)?到(?:一楼|1楼)(?:大厅)?(?:走)?楼梯([一二三四五六七八九十\d]+)分钟/u);
  if (match) {
    rules.push({
      from: "2楼申请窗口",
      targetLocation: "1楼大厅",
      method: "stairs",
      durationMinutes: parseChineseNumber(match[1]),
      constraint: "走楼梯",
    });
  }
  return rules;
}

function parseChineseNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/u.test(value)) return Number(value);
  const map: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  if (value === "十") return 10;
  const tenIndex = value.indexOf("十");
  if (tenIndex >= 0) {
    const left = value.slice(0, tenIndex);
    const right = value.slice(tenIndex + 1);
    return (left ? map[left] ?? 1 : 1) * 10 + (right ? map[right] ?? 0 : 0);
  }
  return map[value];
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((item) => item.trim()).filter(Boolean)));
}

export const __foundationGapsRouteTest = {
  buildDeterministicDeleteReply,
  buildDeterministicSchemaSuggestion,
  buildExplicitFoundationWriteSuggestions,
  inferFoundationGapChatIntent,
  isUsefulFoundationModelSuggestion,
  normalizeFoundationGapChatResult,
  resolveFoundationChatSuggestions,
  shouldDraftFoundationSchema,
};
