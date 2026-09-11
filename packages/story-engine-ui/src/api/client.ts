import type {
  ChapterChatApiResponse,
  ChapterChatRequest,
  ChapterChatResponse,
  ChapterWorkspaceApiResponse,
  ChapterWorkspaceRequest,
  ChapterWorkspaceSnapshot,
  ChapterSteeringApiResponse,
  ChapterSteeringDraft,
  ChapterSteeringRequest,
  CharacterMatrixPreviewPreflightApiResponse,
  CharacterMatrixPreviewPreflightPlan,
  CharacterMatrixPreviewPreflightRequest,
  BookFileActionApiResponse,
  CommitApplyApiResponse,
  CommitApplySuccessResult,
  CommitPreviewApiResponse,
  CommitPreviewRequest,
  FormalCommitPreviewRouteResult,
  CommitPreviewTransactionMetadata,
  CommitRequest,
  CreateProjectApiResponse,
  CreateProjectRequest,
  DraftAIReviewApiResponse,
  DraftAIReviewReport,
  DraftAIReviewRequest,
  DraftDirectEditApiResponse,
  DraftDirectEditRequest,
  DraftDirectEditResult,
  DraftRevisionApplyApiResponse,
  DraftRevisionApplyRequest,
  DraftRevisionApplyResult,
  DraftRevisionPreview,
  DraftRevisionPreviewApiResponse,
  DraftRevisionPreviewRequest,
  DraftRevisionTask,
  DraftQualityApiResponse,
  DraftQualityReport,
  DraftQualityRequest,
  FoundationGapApplyApiResponse,
  FoundationGapAppliedWrite,
  FoundationGapApplyPlan,
  FoundationGapSkippedWrite,
  FoundationGapRollbackApiResponse,
  FoundationGapChatApiResponse,
  FoundationGapChatMessageInput,
  FoundationGapChatResult,
  FoundationGapConfirmCharacterStateWriteApiResponse,
  FoundationGapConfirmCharacterStateWriteRequest,
  FoundationGapConfirmCharacterStateWriteResult,
  FoundationGapDecision,
  FoundationGapPreviewApiResponse,
  FoundationGapReport,
  FoundationGapReportApiResponse,
  FoundationGapSuggestion,
  FoundationGapSuggestionsApiResponse,
  GenerateDraftApiResponse,
  GenerateDraftRequest,
  MemoryContextReadRouteRequest,
  MemoryContextReadRouteResult,
  DeleteBookRequest,
  RenameBookRequest,
  SaveChapterWorkspaceRequest,
  SnapshotEntryDto,
  SnapshotListApiResponse,
  SnapshotRestoreApiResponse,
  StateOverview,
  StateOverviewApiResponse,
  StateOverviewRequest,
  UpdateStorySettingsRequest,
  UpdateWritingRulesRequest,
  UsageSummary,
  UsageSummaryApiResponse,
  WorkspacePatchApplyApiResponse,
  WorkspacePatchApplyRequest,
  WorkspacePatchApplySuccessResult,
} from "./types.js";
import { FetchJsonError, fetchJson, mergeSignals } from "./fetchJson.js";
export { fetchModelSettings, saveModelSettings, testModelConnection } from "./modelSettingsClient.js";

export const FOUNDATION_GAP_CHAT_TIMEOUT_MS = 60_000;
export const FOUNDATION_GAP_APPLY_TIMEOUT_MS = 60_000;
export const FOUNDATION_GAP_CHAT_TIMEOUT_MESSAGE = "资料处理超时，未写入任何文件。请重试。";
export const FOUNDATION_GAP_APPLY_TIMEOUT_MESSAGE = "资料写入超时，未确认完成。请先刷新资料后再重试。";

function createTimeoutSignal(input: {
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly message: string;
}): { readonly signal: AbortSignal; readonly cleanup: () => void; readonly didTimeout: () => boolean } {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(input.message));
  }, input.timeoutMs);
  const abortFromUser = () => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) {
    abortFromUser();
  } else {
    input.signal?.addEventListener("abort", abortFromUser, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      globalThis.clearTimeout(timeoutId);
      input.signal?.removeEventListener("abort", abortFromUser);
    },
    didTimeout: () => timedOut,
  };
}

