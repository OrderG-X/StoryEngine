import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  isFormalCommitV0AllowedPath,
  isFormalCommitV0ChapterOutputPath,
} from "./formal-commit-v0-allowlist.js";

export const TRANSACTION_HARDENING_V1_VERSION = "transaction-hardening-v1";

export interface CommitPreviewTransactionMetadata {
  readonly version: typeof TRANSACTION_HARDENING_V1_VERSION;
  readonly transactionId: string;
  readonly previewHash: string;
  readonly projectHash: string;
  readonly chapter: number;
  readonly draftHash: string;
  readonly commitPlanHash: string;
  readonly selectiveCandidateSummaryHash: string;
}

export interface TransactionResidue {
  readonly id: string;
  readonly status: string;
  readonly manifestPath?: string;
}

export type CommitApplyPreflightFailureCode =
  | "missing_transaction_id"
  | "transaction_id_mismatch"
  | "missing_preview_hash"
  | "preview_hash_mismatch"
  | "missing_idempotency_key"
  | "transaction_residue_found";

export type CommitApplyPreflightResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: CommitApplyPreflightFailureCode; readonly message: string; readonly residues?: readonly TransactionResidue[] };

export function buildCommitPreviewTransaction(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly draftContent: string;
  readonly commitPlan: unknown;
}): CommitPreviewTransactionMetadata {
  const projectHash = hashText(input.projectDir);
  const draftHash = hashText(input.draftContent);
  const commitPlanHash = hashStableJson(readCommitPlanPayload(input.commitPlan));
  const selectiveCandidateSummaryHash = hashStableJson(buildSelectiveCandidateSummary(input.commitPlan));
  const previewHash = hashStableJson({
    version: TRANSACTION_HARDENING_V1_VERSION,
    projectHash,
    chapter: input.chapter,
    draftHash,
    commitPlanHash,
    selectiveCandidateSummaryHash,
  });

  return {
    version: TRANSACTION_HARDENING_V1_VERSION,
    transactionId: `txv1-ch${String(input.chapter).padStart(4, "0")}-${previewHash.slice(0, 16)}`,
    previewHash,
    projectHash,
    chapter: input.chapter,
    draftHash,
    commitPlanHash,
    selectiveCandidateSummaryHash,
  };
}

export function validateCommitApplyPreflight(input: {
  readonly transactionId: unknown;
  readonly expectedPreviewHash: unknown;
  readonly idempotencyKey: unknown;
  readonly current: CommitPreviewTransactionMetadata;
  readonly residues: readonly TransactionResidue[];
}): CommitApplyPreflightResult {
  if (typeof input.transactionId !== "string" || input.transactionId.trim().length === 0) {
    return failure("missing_transaction_id", "缺少 transactionId，请重新生成定稿预览。");
  }
  if (input.transactionId !== input.current.transactionId) {
    return failure("transaction_id_mismatch", "transactionId 与当前定稿预览不一致，请重新生成定稿预览。");
  }
  if (typeof input.expectedPreviewHash !== "string" || input.expectedPreviewHash.trim().length === 0) {
    return failure("missing_preview_hash", "缺少 previewHash，请重新生成定稿预览。");
  }
  if (input.expectedPreviewHash !== input.current.previewHash) {
    return failure("preview_hash_mismatch", "工作稿或定稿预览已变化，请重新生成定稿预览后再确认。");
  }
  if (!isValidIdempotencyKey(input.idempotencyKey)) {
    return failure("missing_idempotency_key", "缺少 idempotencyKey，无法安全执行正式定稿。");
  }
  if (input.residues.length > 0) {
    return {
      ok: false,
      code: "transaction_residue_found",
      message: "检测到未完成的事务残留，请先处理后再正式定稿。",
      residues: input.residues,
    };
  }
  return { ok: true };
}

