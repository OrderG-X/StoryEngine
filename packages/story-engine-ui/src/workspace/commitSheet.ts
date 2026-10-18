/**
 * 定稿清单弹窗开在哪张预览上（重构 P6，草图 ②）。
 *
 * 定稿预览结果一到就弹出清单；对话里只留一张小卡，点它再打开。
 * 预览之后稿子没再变（版本号一样、没有没存的字）时，再点「定稿」直接打开上次那份清单，不再重跑记账员。
 */
import { create } from "zustand";
import type { ChapterMessage } from "../type-defs/workspace.js";
import { confirmableCommitPreviewMessageId } from "../components/v2/codex/commitConfirm.js";
import { isDraftDirty, type DraftStoreState } from "../stores/draftStore.js";
import { cardOf } from "../utils/messageCards.js";

export const useCommitSheet = create<{
  /** 打开的是哪条消息上的预览；null＝关着。 */
  readonly messageId: string | null;
  readonly open: (messageId: string) => void;
  readonly close: () => void;
}>((set) => ({
  messageId: null,
  open: (messageId) => set({ messageId }),
  close: () => set({ messageId: null }),
}));

export function openCommitSheet(messageId: string): void {
  useCommitSheet.getState().open(messageId);
}

export function closeCommitSheet(): void {
  useCommitSheet.getState().close();
}

type PaperVersion = Pick<DraftStoreState, "chapter" | "baseVersion" | "body" | "savedBody" | "title" | "savedTitle">;

/** 还能直接打开的定稿清单：这一章最新那张可定稿的预览，预览后稿纸没变过。否则 null（要重新预览）。 */
export function reusableCommitPreviewId(messages: readonly ChapterMessage[], paper: PaperVersion): string | null {
  const id = confirmableCommitPreviewMessageId(messages);
  if (!id) return null;
  const message = messages.find((item) => item.id === id);
  const card = message ? cardOf(message, "commit-preview") : undefined;
  if (!card || card.preview.chapter !== paper.chapter) return null;
  if (typeof card.checkedVersion !== "string" || card.checkedVersion !== paper.baseVersion || isDraftDirty(paper)) return null;
  return id;
}
