import type {
  BookFileActionApiResponse,
  CreateProjectApiResponse,
  CreateProjectRequest,
  DraftRevisionApplyApiResponse,
  DraftRevisionApplyRequest,
  DraftRevisionApplyResult,
  DraftRevisionPreview,
  DraftRevisionPreviewApiResponse,
  DraftRevisionPreviewRequest,
  DraftRevisionTask,
  GenerateDraftRequest,
  DeleteBookRequest,
  ImportBookApiResponse,
  ImportBookFile,
  ImportBookRequest,
  ImportPreview,
  ImportPreviewApiResponse,
  RenameBookRequest,
  ReaderProgressApiResponse,
  ReaderCatchUpStatus,
  SnapshotEntryDto,
  SnapshotListApiResponse,
  SnapshotRestoreApiResponse,
  StateOverview,
  StateOverviewApiResponse,
  StateOverviewRequest,
  UsageSummary,
  UsageSummaryApiResponse,
} from "./types.js";
import { fetchJson } from "./fetchJson.js";
export { fetchModelSettings, saveModelSettings, testModelConnection } from "./modelSettingsClient.js";


// ---------------------------------------------------------------------------
// Public API functions
// ---------------------------------------------------------------------------

export async function fetchStateOverview(input: StateOverviewRequest, signal?: AbortSignal): Promise<StateOverview> {
  const params = new URLSearchParams();
  params.set("project", input.projectPath);
  if (input.chapter?.trim()) params.set("chapter", input.chapter.trim());
  if (input.maxTimelineEvents !== undefined) params.set("maxTimelineEvents", String(input.maxTimelineEvents));

  const payload = await fetchJson<StateOverviewApiResponse>(
    `/api/state-overview?${params.toString()}`,
    {},
    signal,
  );
  if (!payload.ok) {
    throw new Error(payload.error);
  }
  return payload.overview;
}

/** 编辑部三个跟读角色的补读进度（R4.3）：在读期间前端 5 秒一次的轻量轮询走这里，别拿整个概况当轮询。 */
export async function fetchReaderCatchUp(projectPath: string, signal?: AbortSignal): Promise<ReaderCatchUpStatus> {
  const params = new URLSearchParams();
  params.set("project", projectPath);
  const payload = await fetchJson<ReaderProgressApiResponse>(
    `/api/reader-progress?${params.toString()}`,
    {},
    signal,
  );
  if (!payload.ok) {
    throw new Error(payload.error);
  }
  return { reading: payload.reading, roles: payload.roles, ...(payload.reread ? { reread: payload.reread } : {}) };
}

export async function fetchUsageSummary(projectPath: string, signal?: AbortSignal): Promise<UsageSummary> {
  const params = new URLSearchParams({ project: projectPath });
  const payload = await fetchJson<UsageSummaryApiResponse>(
    `/api/usage-summary?${params.toString()}`,
    {},
    signal,
  );
  if (!payload.ok) {
    throw new Error(payload.error);
  }
  return payload.summary;
}

export async function fetchSnapshots(projectPath: string, signal?: AbortSignal): Promise<SnapshotEntryDto[]> {
  const params = new URLSearchParams({ project: projectPath });
  const payload = await fetchJson<SnapshotListApiResponse>(
    `/api/snapshots?${params.toString()}`,
    {},
    signal,
  );
  if (!payload.ok) {
    throw new Error(payload.error);
  }
  return [...payload.snapshots];
}

export async function restoreSnapshotApi(projectPath: string, id: string, signal?: AbortSignal): Promise<void> {
  const payload = await fetchJson<SnapshotRestoreApiResponse>(
    "/api/snapshots/restore",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectPath, id }),
    },
    signal,
  );
  if (!payload.ok) {
    throw new Error(payload.error);
  }
}

import type { BookSummary } from "../types.js";