async function withEndpointTimeout<T>(
  request: (signal: AbortSignal) => Promise<T>,
  input: {
    readonly signal?: AbortSignal;
    readonly timeoutMs: number;
    readonly message: string;
  },
): Promise<T> {
  const timeout = createTimeoutSignal(input);
  try {
    return await request(timeout.signal);
  } catch (error) {
    if (timeout.didTimeout()) {
      throw new Error(input.message);
    }
    throw error;
  } finally {
    timeout.cleanup();
  }
}

// ---------------------------------------------------------------------------
// SSE streaming chapter chat
// ---------------------------------------------------------------------------

export async function fetchChapterChatStream(
  input: ChapterChatRequest,
  handlers: {
    readonly onStatus?: (message: string) => void;
    readonly onDelta: (text: string) => void;
    readonly onToolStart?: (id: string, label: string) => void;
    readonly onToolEnd?: (id: string, status: "completed" | "failed") => void;
    readonly onThinkingDelta?: (text: string) => void;
    readonly onDone: (result: ChapterChatResponse) => void;
  },
  signal?: AbortSignal,
): Promise<void> {
  const { signal: mergedSignal, cleanup } = mergeSignals(signal);
  try {
    const response = await fetch("/api/chapter-chat/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: mergedSignal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`流式章节对话请求失败：${response.status}`);
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = "";
    let eventName = "message";
    let dataLines: string[] = [];

    const flush = () => {
      if (dataLines.length === 0) return;
      const raw = dataLines.join("\n");
      dataLines = [];
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        return;
      }
      if (eventName === "status" && isRecord(parsed) && typeof parsed.message === "string") {
        handlers.onStatus?.(parsed.message);
      } else if (eventName === "tool:start" && isRecord(parsed) && typeof parsed.id === "string" && typeof parsed.label === "string") {
        handlers.onToolStart?.(parsed.id, parsed.label);
      } else if (eventName === "tool:end" && isRecord(parsed) && typeof parsed.id === "string") {
        handlers.onToolEnd?.(parsed.id, parsed.status === "failed" ? "failed" : "completed");
      } else if (eventName === "draft:delta" && isRecord(parsed) && typeof parsed.text === "string") {
        handlers.onDelta(parsed.text);
      } else if (eventName === "thinking:delta" && isRecord(parsed) && typeof parsed.text === "string") {
        handlers.onThinkingDelta?.(parsed.text);
      } else if (eventName === "done" && isRecord(parsed)) {
        handlers.onDone({
          reply: typeof parsed.reply === "string" ? parsed.reply : "",
          cards: Array.isArray(parsed.cards) ? parsed.cards as ChapterChatResponse["cards"] : [],
          agentCards: Array.isArray(parsed.agentCards) ? parsed.agentCards as ChapterChatResponse["agentCards"] : [],
          intent: typeof parsed.intent === "string" ? (parsed.intent as ChapterChatResponse["intent"]) : "discuss",
          decision: readChapterChatDecision(parsed.decision),
          chapterGoal: typeof parsed.chapterGoal === "string" ? parsed.chapterGoal : "",
          requiresConfirmation: parsed.requiresConfirmation === true,
          toolOutput: Array.isArray(parsed.toolOutput) ? (parsed.toolOutput as readonly string[]) : [],
          writeInstructions: Array.isArray(parsed.writeInstructions) ? (parsed.writeInstructions as ChapterChatResponse["writeInstructions"]) : [],
          silentFoundationUpdates: Array.isArray(parsed.silentFoundationUpdates) ? (parsed.silentFoundationUpdates as ChapterChatResponse["silentFoundationUpdates"]) : [],
          chapterCompleteSummary: typeof parsed.chapterCompleteSummary === "string" ? parsed.chapterCompleteSummary : "",
        });
      } else if (eventName === "error" && isRecord(parsed) && typeof parsed.error === "string") {
        throw new Error(parsed.error);
      }
      eventName = "message";
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line === "") {
          flush();
        } else if (line.startsWith("event:")) {
          eventName = line.slice("event:".length).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice("data:".length).trim());
        }
      }
    }
    flush();
  } finally {
    cleanup();
  }
}

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

