/**
 * CommitDeltaCard — 入库 delta 卡：这章正式入库后改了哪些角色/伏笔/线索/时间线/主线目标。
 * 数据来自 commit_apply 的 CommitReport（message.commitReport），复用 summarizeCommitReport 防御解析成
 * 状态行 + 分项清单。用 StepCard 暗金外壳。把每条 detailLine 按首个「：」切成 标签·值 两列展示。
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
 * - 「正式章节：已写入 chapters/0058.md」→「正文：已写入第 58 章」（文件路径是程序视角）；
 * - 没变化的行（0 项 / 0 条 / 无变更）不显示；过期提醒里为 0 的分项去掉。
 */
export function displayDeltaLines(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith("正式章节：")) {
      const match = /(?:^|\/)(?:chapter-)?0*(\d+)\.md$/u.exec(line.trim());
      out.push(match ? `正文：已写入第 ${match[1]} 章` : "正文：已写入");
      continue;
    }
    if (line.startsWith("过期提醒：")) {
      const parts = line.slice("过期提醒：".length).split("，").filter((part) => !/\s0\s*条$/u.test(part.trim()));
      if (parts.length) out.push(`过期提醒：${parts.join("，")}`);
      continue;
    }
    const value = line.slice(line.indexOf("：") + 1).trim();
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
}: {
  readonly report: unknown;
  readonly elapsedMs?: number;
  /** 撤销这次定稿 = 这回合整块回退（同「撤销到此」）；没有存档点的回合不给。 */
  readonly onUndo?: () => void;
  readonly undoDisabled?: boolean;
}) {
  const { statusLine, detailLines } = summarizeCommitReport(report);
  // 撤销会连带撤掉这之后的对话和改动，先在卡片里确认一次。
  const [confirming, setConfirming] = useState(false);
  return (
    <StepCard title="定稿" status="done" statusLabel="已定稿" elapsedMs={elapsedMs} defaultOpen>
      <p className="cdc-status">{statusLine}</p>
      <ul className="cdc-list">
        {displayDeltaLines(detailLines).map((line) => {
          const { label, value } = splitLabel(line);
          return (
            <li className="cdc-row" key={line}>
              {label ? <span className="cdc-k">{label}</span> : null}
              <span className="cdc-v">{value}</span>
            </li>
          );
        })}
      </ul>
      {onUndo ? (
        confirming ? (
          <div className="cdc-undo-confirm" role="alertdialog" aria-label="确认撤销定稿">
            <span>撤销后这一章回到工作稿，这之后的对话和改动也会一起撤掉。</span>
            <button type="button" className="cdc-undo-go" disabled={undoDisabled} onClick={() => { setConfirming(false); onUndo(); }}>撤销定稿</button>
            <button type="button" className="cdc-undo-cancel" onClick={() => setConfirming(false)}>算了</button>
          </div>
        ) : (
          <button type="button" className="cdc-undo" disabled={undoDisabled} onClick={() => setConfirming(true)}>撤销这次定稿</button>
        )
      ) : null}
    </StepCard>
  );
}
