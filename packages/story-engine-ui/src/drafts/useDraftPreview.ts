/**
 * 稿纸显示用的 DraftPreview（重构 P5）：从 draftStore 现算，不另存一份。
 * AI 正在流式出稿时显示流出来的字、稿纸只读；老书盘上残留的占位引导稿不显示。
 */
import { useMemo } from "react";
import { paperStage, useDraftStore, type DraftStoreState } from "../stores/draftStore.js";
import type { DraftPreview } from "../types.js";
import { isRealDraftContent } from "../utils/draftContent.js";
import { countTextWords } from "../utils/textUtils.js";

type PreviewSource = Pick<DraftStoreState, "chapter" | "title" | "body" | "committed" | "streaming">;

export function draftPreviewOf(state: PreviewSource, fallback: { readonly chapterNumber: number; readonly title: string }): DraftPreview {
  const streaming = state.streaming !== null;
  const body = streaming ? state.streaming ?? "" : isRealDraftContent(state.body) || !state.body.trim() ? state.body : "";
  const chapterNumber = state.chapter > 0 ? state.chapter : fallback.chapterNumber;
  return {
    chapterNumber,
    title: state.title.trim() || fallback.title,
    status: !streaming && paperStage(state) === "committed" ? "committed" : "draft",
    content: body,
    wordCount: body.trim() ? countTextWords(body) : 0,
    ...(streaming ? { streaming: true } : {}),
  };
}

export function useDraftPreview(fallback: { readonly chapterNumber: number; readonly title: string }): DraftPreview {
  const chapter = useDraftStore((s) => s.chapter);
  const title = useDraftStore((s) => s.title);
  const body = useDraftStore((s) => s.body);
  const committed = useDraftStore((s) => s.committed);
  const streaming = useDraftStore((s) => s.streaming);
  return useMemo(
    () => draftPreviewOf({ chapter, title, body, committed, streaming }, fallback),
    [chapter, title, body, committed, streaming, fallback.chapterNumber, fallback.title],
  );
}

/** 当前稿纸的字（非 React 代码用：按钮动作、对话回合）。 */
export function currentPaperText(): string {
  const state = useDraftStore.getState();
  return state.streaming ?? state.body;
}

/** 当前这一章是不是已定稿、且定稿后没改过（只读）。 */
export function isPaperCommitted(): boolean {
  const state = useDraftStore.getState();
  return state.streaming === null && paperStage(state) === "committed";
}