export async function fetchChapterSteering(input: ChapterSteeringRequest, signal?: AbortSignal): Promise<ChapterSteeringDraft> {
  const payload = await fetchJson<ChapterSteeringApiResponse>(
    "/api/chapter-steering",
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
  return payload.draft;
}

export async function fetchChapterChat(input: ChapterChatRequest, signal?: AbortSignal): Promise<ChapterChatResponse> {
  const payload = await fetchJson<ChapterChatApiResponse>(
    "/api/chapter-chat",
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
  return payload.result;
}

export async function fetchChapterWorkspace(input: ChapterWorkspaceRequest, signal?: AbortSignal): Promise<ChapterWorkspaceSnapshot> {
  const params = new URLSearchParams();
  params.set("project", input.projectPath);
  params.set("chapter", String(input.chapter));
  const payload = await fetchJson<ChapterWorkspaceApiResponse>(
    `/api/chapter-workspace?${params.toString()}`,
    {},
    signal,
  );
  if (!payload.ok) {
    throw new Error(payload.error);
  }
  return payload.snapshot;
}

export async function saveChapterWorkspace(input: SaveChapterWorkspaceRequest, signal?: AbortSignal): Promise<ChapterWorkspaceSnapshot> {
  let payload: ChapterWorkspaceApiResponse;
  try {
    payload = await fetchJson<ChapterWorkspaceApiResponse>(
      "/api/chapter-workspace",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
      signal,
    );
  } catch (error) {
    if (error instanceof FetchJsonError && error.status === 409) {
      const conflict = error.payload as ChapterWorkspaceApiResponse;
      if (!conflict.ok && conflict.snapshot) {
        throw new ChapterWorkspaceConflictError(conflict.error, conflict.snapshot);
      }
    }
    throw error;
  }
  if (!payload.ok) {
    throw new Error(payload.error);
  }
  return payload.snapshot;
}

export class ChapterWorkspaceConflictError extends Error {
  readonly snapshot: ChapterWorkspaceSnapshot;

  constructor(message: string, snapshot: ChapterWorkspaceSnapshot) {
    super(message);
    this.name = "ChapterWorkspaceConflictError";
    this.snapshot = snapshot;
  }
}

/** 退出/切换前的「尽力而为」草稿保存（审查 #4）：keepalive fetch，页面卸载后仍能送达服务端。 */
export function saveChapterWorkspaceBeacon(input: SaveChapterWorkspaceRequest): void {
  try {
    void fetch("/api/chapter-workspace", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      keepalive: true,
    });
  } catch {
    // 尽力而为：卸载途中失败无法补救，忽略。
  }
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

export async function fetchFoundationGapReport(projectPath: string, signal?: AbortSignal): Promise<FoundationGapReport> {
  const params = new URLSearchParams({ project: projectPath });
  const payload = await fetchJson<FoundationGapReportApiResponse>(
    `/api/foundation-gaps/report?${params.toString()}`,
    {},
    signal,
  );
  if (!payload.ok) {
    throw new Error(payload.error);
  }
  return payload.report;
}

export async function fetchFoundationGapSuggestions(projectPath: string, signal?: AbortSignal): Promise<{ readonly report: FoundationGapReport; readonly suggestions: readonly FoundationGapSuggestion[] }> {
  const payload = await fetchJson<FoundationGapSuggestionsApiResponse>(
    "/api/foundation-gaps/suggestions",
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
  return { report: payload.report, suggestions: payload.suggestions };
}

export async function previewFoundationGapApply(
  projectPath: string,
  decisions: readonly FoundationGapDecision[],
  currentSuggestions?: readonly FoundationGapSuggestion[],
  signal?: AbortSignal,
): Promise<FoundationGapApplyPlan> {
  const payload = await fetchJson<FoundationGapPreviewApiResponse>(
    "/api/foundation-gaps/preview",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectPath, decisions, currentSuggestions }),
    },
    signal,
  );
  if (!payload.ok) {
    throw new Error(payload.error);
  }
  return payload.plan;
}