/** 默认书库扫描：最近的书 + 书库根目录 + 盘上实际存在的全部书目录（判断书架上哪些已经不在了）。 */
export async function fetchDefaultBookLibrary(signal?: AbortSignal): Promise<{
  readonly books: BookSummary[];
  readonly root?: string;
  readonly existingPaths?: readonly string[];
}> {
  const payload = await fetchJson<{ ok: boolean; books?: BookSummary[]; root?: string; existingPaths?: string[] }>(
    "/api/books/list-default",
    { method: "GET" },
    signal,
  );
  if (!payload.ok) throw new Error("Failed to list default books");
  return {
    books: payload.books ?? [],
    ...(typeof payload.root === "string" ? { root: payload.root } : {}),
    ...(Array.isArray(payload.existingPaths) ? { existingPaths: payload.existingPaths } : {}),
  };
}

export async function createStoryProjectFromDraft(input: CreateProjectRequest, signal?: AbortSignal): Promise<{ readonly projectDir: string; readonly overview: StateOverview }> {
  const payload = await fetchJson<CreateProjectApiResponse>(
    "/api/projects/create",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
    signal,
  );
  if (!payload.ok) {
    throw new Error(payload.error);
  }
  return { projectDir: payload.projectDir, overview: payload.overview };
}

/** 导入已写的书（P8）第一步：切章预览，不写盘。 */
export async function previewImportBook(files: readonly ImportBookFile[], signal?: AbortSignal): Promise<ImportPreview> {
  const payload = await fetchJson<ImportPreviewApiResponse>(
    "/api/books/import-preview",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ files }) },
    signal,
  );
  if (!payload.ok) throw new Error(payload.error);
  const { ok: _ok, ...preview } = payload;
  return preview;
}

/** 导入已写的书（P8）第二步：建书、导章节，记账员在后台开始通读记账。 */
export async function importBookProject(input: ImportBookRequest, signal?: AbortSignal): Promise<{ readonly projectDir: string; readonly overview: StateOverview; readonly chapters: number }> {
  const payload = await fetchJson<ImportBookApiResponse>(
    "/api/books/import",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) },
    signal,
  );
  if (!payload.ok) throw new Error(payload.error);
  return { projectDir: payload.projectDir, overview: payload.overview, chapters: payload.imported.chapters };
}

/** 通读记账停下后「接着记」（P8）。 */
export async function resumeBookReread(projectPath: string, signal?: AbortSignal): Promise<void> {
  const payload = await fetchJson<{ readonly ok: boolean; readonly error?: string }>(
    "/api/books/reread",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectPath }) },
    signal,
  );
  if (!payload.ok) throw new Error(payload.error ?? "没能接着记");
}

export async function renameBookProject(input: RenameBookRequest, signal?: AbortSignal): Promise<{ readonly title: string; readonly overview: StateOverview }> {
  const payload = await fetchJson<BookFileActionApiResponse>(
    "/api/books/rename",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
    signal,
  );
  if (!payload.ok) {
    throw new Error(payload.error);
  }
  if (!payload.overview || !payload.title) {
    throw new Error("重命名结果不完整。");
  }
  return { title: payload.title, overview: payload.overview };
}

export async function removeBookProject(input: DeleteBookRequest, signal?: AbortSignal): Promise<void> {
  const payload = await fetchJson<BookFileActionApiResponse>(
    "/api/books/delete",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
    signal,
  );
  if (!payload.ok) {
    throw new Error(payload.error);
  }
}

export async function openBookProjectFolder(projectPath: string, signal?: AbortSignal): Promise<void> {
  const payload = await fetchJson<BookFileActionApiResponse>(
    "/api/books/open-folder",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectPath }),
    },
    signal,
  );
  if (!payload.ok) {
    throw new Error(payload.error);
  }
}

/**
 * 抽卡候选（块③）：生成一版正文【不写盘、不快照、不改状态】，临时返回给前端并排展示，挑中才落盘。
 * 走 /api/draft/generate 的 persist:false 分支；不返回 overview（候选不改任何状态）。
 */
