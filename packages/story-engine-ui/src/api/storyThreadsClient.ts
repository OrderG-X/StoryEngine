/**
 * 伏笔看板的数据（GET /api/story-threads，重构 P6）。读不到就如实给原因，不装作「没有线索」。
 */

export interface ThreadBoardTouch {
  readonly chapter: number;
  readonly op: "open" | "advance" | "close";
  readonly note: string;
  readonly quote?: string;
}

export interface ThreadBoardItem {
  readonly id: string;
  readonly title: string;
  readonly type: "question" | "intent" | "goal";
  readonly status: "open" | "active" | "stale" | "closed";
  readonly weight: "major" | "normal" | "minor";
  readonly openedAt: number;
  readonly lastTouchedAt: number;
  readonly closedAt?: number;
  readonly closedBy?: "ledger" | "author";
  readonly idle: number;
  readonly touches: readonly ThreadBoardTouch[];
}

export interface ThreadBoard {
  readonly upTo: number;
  readonly threads: readonly ThreadBoardItem[];
}

export type ThreadBoardResult = { readonly ok: true; readonly board: ThreadBoard } | { readonly ok: false; readonly error: string };

export async function fetchThreadBoard(projectPath: string, signal?: AbortSignal): Promise<ThreadBoardResult> {
  try {
    const res = await fetch(`/api/story-threads?project=${encodeURIComponent(projectPath)}`, signal ? { signal } : {});
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; board?: ThreadBoard; error?: string };
    if (body.ok === true && body.board && Array.isArray(body.board.threads)) return { ok: true, board: body.board };
    return { ok: false, error: body.error?.trim() || `读线索没成（${res.status}）。` };
  } catch (error) {
    if (signal?.aborted) return { ok: false, error: "已取消。" };
    return { ok: false, error: `读线索没成：${error instanceof Error ? error.message : String(error)}` };
  }
}