export async function applyFoundationGapDecisions(
  projectPath: string,
  decisions: readonly FoundationGapDecision[],
  currentSuggestions?: readonly FoundationGapSuggestion[],
  signal?: AbortSignal,
): Promise<{ readonly plan: FoundationGapApplyPlan; readonly writes: readonly FoundationGapAppliedWrite[]; readonly skippedWrites: readonly FoundationGapSkippedWrite[]; readonly overview: StateOverview; readonly undo?: { readonly undoId: string; readonly changedFiles: readonly string[] } }> {
  const payload = await withEndpointTimeout(
    (requestSignal) => fetchJson<FoundationGapApplyApiResponse>(
      "/api/foundation-gaps/apply",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectPath, decisions, currentSuggestions, confirm: true }),
      },
      requestSignal,
    ),
    {
      signal,
      timeoutMs: FOUNDATION_GAP_APPLY_TIMEOUT_MS,
      message: FOUNDATION_GAP_APPLY_TIMEOUT_MESSAGE,
    },
  );
  if (!payload.ok) {
    throw new Error(payload.error);
  }
  return { plan: payload.result.plan, writes: payload.result.writes ?? [], skippedWrites: payload.result.skippedWrites ?? [], overview: payload.result.overview, undo: payload.result.undo };
}

export async function rollbackFoundationGapApply(
  projectPath: string,
  undoId: string,
  signal?: AbortSignal,
): Promise<{ readonly undoId: string; readonly restoredFiles: readonly string[]; readonly overview: StateOverview }> {
  const payload = await fetchJson<FoundationGapRollbackApiResponse>(
    "/api/foundation-gaps/rollback",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectPath, undoId }),
    },
    signal,
  );
  if (!payload.ok) {
    throw new Error(payload.error);
  }
  return payload.result;
}

export async function confirmFoundationGapCharacterStateWrite(
  input: FoundationGapConfirmCharacterStateWriteRequest,
  signal?: AbortSignal,
): Promise<FoundationGapConfirmCharacterStateWriteResult> {
  const payload = await fetchJson<FoundationGapConfirmCharacterStateWriteApiResponse>(
    "/api/foundation-gaps/confirm-character-write",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
    signal,
  );
  if (!payload.ok) {
    return payload.result;
  }
  return payload.result;
}

export async function previewCharacterMatrixConfirmPreflight(
  input: CharacterMatrixPreviewPreflightRequest,
  signal?: AbortSignal,
): Promise<CharacterMatrixPreviewPreflightPlan> {
  const payload = await fetchJson<CharacterMatrixPreviewPreflightApiResponse>(
    "/api/character-matrix/preview-preflight",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectPath: input.projectPath,
        expectedTargetFile: input.expectedTargetFile,
        candidates: input.candidates,
      }),
    },
    signal,
  );
  if (!payload.ok) {
    throw new Error(payload.error);
  }
  return payload.plan;
}

export async function chatFoundationGapAssistant(
  input: {
    readonly projectPath: string;
    readonly userMessage: string;
    readonly currentReport?: FoundationGapReport | null;
    readonly currentSuggestions?: readonly FoundationGapSuggestion[];
    readonly currentDecisions?: Readonly<Record<string, FoundationGapDecision["decision"]>>;
    readonly currentDraft?: FoundationGapSuggestion | null;
    readonly currentIntent?: string | null;
    readonly selectedCategory?: string | null;
    readonly chatHistory?: readonly FoundationGapChatMessageInput[];
    readonly currentDraftContent?: string | null;
    /** triage 分诊出的归档请求：走决断式直接抽取落盘模式（区别于交互面板的先问体验）。 */
    readonly directArchive?: boolean;
  },
  signal?: AbortSignal,
): Promise<FoundationGapChatResult> {
  const payload = await withEndpointTimeout(
    (requestSignal) => fetchJson<FoundationGapChatApiResponse>(
      "/api/foundation-gaps/chat",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
      requestSignal,
    ),
    {
      signal,
      timeoutMs: FOUNDATION_GAP_CHAT_TIMEOUT_MS,
      message: FOUNDATION_GAP_CHAT_TIMEOUT_MESSAGE,
    },
  );
  if (!payload.ok) {
    throw new Error(payload.error);
  }
  return payload.result;
}

