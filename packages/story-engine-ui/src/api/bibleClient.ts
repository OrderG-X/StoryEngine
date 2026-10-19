/**
 * 设定本（重构 P9）：GET /api/bible 读设定视图（设定卡 + 账里记的），POST /api/cards 作者改设定卡。
 * 读不到、改不成都如实给原因，不吞。
 */
import type { BibleView, CardOp } from "@actalk/story-core";

export type { BibleAppearances, BibleEntry, Card, BibleFact, BibleRelationView, BibleView, CardAuthor, CardField, CardKind, CardOp, UncardedEntry, WritingRules } from "@actalk/story-core";

export type BibleResult = { readonly ok: true; readonly bible: BibleView } | { readonly ok: false; readonly error: string };

export async function fetchBible(projectPath: string, signal?: AbortSignal): Promise<BibleResult> {
  try {
    const res = await fetch(`/api/bible?${new URLSearchParams({ project: projectPath }).toString()}`, signal ? { signal } : {});
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; bible?: BibleView; error?: string };
    if (body.ok === true && body.bible && Array.isArray(body.bible.characters)) return { ok: true, bible: body.bible };
    return { ok: false, error: body.error?.trim() || `设定本没读出来（${res.status}）。` };
  } catch (error) {
    if (signal?.aborted) return { ok: false, error: "已取消。" };
    return { ok: false, error: `设定本没读出来：${error instanceof Error ? error.message : String(error)}` };
  }
}

export type SaveCardsResult =
  | { readonly ok: true; readonly lines: readonly string[]; readonly snapshotId?: string }
  | { readonly ok: false; readonly error: string };

function newRequestId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `r-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** 作者改设定（一批 ops 一步，可撤销）。requestId 每次点击一个：网络重发不会改两次。 */
export async function saveCards(projectPath: string, ops: readonly CardOp[]): Promise<SaveCardsResult> {
  try {
    const res = await fetch("/api/cards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectPath, ops, requestId: newRequestId() }),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; lines?: string[]; snapshotId?: string; error?: string };
    if (body.ok === true) return { ok: true, lines: body.lines ?? [], ...(body.snapshotId ? { snapshotId: body.snapshotId } : {}) };
    return { ok: false, error: body.error?.trim() || `没改成（${res.status}）。` };
  } catch (error) {
    return { ok: false, error: `没改成：${error instanceof Error ? error.message : String(error)}` };
  }
}
