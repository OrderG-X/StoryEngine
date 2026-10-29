/**
 * 工作稿读存（重构 P5，见 server/routes/working-draft.ts）。
 * 版本号是盘上草稿文件的哈希；存稿必须带「我是在哪个版本上改的」，对不上服务端回 409 + 盘上那份。
 * 已定稿那一章的章名走 POST /api/chapter-title（作者档、改前存档）。
 */

export interface WorkingDraft {
  readonly chapter: number;
  readonly title?: string;
  readonly body: string;
  readonly version: string;
}

/** 等作者选的一份（写作版本 P1b）：上次没存上的字（恢复稿），或 AI 写好、没换上的（候选）。 */
export type PendingDraft =
  | { readonly kind: "recovery"; readonly id: string; readonly title?: string; readonly body: string; readonly sha: string }
  | { readonly kind: "candidate"; readonly id: string; readonly title?: string; readonly body: string; readonly sha: string; readonly reason: "draft_moved" | "basis_moved" | "apply_failed" | "interrupted" };

export interface ChapterPaper {
  readonly chapter: number;
  readonly draft: WorkingDraft | null;
  /** 工作稿此刻的版本号：没有稿也有（老书没有稿是 null）。存稿拿它当底版。 */
  readonly draftVersion?: string | null;
  readonly committed: { readonly title?: string; readonly body: string } | null;
  readonly editedSinceCommit: boolean | null;
  readonly pending?: PendingDraft;
}

export interface SaveWorkingDraftRequest {
  readonly projectPath: string;
  readonly chapter: number;
  readonly body: string;
  readonly title?: string;
  readonly baseVersion: string | null;
  /** 稿纸窗口号 + 这个窗口第几笔：撞版本时服务端按它存恢复稿（一个窗口一份，迟到的旧笔不覆盖新字）。 */
  readonly client?: string;
  readonly seq?: number;
}

export type SaveWorkingDraftResult =
  | { readonly ok: true; readonly version: string; readonly unchanged: boolean }
  | { readonly ok: false; readonly conflict: true; readonly message: string; readonly current: WorkingDraft | null; readonly currentVersion?: string | null; readonly recoveryId?: string }
  /** 这个窗口序号更大的一笔已经先到了（关窗时补发的那笔），这笔旧的没写。 */
  | { readonly ok: false; readonly superseded: true };

const BASE = "/api/working-draft";

async function readError(response: Response): Promise<string> {
  try {
    const payload = await response.json() as { error?: unknown };
    return typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

export async function fetchChapterPaper(projectPath: string, chapter: number, signal?: AbortSignal): Promise<ChapterPaper> {
  const params = new URLSearchParams({ project: projectPath, chapter: String(chapter) });
  const response = await fetch(`${BASE}?${params.toString()}`, signal ? { signal } : {});
  if (!response.ok) throw new Error(await readError(response));
  const payload = await response.json() as { ok?: boolean; paper?: ChapterPaper; error?: string };
  if (!payload.ok || !payload.paper) throw new Error(payload.error ?? "读不到这一章的稿子。");
  return payload.paper;
}

/** 存稿。撞版本返回 conflict、被本窗口后发的一笔顶掉返回 superseded（都不抛）；网络或服务端出错才抛。keepalive 用于关窗前最后一笔。 */
export async function saveWorkingDraft(input: SaveWorkingDraftRequest, options: { readonly keepalive?: boolean } = {}): Promise<SaveWorkingDraftResult> {
  const response = await fetch(BASE, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    ...(options.keepalive ? { keepalive: true } : {}),
  });
  if (response.status === 409) {
    const payload = await response.json() as { code?: string; error?: string; current?: WorkingDraft | null; currentVersion?: string | null; recoveryId?: string };
    if (payload.code === "stale_save") return { ok: false, superseded: true };
    return {
      ok: false,
      conflict: true,
      message: payload.error ?? "这一章的稿子在别处改过了。",
      current: payload.current ?? null,
      ...(payload.currentVersion !== undefined ? { currentVersion: payload.currentVersion } : {}),
      ...(typeof payload.recoveryId === "string" ? { recoveryId: payload.recoveryId } : {}),
    };
  }
  if (!response.ok) throw new Error(await readError(response));
  const payload = await response.json() as { ok?: boolean; version?: string; unchanged?: boolean; error?: string };
  if (!payload.ok || typeof payload.version !== "string") throw new Error(payload.error ?? "存稿没成功。");
  return { ok: true, version: payload.version, unchanged: payload.unchanged === true };
}

/** warning＝换成了，但之后清掉那一份没成（下次还会提示）。 */
export type PendingDecisionResult = { readonly ok: true; readonly warning?: string } | { readonly ok: false; readonly error: string };

/**
 * 对等着选的那一份做决定：adopt = 换上（带作者眼前那份的版本，对不上不换；换前存档、可撤销），dismiss = 不要了。
 * 没成如实给原因，不抛。
 */
export async function decidePendingDraft(input: {
  readonly projectPath: string;
  readonly chapter: number;
  readonly pending: Pick<PendingDraft, "kind" | "id" | "sha">;
  readonly decision: "adopt" | "dismiss";
  readonly baseVersion: string | null;
  /** 不要本窗口自己的恢复稿时带上（不用 sha，序号挡住还在路上的旧笔）。 */
  readonly from?: { readonly client: string; readonly seq: number };
}): Promise<PendingDecisionResult> {
  try {
    const response = await fetch(`${BASE}/pending`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectPath: input.projectPath,
        chapter: input.chapter,
        kind: input.pending.kind,
        id: input.pending.id,
        sha: input.pending.sha,
        decision: input.decision,
        baseVersion: input.baseVersion,
        ...(input.from ? { client: input.from.client, seq: input.from.seq } : {}),
      }),
    });
    const payload = await response.json().catch(() => ({})) as { ok?: boolean; error?: string; warning?: string };
    if (payload.ok === true) return typeof payload.warning === "string" && payload.warning.trim() ? { ok: true, warning: payload.warning.trim() } : { ok: true };
    return { ok: false, error: payload.error?.trim() || `没成（${response.status}）。` };
  } catch (error) {
    return { ok: false, error: `没成：${error instanceof Error ? error.message : String(error)}` };
  }
}

export type RetitleChapterResult =
  | { readonly ok: true; readonly title: string; readonly unchanged: boolean }
  | { readonly ok: false; readonly error: string };

function newRequestId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `r-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** 改已定稿那一章的章名（正文和账不动，可撤销）。requestId 每次点击一个：网络重发不会改两次。没改成如实给原因，不抛。 */
export async function retitleCommittedChapter(projectPath: string, chapter: number, title: string): Promise<RetitleChapterResult> {
  try {
    const response = await fetch("/api/chapter-title", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectPath, chapter, title, requestId: newRequestId() }),
    });
    const payload = await response.json().catch(() => ({})) as { ok?: boolean; title?: string; unchanged?: boolean; error?: string };
    if (payload.ok === true && typeof payload.title === "string") return { ok: true, title: payload.title, unchanged: payload.unchanged === true };
    return { ok: false, error: payload.error?.trim() || `没改成（${response.status}）。` };
  } catch (error) {
    return { ok: false, error: `没改成：${error instanceof Error ? error.message : String(error)}` };
  }
}
