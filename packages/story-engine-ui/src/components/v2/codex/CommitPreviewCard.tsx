/**
 * CommitPreviewCard — 定稿预览卡（R3）：commit_preview 工具的结构化裁决。
 *
 * 数据来自 message.commitPreview（引擎确定性判定：canCommit + blockingReasons + 质量问题计数）。
 * 关键：裁决结果固定展示，不靠助手转述——模型可能把「暂不可定稿（缺稿/硬伤）」说成「有点小问题」
 * 或干脆略过只说「可以定稿了」。卡里照实列出阻断项，用户自己判断要不要先修再定稿。
 * 与 NameConsistencyCard/StaleThreadCard 同出 commit_preview，三者可同时出现、互不顶掉。
 */
import type { CommitPreviewCardData } from "../../../type-defs/workspace.js";
import { StepCard } from "./StepCard.js";

export function CommitPreviewCard({ preview }: { readonly preview: CommitPreviewCardData }) {
  const { canCommit, blockingReasons, summary, draftIssueCount, semanticIssueCount } = preview;
  const blocking = blockingReasons?.filter((reason) => typeof reason === "string" && reason.trim()) ?? [];
  // 有阻断项却误标 canCommit:true（残缺/不一致输出）时以阻断项为准，绝不显示「可以定稿」。
  const blocked = !canCommit || blocking.length > 0;
  const chapterLabel = typeof preview.chapter === "number" && preview.chapter > 0 ? `第 ${preview.chapter} 章` : "本章";

  return (
    <StepCard
      title="定稿预览"
      status={blocked ? "attention" : "done"}
      statusLabel={blocked ? "暂不可定稿" : "可以定稿"}
      defaultOpen
    >
      <p className="cpc-note">
        {blocked
          ? `${chapterLabel}目前不满足定稿条件（引擎确定性判定，与助手措辞无关）：`
          : `${chapterLabel}已满足定稿条件，可以执行「确认定稿」。`}
      </p>
      {blocking.length > 0 ? (
        <ul className="cpc-list">
          {blocking.map((reason) => (
            <li className="cpc-item" key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}
      {typeof draftIssueCount === "number" && draftIssueCount > 0 ? (
        <p className="cpc-count">文稿问题 {draftIssueCount} 项（明细见质检卡）。</p>
      ) : null}
      {typeof semanticIssueCount === "number" && semanticIssueCount > 0 ? (
        <p className="cpc-count">语义/连续性问题 {semanticIssueCount} 项（明细见质检卡）。</p>
      ) : null}
      {typeof summary === "string" && summary.trim() ? (
        <p className="cpc-summary">{summary}</p>
      ) : null}
    </StepCard>
  );
}
