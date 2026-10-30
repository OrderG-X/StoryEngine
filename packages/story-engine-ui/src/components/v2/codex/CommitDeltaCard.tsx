/**
 * CommitDeltaCard — 入库 delta 卡：这章正式入库后改了哪些角色/伏笔/线索/时间线/主线目标。
 * 数据来自 commit_apply 的 CommitReport（消息上的定稿回执卡），复用 summarizeCommitReport 防御解析成分项。
 * 每项按首个「：」切成 标签·值，排成一行小格子（2026-10-22 减字：不再先一句总数、再逐行重说一遍）。
 */
import { useState } from "react";
import { StepCard } from "./StepCard.js";
import { summarizeCommitReport } from "../../../utils/commitReportSummary.js";

function splitLabel(line: string): { label: string; value: string } {
  const i = line.indexOf("：");
  return i >= 0 ? { label: line.slice(0, i), value: line.slice(i + 1) } : { label: "", value: line };
}

/**
 * 给作者看的定稿明细（只改显示，不改 summarizeCommitReport）：
 * 没变化的行（0 项 / 0 条 / 无变更）不显示；过期提醒里为 0 的分项去掉。
 */
export function displayDeltaLines(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith("过期提醒：")) {
      // 不猜白名单：自家格式
      const parts = line.slice("过期提醒：".length).split("，").filter((part) => !/\s0\s*条$/u.test(part.trim()));
      if (parts.length) out.push(`过期提醒：${parts.join("，")}`);
      continue;
    }
    const value = line.slice(line.indexOf("：") + 1).trim();
    // 不猜白名单：自家格式
    if (/^0\s*(项|条)(，完成 0 项)?$/u.test(value) || value === "无变更") continue;
    out.push(line);
  }
  return out;
}

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
  /** 「补记账」：这章的账没记上 / 没记全时给（交一次补账，出清单）。 */
  readonly onFill?: (chapter: number) => void;
}) {
  const { chapter, detailLines, ledgerStatus, fill } = summarizeCommitReport(report);
  const lines = displayDeltaLines(detailLines);
  // 撤销会连带撤掉这之后的对话和改动，先在卡片里确认一次。
  const [confirming, setConfirming] = useState(false);
  const statusLabel = fill ? "已补账" : ledgerStatus === "pending" ? "账待记" : "已定稿";
  const canFill = Boolean(onFill) && chapter !== undefined && ledgerStatus !== undefined;
  return (
    <StepCard title={chapter ? `第 ${chapter} 章记下的账` : "记下的账"} status="done" statusLabel={statusLabel} elapsedMs={elapsedMs} defaultOpen>
      {lines.length ? (
        <ul className="cdc-list">
          {lines.map((line) => {
            const { label, value } = splitLabel(line);
            return (
              <li className="cdc-row" key={line}>
                {label ? <span className="cdc-k">{label}</span> : null}
                <span className="cdc-v">{value}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {canFill ? (
        <button type="button" className="cdc-undo" disabled={undoDisabled} onClick={() => onFill?.(chapter!)}>补记账</button>
      ) : null}
      {onUndo ? (
        confirming ? (
          <div className="cdc-undo-confirm" role="alertdialog" aria-label={fill ? "确认撤销补账" : "确认撤销定稿"}>
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
