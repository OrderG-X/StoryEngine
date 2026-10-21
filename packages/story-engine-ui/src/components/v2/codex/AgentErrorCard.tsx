/**
 * AgentErrorCard — 聊天错误专用卡（P0-1）。
 * 正文只写人话；「重试这一步」走既有 retry-agent；原始报错藏在默认收起的技术详情。
 * P11：按服务端分的类说原因（没接上 AI / 密钥不对 / 欠费 / 断网…），该去设置的给「去设置」。
 */
import { useState } from "react";
import type { SuggestedAction } from "../../../type-defs/workflow.js";
import type { AiErrorReason } from "../../../server/lib/ai-errors.js";
import { aiErrorBody, aiErrorWantsSettings } from "../../../lib/ai-error-text.js";

export function agentErrorFriendlyBody(reason?: AiErrorReason): string {
  return aiErrorBody(reason);
}

export default function AgentErrorCard(props: {
  readonly detail?: string;
  readonly reason?: AiErrorReason;
  readonly retryAction?: SuggestedAction | null;
  readonly chatLoading?: boolean;
  readonly onRetry?: (action: SuggestedAction) => void;
  readonly onOpenSettings?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const detail = `${props.detail ?? ""}`.trim();
  const retry = props.retryAction ?? null;
  const busy = Boolean(props.chatLoading);
  const wantsSettings = aiErrorWantsSettings(props.reason) && Boolean(props.onOpenSettings);

  return (
    <div className="agent-error-card" role="alert">
      <p className="aec-body">{aiErrorBody(props.reason)}</p>
      <div className="aec-actions">
        {wantsSettings ? (
          <button type="button" className="aec-retry" onClick={() => props.onOpenSettings?.()}>
            去设置
          </button>
        ) : null}
        {retry ? (
          <button
            type="button"
            className={wantsSettings ? "aec-detail-toggle" : "aec-retry"}
            disabled={busy || !props.onRetry}
            onClick={() => {
              if (!busy && props.onRetry) props.onRetry(retry);
            }}
          >
            重试这一步
          </button>
        ) : null}
        {detail ? (
          <button
            type="button"
            className="aec-detail-toggle"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "收起技术详情" : "技术详情"}
          </button>
        ) : null}
      </div>
      {open && detail ? <pre className="aec-detail">{detail}</pre> : null}
    </div>
  );
}
