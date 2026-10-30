/**
 * 定稿清单弹窗开在哪张清单上（重构 P6，草图 ②）。
 *
 * 这一轮交的定稿出了清单（或定不了的原因）就弹出来；对话里只留一张小卡，点它再打开。
 * 清单出了之后稿子没再变（版本号一样、没有没存的字）、那次定稿还在等作者点时，再点「定稿」直接打开那份清单，不再重跑记账员。
 */
import { create } from "zustand";
import type { ChapterMessage } from "../type-defs/workspace.js";
import { confirmableCommitPreviewIds } from "../components/v2/codex/commitConfirm.js";
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

/** 还能直接打开的定稿清单：这一章还能确认的那张，清单出了之后稿纸没变过。否则 null（要重新出清单）。 */
export function reusableCommitPreviewId(messages: readonly ChapterMessage[], paper: PaperVersion): string | null {
  if (isDraftDirty(paper)) return null;
  const confirmable = confirmableCommitPreviewIds(messages);
  const message = messages.find((item) => confirmable.has(item.id) && cardOf(item, "commit-preview")?.preview.chapter === paper.chapter);
  const card = message ? cardOf(message, "commit-preview") : undefined;
  return message && typeof card?.checkedVersion === "string" && card.checkedVersion === paper.baseVersion ? message.id : null;
}
