/**
 * CommitPreviewCard — 对话里定不了的那张卡（R3 起；安静账房 2026-11-03 起只剩这一种：账不再列清单给作者勾）。
 *
 * 照实列原因和正文硬伤明细（引擎确定性判定，不靠模型转述——模型可能把「暂不可定稿」说成小问题或略过）；
 * 只差字数下限的给「就这么短，照样定稿」。
 */
import { useState, type ReactNode } from "react";
import type { CommitPreviewCardData } from "../../../type-defs/workspace.js";
import { StepCard } from "./StepCard.js";

/** 正文硬伤明细（R7.7·报告 4.3）：直接列在卡里、默认折叠，不指去别的卡。 */
function IssueSection({ label, items }: {
  readonly label: string;
  readonly items: readonly string[];
}): ReactNode {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="cpc-issues">
      <button type="button" className="chip" onClick={() => setExpanded((open) => !open)}>
        {expanded ? `${label} ${items.length} 项（收起）` : `${label} ${items.length} 项（点开看）`}
      </button>
      {expanded ? (
        <ul className="cpc-list">
          {items.map((item) => (
            <li className="cpc-item" key={item}>{item}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function CommitPreviewCard({
  preview,
  onCommitShort,
}: {
  readonly preview: CommitPreviewCardData;
  /** 只差字数下限：作者说这章就这么短（阻断原因里提了这个按钮）。 */
  readonly onCommitShort?: () => void;
}) {
  // 残缺输出里塞的空串不渲染空行。
  const blocking = preview.blockingReasons.filter((reason) => reason.trim().length > 0);
  const chapterLabel = `第 ${preview.chapter} 章`;
  // 阻断项本身就是一条文稿问题（如字数不够）时上面已列过，「文稿问题」里不再重复那一条。
  const draftItems = (preview.draftIssues ?? []).filter((item) => !blocking.includes(item));
  const fill = preview.fill === true;
  return (
    <StepCard
      title={fill ? `补账 · ${chapterLabel}` : `定稿 · ${chapterLabel}`}
      status="attention"
      statusLabel={fill ? "暂补不了" : "暂不可定稿"}
      defaultOpen
    >
      <ul className="cpc-list">
        {blocking.map((reason) => (
          <li className="cpc-item" key={reason}>{reason}</li>
        ))}
      </ul>
      {preview.shortOnly && onCommitShort ? (
        <div className="cpc-actions">
          <button type="button" className="chip cpc-confirm" onClick={onCommitShort}>就这么短，照样定稿</button>
        </div>
      ) : null}
      {draftItems.length > 0 ? <IssueSection label="文稿问题" items={draftItems} /> : null}
    </StepCard>
  );
}