export async function generateDraftCandidate(
  input: GenerateDraftRequest,
  signal?: AbortSignal,
): Promise<{ readonly draftContent: string; readonly draftTitle?: string; readonly contextBudget?: { readonly droppedSections: readonly string[] }; readonly planNote?: string }> {
  const payload = await fetchJson<
    | { readonly ok: true; readonly draftContent: string; readonly draftTitle?: string; readonly contextBudget?: { readonly droppedSections: readonly string[] }; readonly planNote?: string }
    | { readonly ok: false; readonly error: string }
  >(
    "/api/draft/generate",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input, persist: false }),
    },
    signal,
  );
  if (!payload.ok) {
    throw new Error(payload.error);
  }
  return { draftContent: payload.draftContent, draftTitle: payload.draftTitle, contextBudget: payload.contextBudget, ...(payload.planNote ? { planNote: payload.planNote } : {}) };
}

/** 抽卡「挑中落盘」（块③）：把选中的候选正文写进工作稿，服务端写前留可撤销快照。 */
export async function applyDraftCandidate(
  input: { readonly projectPath: string; readonly chapter: number; readonly draftContent: string },
  signal?: AbortSignal,
): Promise<{ readonly draftContent: string; readonly draftTitle?: string; readonly overview: StateOverview }> {
  const payload = await fetchJson<
    | { readonly ok: true; readonly draftContent: string; readonly draftTitle?: string; readonly overview: StateOverview }
    | { readonly ok: false; readonly error: string }
  >(
    "/api/draft/apply-candidate",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
    signal,
  );
  if (!payload.ok) {
    throw new Error(payload.error);
  }
  return { draftContent: payload.draftContent, draftTitle: payload.draftTitle, overview: payload.overview };
}

export async function previewDraftRevision(
  input: DraftRevisionPreviewRequest,
  signal?: AbortSignal,
): Promise<{
  readonly task: DraftRevisionTask;
  readonly preview: DraftRevisionPreview;
}> {
  const payload = await fetchJson<DraftRevisionPreviewApiResponse>(
    "/api/draft/revision/preview",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
    signal,
  );
  if (!payload.ok) {
    throw new Error(payload.error);
  }
  return { task: payload.task, preview: payload.preview };
}

export async function applyDraftRevision(
  input: DraftRevisionApplyRequest,
  signal?: AbortSignal,
): Promise<{
  readonly result: DraftRevisionApplyResult;
  readonly draftContent: string;
  readonly overview: StateOverview;
}> {
  const payload = await fetchJson<DraftRevisionApplyApiResponse>(
    "/api/draft/revision/apply",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input, confirm: true }),
    },
    signal,
  );
  if (!payload.ok) {
    throw new Error(payload.error);
  }
  return { result: payload.result, draftContent: payload.draftContent, overview: payload.overview };
}

export interface DeAiFlavorBatchChange {
  readonly before: string;
  readonly after: string;
}
export interface DeAiFlavorBatchResponse {
  readonly result: {
    readonly applied: boolean;
    readonly chapter: number;
    readonly detected: number;
    readonly rewritten: number;
    readonly skipped: number;
    readonly changes: readonly DeAiFlavorBatchChange[];
  };
  readonly summary: string;
  readonly draftContent: string;
  readonly snapshotId?: string;
}

/** AI 味一键全修：把卡片里那几条 AI 腔一次批量改写、倒序落盘（confirm 强制 true）。 */
export async function applyDeAiFlavorBatch(
  input: {
    readonly projectPath: string;
    readonly chapter: number;
    readonly violations: readonly { readonly id?: string; readonly text: string; readonly reason?: string; readonly severity?: string; readonly suggestedFix?: string }[];
    readonly draftContent?: string;
  },
  signal?: AbortSignal,
): Promise<DeAiFlavorBatchResponse> {
  const payload = await fetchJson<DeAiFlavorBatchResponse & { ok: boolean; error?: string }>(
    "/api/draft/de-ai-flavor/apply",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input, confirm: true }),
    },
    signal,
  );
  if (!payload.ok) {
    throw new Error(payload.error ?? "一键去 AI 味失败。");
  }
  return { result: payload.result, summary: payload.summary, draftContent: payload.draftContent, ...(payload.snapshotId ? { snapshotId: payload.snapshotId } : {}) };
}
