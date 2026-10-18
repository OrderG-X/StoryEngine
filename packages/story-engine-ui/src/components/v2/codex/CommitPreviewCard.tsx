/**
 * CommitPreviewCard — 对话里的定稿预览小卡（R3 起；重构 P6 起清单挪进弹窗「定稿清单」，见 CommitSheet）。
 *
 * 卡上只说结论：能不能定、要你看几条、自动记几条，加一个【打开定稿清单】。定不了时照实列阻断原因和问题明细
 * （引擎确定性判定，不靠模型转述——模型可能把「暂不可定稿」说成小问题或略过）。
 * 与 NameConsistencyCard/StaleThreadCard 同出 commit_preview，三者可同时出现、互不顶掉。
 */
import { useState, type ReactNode } from "react";
import type { CommitPreviewCardData } from "../../../type-defs/workspace.js";
import { StepCard } from "./StepCard.js";
import { splitChecklist } from "./CommitSheet.js";

/**
 * 质量问题计数 + 明细（R7.7·报告 4.3）：明细直接列在卡里、默认折叠——旧版写「明细见质检卡」，
 * 但走定稿预览时界面上根本没有质检卡（quality_check 没跑），作者被指去一张不存在的卡。
 * 没带明细文案的旧数据（只有计数）就只报数字，不指任何卡。
 */
function IssueCountSection({ label, count, items }: {
  readonly label: string;
  readonly count: number;
  readonly items: readonly string[];
}): ReactNode {
  const [expanded, setExpanded] = useState(false);
  if (items.length > 0) {
    return (
      <div className="cpc-issues">
        <button type="button" className="chip" onClick={() => setExpanded((open) => !open)}>
          {expanded ? `${label} ${count} 项（收起）` : `${label} ${count} 项（点开看）`}
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
  return <p className="cpc-count">{label} {count} 项。</p>;
}


export function CommitPreviewCard({
  preview,
  onOpen,
  confirmable = false,
}: {
  readonly preview: CommitPreviewCardData;
  /** 打开定稿清单（弹窗）。 */
  readonly onOpen?: () => void;
  /** 这是最新一张没用掉的可定稿预览（清单里能点【定稿】）。 */
  readonly confirmable?: boolean;
}) {
  const { canCommit, blockingReasons, draftIssueCount, semanticIssueCount } = preview;
  const blocking = blockingReasons?.filter((reason) => typeof reason === "string" && reason.trim()) ?? [];
  // 有阻断项却误标 canCommit:true（残缺/不一致输出）时以阻断项为准，绝不显示「可以定稿」。
  const blocked = !canCommit || blocking.length > 0;
  const chapterLabel = typeof preview.chapter === "number" && preview.chapter > 0 ? `第 ${preview.chapter} 章` : "本章";
  const { day, review, auto } = splitChecklist(preview.ledgerChecklist ?? []);
  const reviewCount = review.length + (day?.needsConfirm ? 1 : 0);
  const autoCount = auto.filter((item) => item.removable).length;

  return (
    <StepCard
      title="定稿预览"
      status={blocked ? "attention" : "done"}
      statusLabel={blocked ? "暂不可定稿" : "可以定稿"}
      defaultOpen
    >
      <p className="cpc-note">
        {blocked
          ? `${chapterLabel}目前不满足定稿条件：`
          : reviewCount > 0
            ? `${chapterLabel}可以定稿：要你看 ${reviewCount} 条，自动记下 ${autoCount} 条。`
            : autoCount > 0
              ? `${chapterLabel}可以定稿：自动记下 ${autoCount} 条。`
              : `${chapterLabel}可以定稿。`}
      </p>
      {!blocked && onOpen ? (
        <div className="cpc-actions">
          <button type="button" className={`chip${confirmable ? " cpc-confirm" : ""}`} onClick={onOpen}>
            {confirmable ? "打开定稿清单" : "看这份清单"}
          </button>
        </div>
      ) : null}
      {blocking.length > 0 ? (
        <ul className="cpc-list">
          {blocking.map((reason) => (
            <li className="cpc-item" key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}
      {typeof draftIssueCount === "number" && draftIssueCount > 0 ? (
        <IssueCountSection label="文稿问题" count={draftIssueCount} items={preview.draftIssues ?? []} />
      ) : null}
      {typeof semanticIssueCount === "number" && semanticIssueCount > 0 ? (
        <IssueCountSection label="语义/连续性问题" count={semanticIssueCount} items={preview.semanticIssues ?? []} />
      ) : null}
    </StepCard>
  );
}
