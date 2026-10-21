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

export interface ChapterPaper {
  readonly chapter: number;
  readonly draft: WorkingDraft | null;
  readonly committed: { readonly title?: string; readonly body: string } | null;
  readonly editedSinceCommit: boolean | null;
}

export interface SaveWorkingDraftRequest {
  readonly projectPath: string;
  readonly chapter: number;
  readonly body: string;
  readonly title?: string;
  readonly baseVersion: string | null;
}

export type SaveWorkingDraftResult =
  | { readonly ok: true; readonly version: string; readonly unchanged: boolean }
  | { readonly ok: false; readonly conflict: true; readonly message: string; readonly current: WorkingDraft | null };

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

/** 存稿。撞版本返回 conflict（不抛）；网络或服务端出错才抛。keepalive 用于关窗前最后一笔。 */
export async function saveWorkingDraft(input: SaveWorkingDraftRequest, options: { readonly keepalive?: boolean } = {}): Promise<SaveWorkingDraftResult> {
  const response = await fetch(BASE, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    ...(options.keepalive ? { keepalive: true } : {}),
  });
  if (response.status === 409) {
    const payload = await response.json() as { error?: string; current?: WorkingDraft | null };
    return { ok: false, conflict: true, message: payload.error ?? "这一章的稿子在别处改过了。", current: payload.current ?? null };
  }
  if (!response.ok) throw new Error(await readError(response));
  const payload = await response.json() as { ok?: boolean; version?: string; unchanged?: boolean; error?: string };
  if (!payload.ok || typeof payload.version !== "string") throw new Error(payload.error ?? "存稿没成功。");
  return { ok: true, version: payload.version, unchanged: payload.unchanged === true };
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
