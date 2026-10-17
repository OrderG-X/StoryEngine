/**
 * 换书、换章、换会话、关窗前：把稿纸和对话都存掉（重构 P5，取代 autosaveControl 的 flushAutosaveNow）。
 */
import { flushDraftSave, flushDraftSaveUnlessHeld, saveDraftKeepalive } from "../drafts/draftSync.js";
import { saveChatKeepalive, saveChatNow } from "./chatSync.js";

export type SaveAllResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

export async function flushAllSaves(options: { readonly background?: boolean } = {}): Promise<SaveAllResult> {
  // background = 只是切到后台、页面还活着：AI 回合里稿子先不存，不然 AI 的稿落盘后会把作者刚打的字静默换掉。
  const [draft, chat] = await Promise.all([options.background ? flushDraftSaveUnlessHeld() : flushDraftSave(), saveChatNow()]);
  if (!draft.ok) return { ok: false, error: `稿子没存上：${draft.error}` };
  if (!chat.ok) return { ok: false, error: `对话没存上：${chat.error}` };
  return { ok: true };
}

/** 页面正在关：两笔都用 keepalive 发出去，不等回执。 */
export function saveAllKeepalive(): void {
  saveDraftKeepalive();
  saveChatKeepalive();
}
