/**
 * SaveStatusPill — 草稿/会话自动保存状态提示（审查 #3：保存失败不再静默）。
 *
 * 订阅 autosaveControl 快照：保存中显示低调「保存中…」，成功后短暂显示「已保存」再淡出，
 * 失败则常驻红色「保存失败」+ 手动「重试」，并做有限次指数退避自动重试（避免用户以为已保存实则丢失）。
 * 渲染在 .codex-app 中栏（main.desk）底边右下角（UI 审计 T8：不再 fixed 压右栏 composer 发送键），
 * 样式走 codex.css 的 .save-pill 作用域规则。
 */
import { useEffect, useRef, useState } from "react";
import { flushAutosaveNow, subscribeAutosave, type AutosaveSnapshot } from "../../../utils/autosaveControl.js";

const MAX_AUTO_RETRIES = 4;

export function SaveStatusPill({ onRetry }: { readonly onRetry?: () => void }) {
  const retry = onRetry ?? (() => { void flushAutosaveNow(); });
  const [snap, setSnap] = useState<AutosaveSnapshot>({ status: "idle", hasPending: false, lastError: null, lastSavedAt: null });
  const [showSaved, setShowSaved] = useState(false);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => subscribeAutosave(setSnap), []);

  // 成功后短暂显示「已保存」再淡出。
  useEffect(() => {
    if (snap.status !== "saved") return undefined;
    setShowSaved(true);
    const id = setTimeout(() => setShowSaved(false), 1800);
    return () => clearTimeout(id);
  }, [snap.status, snap.lastSavedAt]);

  // 失败自动退避重试；仅 saved/idle 清零（saving 期间保持计数，否则退避永远卡在 2s）。
  useEffect(() => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    if (snap.status === "error") {
      if (retryCountRef.current < MAX_AUTO_RETRIES) {
        const delay = Math.min(30_000, 2_000 * 2 ** retryCountRef.current);
        retryTimerRef.current = setTimeout(() => {
          retryCountRef.current += 1;
          retry();
        }, delay);
      }
    } else if (snap.status === "saved" || snap.status === "idle") {
      retryCountRef.current = 0;
    }
    return () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, [snap.status, snap.lastError, retry]);

  if (snap.status === "error") {
    return (
      <div className="save-pill save-pill-error" role="status" aria-live="polite">
        <span className="save-pill-title">保存失败</span>
        <span className="save-pill-detail">
          {snap.lastError ?? "未知错误"}
        </span>
        <button
          type="button"
          className="save-pill-retry"
          onClick={() => { retryCountRef.current = 0; retry(); }}
        >
          重试
        </button>
      </div>
    );
  }

  if (snap.status === "saving") {
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