export async function findTransactionResidues(projectDir: string): Promise<readonly TransactionResidue[]> {
  const txRoot = join(projectDir, ".story-engine-tx");
  try {
    const txRootStats = await lstat(txRoot);
    if (!txRootStats.isDirectory()) {
      return [{ id: ".story-engine-tx", status: "unsafe_tx_root" }];
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    return [{ id: ".story-engine-tx", status: "unsafe_tx_root" }];
  }

  let entries;
  try {
    entries = await readdir(txRoot, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }

  const residues: TransactionResidue[] = [];
  for (const entry of entries) {
    if (entry.name === ".DS_Store") continue;
    if (entry.isDirectory()) {
      const snapshotManifestPath = join(txRoot, entry.name, "snapshot-manifest.json");
      const snapshotResidue = await readFormalCommitSnapshotResidue(entry.name, snapshotManifestPath);
      if (snapshotResidue.kind === "ignored") continue;
      if (snapshotResidue.kind === "blocking") {
        residues.push(snapshotResidue.residue);
        continue;
      }

      const legacyManifestPath = join(txRoot, entry.name, "manifest.json");
      residues.push(await readLegacyTransactionResidue(entry.name, legacyManifestPath));
    } else {
      residues.push({ id: entry.name, status: "unexpected_file" });
    }
  }
  return residues;
}

async function readFormalCommitSnapshotResidue(
  id: string,
  manifestPath: string,
): Promise<
  | { readonly kind: "missing" }
  | { readonly kind: "ignored" }
  | { readonly kind: "blocking"; readonly residue: TransactionResidue }
> {
  try {
    const manifestStats = await lstat(manifestPath);
    if (!manifestStats.isFile()) {
      return { kind: "blocking", residue: { id, status: "unsafe_snapshot_manifest", manifestPath } };
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return { kind: "missing" };
    return { kind: "blocking", residue: { id, status: "unsafe_snapshot_manifest", manifestPath } };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(manifestPath, "utf-8")) as unknown;
  } catch {
    return { kind: "blocking", residue: { id, status: "unreadable_snapshot_manifest", manifestPath } };
  }

  const manifest = asRecord(raw);
  if (!manifest) {
    return { kind: "blocking", residue: { id, status: "unreadable_snapshot_manifest", manifestPath } };
  }

  const status = typeof manifest.status === "string" && manifest.status.trim()
    ? manifest.status
    : "unknown";
  if (status !== "finalized") {
    return { kind: "blocking", residue: { id, status, manifestPath } };
  }

  const expectedChapter = parseTransactionChapterFromId(id);
  if (
    expectedChapter === undefined
    || !isValidFinalizedFormalCommitSnapshotManifest(manifest, id, expectedChapter)
  ) {
    return { kind: "blocking", residue: { id, status: "finalized_invalid", manifestPath } };
  }

  return { kind: "ignored" };
}

async function readLegacyTransactionResidue(id: string, manifestPath: string): Promise<TransactionResidue> {
  let status = "unknown";
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as { readonly status?: unknown };
    status = typeof manifest.status === "string" && manifest.status.trim() ? manifest.status : "unknown";
  } catch (error) {
    status = isNodeError(error) && error.code === "ENOENT" ? "missing_manifest" : "unreadable_manifest";
  }
  return { id, status, manifestPath };
}

function isValidFinalizedFormalCommitSnapshotManifest(
  manifest: Record<string, unknown>,
  transactionId: string,
  expectedChapter: number,
): boolean {
  if (
    manifest.status !== "finalized"
    || manifest.chapter !== expectedChapter
    || !isValidFinalizedAt(manifest.finalizedAt)
    || manifest.noFormalStateWriteConfirmed !== true
    || manifest.productionApplyImplemented !== false
    || manifest.routeWired !== true
    || manifest.formalApplyMode !== "chapter_only_v0a"
    || manifest.stateWritesEnabled !== false
    || manifest.defaultFormalWritesEnabled !== false
    || manifest.cleanupPerformed !== false
    || !Array.isArray(manifest.files)
    || !Array.isArray(manifest.appliedChangedFiles)
  ) {
    return false;
  }

  const expectedChapterPath = chapterPath(expectedChapter);
  const manifestFiles = parseFinalizedManifestFilePaths(manifest.files, {
    expectedChapterPath,
    expectedSnapshotPath: `.story-engine-tx/${transactionId}/snapshot/${expectedChapterPath}`,
  });
  if (!manifestFiles) return false;

  const appliedChangedFiles = parseChapterOnlyChangedFiles(manifest.appliedChangedFiles, expectedChapterPath);
  if (!appliedChangedFiles) return false;

  return sameStringSet(manifestFiles, appliedChangedFiles);
}

function parseTransactionChapterFromId(id: string): number | undefined {
  const match = /^commit-chapter-(\d+)$/u.exec(id);
  if (!match) return undefined;
  const chapter = Number(match[1]);
  if (!Number.isSafeInteger(chapter) || chapter <= 0) return undefined;
  return id === `commit-chapter-${String(chapter).padStart(4, "0")}` ? chapter : undefined;
}

function parseFinalizedManifestFilePaths(
  files: readonly unknown[],
  expected: {
    readonly expectedChapterPath: string;
    readonly expectedSnapshotPath: string;
  },
): string[] | undefined {
  const parsed: string[] = [];
  for (const file of files) {
    const record = asRecord(file);
    if (!record || typeof record.relativePath !== "string") return undefined;
    if (record.relativePath !== expected.expectedChapterPath || !isChapterOnlyFormalCommitPath(record.relativePath)) {
      return undefined;
    }
    if (!isValidFinalizedFileRollbackMetadata(record, expected.expectedSnapshotPath)) return undefined;
    parsed.push(record.relativePath);
  }

  if (parsed.length === 0 || duplicateValues(parsed).length > 0) return undefined;
  return parsed;
}

function isValidFinalizedFileRollbackMetadata(
  file: Record<string, unknown>,
  expectedSnapshotPath: string,
): boolean {
  if (file.rollbackAction === "delete_if_created") {
    return file.snapshotPath == null;
  }

  if (file.rollbackAction !== "restore_previous") return false;
  return (
    file.snapshotPath === expectedSnapshotPath
    && typeof file.byteLength === "number"
    && Number.isSafeInteger(file.byteLength)
    && file.byteLength >= 0
    && typeof file.sha256 === "string"
    && /^[0-9a-f]{64}$/u.test(file.sha256)
  );
}

function parseChapterOnlyChangedFiles(files: readonly unknown[], expectedChapterPath: string): string[] | undefined {
  const parsed: string[] = [];
  for (const file of files) {
    if (
      typeof file !== "string"
      || file !== expectedChapterPath
      || !isChapterOnlyFormalCommitPath(file)
    ) {
      return undefined;
    }
    parsed.push(file);
  }

  if (parsed.length === 0 || duplicateValues(parsed).length > 0) return undefined;
  return parsed;
}

function isChapterOnlyFormalCommitPath(path: string): boolean {
  return isFormalCommitV0AllowedPath(path) && isFormalCommitV0ChapterOutputPath(path);
}

function chapterPath(chapter: number): string {
  return `chapters/${String(chapter).padStart(4, "0")}.md`;
}

function isValidFinalizedAt(value: unknown): boolean {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  return Number.isFinite(Date.parse(value));
}

function failure(code: CommitApplyPreflightFailureCode, message: string): CommitApplyPreflightResult {
  return { ok: false, code, message };
}

function isValidIdempotencyKey(value: unknown): boolean {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{8,160}$/u.test(value.trim());
}

function readCommitPlanPayload(value: unknown): unknown {
  const record = asRecord(value);
  return record?.commitPlan ?? value;
}

function buildSelectiveCandidateSummary(value: unknown): unknown {
  const candidates: Array<{
    readonly path: string;
    readonly id?: string;
    readonly name?: string;
    readonly severity?: string;
    readonly requiresUserConfirm?: boolean;
  }> = [];
  collectCandidates(value, "$", candidates, 0);
  return candidates.sort((left, right) =>
    `${left.path}:${left.id ?? ""}:${left.name ?? ""}`.localeCompare(`${right.path}:${right.id ?? ""}:${right.name ?? ""}`),
  );
}

function collectCandidates(
  value: unknown,
  path: string,
  out: Array<{
    readonly path: string;
    readonly id?: string;
    readonly name?: string;
    readonly severity?: string;
    readonly requiresUserConfirm?: boolean;
  }>,
  depth: number,
): void {
  if (depth > 8) return;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const record = asRecord(item);
      if (record && (typeof record.id === "string" || typeof record.name === "string")) {
        out.push({
          path: `${path}[${index}]`,
          ...(typeof record.id === "string" ? { id: record.id } : {}),
          ...(typeof record.name === "string" ? { name: record.name } : {}),
          ...(typeof record.severity === "string" ? { severity: record.severity } : {}),
          ...(typeof record.requiresUserConfirm === "boolean" ? { requiresUserConfirm: record.requiresUserConfirm } : {}),
        });
      } else {
        collectCandidates(item, `${path}[${index}]`, out, depth + 1);
      }
    }
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  for (const [key, child] of Object.entries(record)) {
    collectCandidates(child, `${path}.${key}`, out, depth + 1);
  }
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf-8").digest("hex");
}

function hashStableJson(value: unknown): string {
  return hashText(stableStringify(value));
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(",")}}`;
}

function duplicateValues(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const item of items) {
    if (seen.has(item) && !duplicates.includes(item)) {
      duplicates.push(item);
      continue;
    }
    seen.add(item);
  }
  return duplicates;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((item) => right.includes(item));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
