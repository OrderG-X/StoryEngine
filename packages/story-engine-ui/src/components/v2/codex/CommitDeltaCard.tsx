/**
 * CommitDeltaCard — 定稿回执卡：定了、账记没记上，能撤（安静账房 2026-11-03：不再列这章记了几条账，想看问 AI、翻设定本）。
 * 数据是消息上的定稿回执（服务端 CommitLedgerReport），summarizeCommitReport 防御解析。
 */
import { useEffect, useRef, useState } from "react";
import { StepCard } from "./StepCard.js";
import { summarizeCommitReport } from "../../../utils/commitReportSummary.js";

export function CommitDeltaCard({
  report,
  elapsedMs,
  onUndo,
  undoDisabled,
  onFill,
}: {
  readonly report: unknown;
  readonly elapsedMs?: number;
  /** 撤销这次定稿 = 这回合整块回退（同「撤销到此」）；没有存档点的回合不给。 */
  readonly onUndo?: () => void;
  readonly undoDisabled?: boolean;
  /** 「补记账」：这章的账现在还没记上 / 没记全时由上面给（按章节现状，不按回执当时）。 */
  readonly onFill?: (chapter: number) => void;
}) {
  const { chapter, ledgerStatus, fill } = summarizeCommitReport(report);
  // 撤销会连带撤掉这之后的对话和改动，先在卡片里确认一次。
  const [confirming, setConfirming] = useState(false);
  const confirmRef = useRef<HTMLDivElement>(null);
  // 卡常在对话最底下：确认那行展开后滚进来，别被下一步那条挡住。
  useEffect(() => {
    if (confirming) confirmRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [confirming]);
  const statusLabel = fill ? "已补账" : ledgerStatus === "pending" ? "账待记" : ledgerStatus === "partial" ? "账没记全" : "已定稿";
  return (
    <StepCard title={chapter ? `第 ${chapter} 章` : "定稿"} status="done" statusLabel={statusLabel} elapsedMs={elapsedMs} defaultOpen>
      {onFill && chapter !== undefined ? (
        <button type="button" className="cdc-undo" disabled={undoDisabled} onClick={() => onFill(chapter)}>补记账</button>
      ) : null}
      {onUndo ? (
        confirming ? (
          <div ref={confirmRef} className="cdc-undo-confirm" role="alertdialog" aria-label={fill ? "确认撤销补账" : "确认撤销定稿"}>
            <span>{fill ? "撤销后这章的账回到补之前，这之后的对话和改动也会一起撤掉。" : "撤销后这一章回到工作稿，这之后的对话和改动也会一起撤掉。"}</span>
            <button type="button" className="cdc-undo-go" disabled={undoDisabled} onClick={() => { setConfirming(false); onUndo(); }}>{fill ? "撤销补账" : "撤销定稿"}</button>
            <button type="button" className="cdc-undo-cancel" onClick={() => setConfirming(false)}>算了</button>
          </div>
        ) : (
          <button type="button" className="cdc-undo" disabled={undoDisabled} onClick={() => setConfirming(true)}>{fill ? "撤销这次补账" : "撤销这次定稿"}</button>
        )
      ) : null}
    </StepCard>
  );
}