import type { BookSummary } from "../types.js";

export async function fetchListDefaultBooks(signal?: AbortSignal): Promise<BookSummary[]> {
  const payload = await fetchJson<{ ok: boolean; books?: BookSummary[] }>(
    "/api/books/list-default",
    { method: "GET" },
    signal,
  );
  if (!payload.ok) throw new Error("Failed to list default books");
  return payload.books ?? [];
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

export async function updateStorySettings(input: UpdateStorySettingsRequest, signal?: AbortSignal): Promise<StateOverview> {
  const payload = await fetchJson<BookFileActionApiResponse>(
    "/api/books/story-settings",
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
  if (!payload.overview) {
    throw new Error("故事设定保存结果不完整。");
  }
  return payload.overview;
}

export async function updateWritingRules(input: UpdateWritingRulesRequest, signal?: AbortSignal): Promise<StateOverview> {
  const payload = await fetchJson<BookFileActionApiResponse>(
    "/api/books/writing-rules",
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
  if (!payload.overview) {
    throw new Error("写作规则保存结果不完整。");
  }
  return payload.overview;
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

export async function fetchMemoryContextRead(
  input: MemoryContextReadRouteRequest,
  signal?: AbortSignal,
): Promise<MemoryContextReadRouteResult> {
  const body = {
    projectPath: input.projectPath,
    memoryTargetPath: input.memoryTargetPath,
    ...(input.limits ? { limits: input.limits } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {}),
  };

  try {
    return await fetchJson<MemoryContextReadRouteResult>(
      "/api/memory/context/read",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      signal,
    );
  } catch (error) {
    const payload = (error as { readonly payload?: unknown }).payload;
    if (isMemoryContextReadRouteResult(payload)) {
      return payload;
    }
    return failedMemoryContextReadResult(input.requestId, error);
  }
}

export async function generateDraft(input: GenerateDraftRequest, signal?: AbortSignal): Promise<{ readonly report: unknown; readonly draftContent: string; readonly draftTitle?: string; readonly overview: StateOverview; readonly contextBudget?: { readonly droppedSections: readonly string[] }; readonly warnings?: readonly string[] }> {
  const payload = await fetchJson<GenerateDraftApiResponse>(
    "/api/draft/generate",
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
  // warnings（enforce 降级留痕）逐字透传——藏住就是 ok:true 假成功。
  return { report: payload.report, draftContent: payload.draftContent, draftTitle: payload.draftTitle, overview: payload.overview, contextBudget: payload.contextBudget, warnings: payload.warnings };
}

/**
 * 抽卡候选（块③）：生成一版正文【不写盘、不快照、不改状态】，临时返回给前端并排展示，挑中才落盘。
 * 走 /api/draft/generate 的 persist:false 分支；不返回 overview（候选不改任何状态）。
 */
export async function generateDraftCandidate(
  input: GenerateDraftRequest,
  signal?: AbortSignal,
): Promise<{ readonly draftContent: string; readonly draftTitle?: string; readonly contextBudget?: { readonly droppedSections: readonly string[] } }> {
  const payload = await fetchJson<
    | { readonly ok: true; readonly draftContent: string; readonly draftTitle?: string; readonly contextBudget?: { readonly droppedSections: readonly string[] } }
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
  return { draftContent: payload.draftContent, draftTitle: payload.draftTitle, contextBudget: payload.contextBudget };
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

export async function generateDraftStream(
  input: GenerateDraftRequest,
  handlers: {
    readonly onStatus?: (message: string) => void;
    readonly onDelta: (text: string) => void;
    readonly onDone: (result: { readonly draftContent: string; readonly draftTitle?: string; readonly overview: StateOverview }) => void;
  },
  signal?: AbortSignal,
): Promise<void> {
  const { signal: mergedSignal, cleanup } = mergeSignals(signal);
  try {
    const response = await fetch("/api/draft/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: mergedSignal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`流式生成请求失败：${response.status}`);
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = "";
    let eventName = "message";
    let dataLines: string[] = [];

    const flush = () => {
      if (dataLines.length === 0) return;
      const raw = dataLines.join("\n");
      dataLines = [];
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        return;
      }
      if (eventName === "status" && isRecord(parsed) && typeof parsed.message === "string") {
        handlers.onStatus?.(parsed.message);
      } else if (eventName === "delta" && isRecord(parsed) && typeof parsed.text === "string") {
        handlers.onDelta(parsed.text);
      } else if (eventName === "done" && isRecord(parsed) && typeof parsed.draftContent === "string" && isStateOverviewLike(parsed.overview)) {
        handlers.onDone({
          draftContent: parsed.draftContent,
          ...(typeof parsed.draftTitle === "string" ? { draftTitle: parsed.draftTitle } : {}),
          overview: parsed.overview,
        });
      } else if (eventName === "error" && isRecord(parsed) && typeof parsed.error === "string") {
        throw new Error(parsed.error);
      }
      eventName = "message";
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line === "") {
          flush();
        } else if (line.startsWith("event:")) {
          eventName = line.slice("event:".length).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice("data:".length).trim());
        }
      }
    }
    flush();
  } finally {
    cleanup();
  }
}

export async function checkDraftQuality(input: DraftQualityRequest, signal?: AbortSignal): Promise<DraftQualityReport> {
  const payload = await fetchJson<DraftQualityApiResponse>(
    "/api/draft/quality",
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
  return payload.quality;
}

export async function directEditDraft(input: DraftDirectEditRequest, signal?: AbortSignal): Promise<DraftDirectEditResult> {
  const payload = await fetchJson<DraftDirectEditApiResponse>(
    "/api/draft/direct-edit",
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
  return payload.result;
}

export async function reviewDraftWithAI(input: DraftAIReviewRequest, signal?: AbortSignal): Promise<DraftAIReviewReport> {
  const payload = await fetchJson<DraftAIReviewApiResponse>(
    "/api/draft/ai-review",
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
  return payload.review;
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

export async function applyWorkspacePatch(
  input: WorkspacePatchApplyRequest,
  signal?: AbortSignal,
): Promise<WorkspacePatchApplySuccessResult> {
  const payload = await fetchJson<WorkspacePatchApplyApiResponse>(
    "/api/workspace-patch/apply",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
    signal,
  );
  if (!payload.ok) {
    throw createApiPayloadError(payload);
  }
  return payload;
}

export async function previewCommit(
  input: CommitPreviewRequest,
  signal?: AbortSignal,
): Promise<{
  readonly commitPlan: unknown;
  readonly draftQuality: DraftQualityReport;
  readonly semanticQuality?: DraftQualityReport;
  readonly transaction: CommitPreviewTransactionMetadata;
  readonly transactionId: string;
  readonly previewHash: string;
  readonly formalCommitPreview: FormalCommitPreviewRouteResult;
}> {
  const body = {
    projectPath: input.projectPath,
    chapter: input.chapter,
    ...(input.selectiveConfirmation ? { selectiveConfirmation: input.selectiveConfirmation } : {}),
    ...(input.workspaceDraftId ? { workspaceDraftId: input.workspaceDraftId } : {}),
    ...(input.baseHash ? { baseHash: input.baseHash } : {}),
    ...(input.previewHash ? { previewHash: input.previewHash } : {}),
    ...(input.readinessStatus ? { readinessStatus: input.readinessStatus } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {}),
  };
  const payload = await fetchJson<CommitPreviewApiResponse>(
    "/api/commit/preview",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    signal,
  );
  if (!payload.ok) {
    throw new Error(payload.error);
  }
  return {
    commitPlan: payload.commitPlan,
    draftQuality: payload.draftQuality,
    semanticQuality: payload.semanticQuality,
    transaction: payload.transaction,
    transactionId: payload.transactionId,
    previewHash: payload.previewHash,
    formalCommitPreview: payload.formalCommitPreview,
  };
}

export async function applyCommit(
  input: CommitRequest,
  signal?: AbortSignal,
): Promise<CommitApplySuccessResult> {
  const payload = await fetchJson<CommitApplyApiResponse>(
    "/api/commit/apply",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input, confirm: true }),
    },
    signal,
  );
  if (!payload.ok) {
    throw createApiPayloadError(payload);
  }
  return payload;
}

function createApiPayloadError(payload: unknown): Error & { readonly payload?: unknown } {
  return Object.assign(new Error(buildApiPayloadErrorMessage(payload)), { payload });
}

function buildApiPayloadErrorMessage(payload: unknown): string {
  const details = apiPayloadErrorDetails(payload);
  if (details.length === 0) return "API request failed";
  return details.join(" ");
}

function apiPayloadErrorDetails(payload: unknown): readonly string[] {
  if (!isRecord(payload)) return [];
  return uniqueApiPayloadStrings([
    readApiPayloadString(payload.error),
    readApiPayloadString(payload.reason),
    nestedApiPayloadString(payload.transactionPreflight, "code"),
    nestedApiPayloadString(payload.formalPreflight, "code"),
    nestedApiPayloadString(payload.snapshotResult, "reason"),
    nestedApiPayloadString(payload.snapshotResult, "code"),
    readApiPayloadString(payload.finalizeError),
    payload.transactionFinalized === false ? "transactionFinalized:false" : undefined,
  ]);
}

function nestedApiPayloadString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  return readApiPayloadString(value[key]);
}

function readApiPayloadString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function uniqueApiPayloadStrings(values: readonly (string | undefined)[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMemoryContextReadRouteResult(value: unknown): value is MemoryContextReadRouteResult {
  return isRecord(value)
    && typeof value.ok === "boolean"
    && typeof value.status === "string"
    && ["idle", "loading", "ready", "warning", "blocked", "failed"].includes(value.status)
    && ("viewModel" in value)
    && Array.isArray(value.warnings)
    && Array.isArray(value.blockingReasons)
    && typeof value.normalizedPath === "string"
    && value.readOnly === true
    && value.canWrite === false
    && value.canInjectAutomatically === false
    && typeof value.didReadFile === "boolean"
    && value.didWriteMemory === false
    && value.didInjectAutomatically === false
    && isRecord(value.safety);
}

function failedMemoryContextReadResult(requestId: string | undefined, error: unknown): MemoryContextReadRouteResult {
  return {
    ok: false,
    status: "failed",
    viewModel: null,
    warnings: [`memory context route request failed: ${error instanceof Error ? error.message : String(error)}`],
    blockingReasons: [],
    normalizedPath: "",
    readOnly: true,
    canWrite: false,
    canInjectAutomatically: false,
    didReadFile: false,
    didWriteMemory: false,
    didInjectAutomatically: false,
    ...(requestId ? { requestId } : {}),
    safety: {
      noStateJsonWrite: true,
      noMemoryWrite: true,
      noMarkdownWrite: true,
      noFormalCommit: true,
      noPromptInjection: true,
      noConfirmApplyEffect: true,
    },
  };
}

function readChapterChatDecision(value: unknown): ChapterChatResponse["decision"] | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.agentId !== "string"
    || typeof value.action !== "string"
    || typeof value.target !== "string"
    || typeof value.reason !== "string"
    || typeof value.confidence !== "number"
  ) {
    return undefined;
  }
  return {
    agentId: value.agentId,
    action: value.action,
    target: value.target,
    confidence: value.confidence,
    reason: value.reason,
  };
}

function isStateOverviewLike(value: unknown): value is StateOverview {
  return isRecord(value) && isRecord(value.project) && typeof value.project.title === "string";
}
