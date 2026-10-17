/**
 * SaveStatusPill — 稿子 / 对话自动保存状态提示（保存失败不静默）。
 *
 * 重构 P5：直接看稿纸（draftStore）和对话存盘（chatSync）各自的状态。保存中显示低调「保存中…」，
 * 成功后短暂显示「已保存」再淡出；失败常驻红色「保存失败」+「重试」，并做有限次退避自动重试。
 * 稿子撞版本不算失败——那由稿纸上方的提示条让作者选。
 * 渲染在 .codex-app 中栏（main.desk）右下角、写作台底栏之上，样式走 codex.css 的 .save-pill。
 */
import { useEffect, useRef, useState } from "react";
import { useDraftStore } from "../../../stores/draftStore.js";
import { saveChatNow, useChatSaveStore } from "../../../sync/chatSync.js";
import { scheduleDraftSave } from "../../../drafts/draftSync.js";

const MAX_AUTO_RETRIES = 4;

type PillStatus = "idle" | "saving" | "saved" | "error";

function combine(draft: PillStatus, chat: PillStatus): PillStatus {
  if (draft === "error" || chat === "error") return "error";
  if (draft === "saving" || chat === "saving") return "saving";
  if (draft === "saved" || chat === "saved") return "saved";
  return "idle";
}

function retryAll(): void {
  if (useDraftStore.getState().saveStatus === "error") scheduleDraftSave(0);
  if (useChatSaveStore.getState().status === "error") void saveChatNow();
}

export function SaveStatusPill() {
  const draftStatus = useDraftStore((s) => s.saveStatus);
  const draftError = useDraftStore((s) => s.saveError);
  const chatStatus = useChatSaveStore((s) => s.status);
  const chatError = useChatSaveStore((s) => s.error);
  const status = combine(draftStatus, chatStatus);
  const lastError = draftStatus === "error" ? draftError : chatStatus === "error" ? chatError : null;
  const [showSaved, setShowSaved] = useState(false);
  const retryCountRef = useRef(0);

  useEffect(() => {
    if (status !== "saved") return undefined;
    setShowSaved(true);
    const id = setTimeout(() => setShowSaved(false), 1800);
    return () => clearTimeout(id);
  }, [status]);

  useEffect(() => {
    if (status === "saved" || status === "idle") {
      retryCountRef.current = 0;
      return undefined;
    }
    if (status !== "error" || retryCountRef.current >= MAX_AUTO_RETRIES) return undefined;
    const delay = Math.min(30_000, 2_000 * 2 ** retryCountRef.current);
    const id = setTimeout(() => {
      retryCountRef.current += 1;
      retryAll();
    }, delay);
    return () => clearTimeout(id);
  }, [status, lastError]);

  if (status === "error") {
    return (
      <div className="save-pill save-pill-error" role="status" aria-live="polite">
        <span className="save-pill-title">保存失败</span>
        <span className="save-pill-detail">{lastError ?? "未知错误"}</span>
        <button
          type="button"
          className="save-pill-retry"
          onClick={() => { retryCountRef.current = 0; retryAll(); }}
        >
          重试
        </button>
      </div>
    );
  }

  if (status === "saving") {
    return (
      <div className="save-pill save-pill-saving" role="status" aria-live="polite">
        <span className="save-pill-dot" aria-hidden="true" />
        保存中…
      </div>
    );
  }

  if (showSaved) {
    return (
      <div className="save-pill save-pill-saved" role="status" aria-live="polite">
        已保存
      </div>
    );
  }

  return null;
}
