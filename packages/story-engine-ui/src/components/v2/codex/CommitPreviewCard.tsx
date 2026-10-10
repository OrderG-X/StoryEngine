/**
 * CommitPreviewCard — 定稿预览卡（R3）：commit_preview 工具的结构化裁决。
 *
 * 数据来自 message.commitPreview（引擎确定性判定：canCommit + blockingReasons + 质量问题计数）。
 * 关键：裁决结果固定展示，不靠助手转述——模型可能把「暂不可定稿（缺稿/硬伤）」说成「有点小问题」
 * 或干脆略过只说「可以定稿了」。卡里照实列出阻断项，用户自己判断要不要先修再定稿。
 * 与 NameConsistencyCard/StaleThreadCard 同出 commit_preview，三者可同时出现、互不顶掉。
 *
 * 「确认定稿」按钮（2026-10-07）：可定稿时卡上直接给按钮——点了发结构化动作、服务端直接执行定稿，
 * 不经模型、不靠文本意图词表。只有最新一张未用掉的预览卡带按钮（调用方决定是否传 onConfirm）。
 *
 * 账本清单（2026-10-10「AI 记账、作者核账」）：定稿会往账本里写的东西逐条列出（硬事实、伏笔线索目标、第几天），
 * 默认都勾上；作者把不对的勾掉，点「确认定稿」时一并带上，勾掉的不写。只提示、不写账本的条目没有勾选框。
 */
import { useState } from "react";
import type { CommitPreviewCardData } from "../../../type-defs/workspace.js";
import { StepCard } from "./StepCard.js";

type ChecklistItem = NonNullable<CommitPreviewCardData["ledgerChecklist"]>[number];

/** 清单先露几条，其余收起（一屏读得完）。 */
const LEDGER_VISIBLE = 6;

/**
 * 作者勾掉的条目按「章 + 预览令牌」记在模块里：回合收尾时消息列表会重建、卡片重新挂载，
 * 勾选放在组件状态里会悄悄丢掉（浏览器实测第一次勾就丢了），丢了就会把作者去掉的照写进账本。
 */
const removedByPreview = new Map<string, ReadonlySet<string>>();

function LedgerChecklist({ items, removed, onToggle, disabled }: {
  readonly items: readonly ChecklistItem[];
  readonly removed: ReadonlySet<string>;
  readonly onToggle?: (id: string) => void;
  readonly disabled: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? items : items.slice(0, LEDGER_VISIBLE);
  const writes = items.filter((item) => item.removable).length;
  return (
    <div className="cpc-ledger">
      <p className="cpc-ledger-title">
        这次入账会记下{writes > 0 ? ` ${writes - removed.size} 条` : ""}{onToggle && writes > 0 ? "（不对的勾掉，勾掉的不写）" : ""}
      </p>
      <ul className="cpc-ledger-list">
        {shown.map((item) => (
          <li key={item.id} className={`cpc-ledger-item${removed.has(item.id) ? " is-removed" : ""}${item.removable ? "" : " is-note"}`}>
            {item.removable && onToggle ? (
              <label>
                <input type="checkbox" checked={!removed.has(item.id)} disabled={disabled} onChange={() => onToggle(item.id)} />
                <span className="cpc-ledger-label">{item.label}</span>
              </label>
            ) : (
              <span className="cpc-ledger-label">{item.label}</span>
            )}
            {item.detail ? <span className="cpc-ledger-detail serif">「{item.detail}」</span> : null}
          </li>
        ))}
      </ul>
      {items.length > LEDGER_VISIBLE ? (
        <button type="button" className="chip" onClick={() => setExpanded((open) => !open)}>
          {expanded ? "收起" : `还有 ${items.length - LEDGER_VISIBLE} 条（点开看）`}
        </button>
      ) : null}
    </div>
  );
}

export function CommitPreviewCard({
  preview,
  onConfirm,
  confirmDisabled = false,
  onDecline,
}: {
  readonly preview: CommitPreviewCardData;
  /** 传了且可定稿 → 渲染「确认定稿」按钮；参数是作者在账本清单上勾掉的条目 id。 */
  readonly onConfirm?: (excluded: readonly string[]) => void;
  readonly confirmDisabled?: boolean;
  /** 「先不定」：把「先不定稿，」填进输入框让作者接着说原因（不发送、不写盘）。 */
  readonly onDecline?: () => void;
}) {
  const { canCommit, blockingReasons, summary, draftIssueCount, semanticIssueCount } = preview;
  const blocking = blockingReasons?.filter((reason) => typeof reason === "string" && reason.trim()) ?? [];
  // 有阻断项却误标 canCommit:true（残缺/不一致输出）时以阻断项为准，绝不显示「可以定稿」。
  const blocked = !canCommit || blocking.length > 0;
  const chapterLabel = typeof preview.chapter === "number" && preview.chapter > 0 ? `第 ${preview.chapter} 章` : "本章";
  const ledger = preview.ledgerChecklist ?? [];
  const previewKey = `${preview.chapter}#${preview.previewToken ?? ""}`;
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => removedByPreview.get(previewKey) ?? new Set());
  const toggle = (id: string) => setRemoved((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    removedByPreview.set(previewKey, next);
    return next;
  });
  const canTick = !blocked && Boolean(onConfirm);

  return (
    <StepCard
      title="定稿预览"
      status={blocked ? "attention" : "done"}
      statusLabel={blocked ? "暂不可定稿" : "可以定稿"}
      defaultOpen
      keepOpen={Boolean(onConfirm)}
    >
      <p className="cpc-note">
        {blocked
          ? `${chapterLabel}目前不满足定稿条件（引擎确定性判定，与助手措辞无关）：`
          : `${chapterLabel}已满足定稿条件，点「确认定稿」即写入（写入前自动存档，可撤销）。`}
      </p>
      {ledger.length > 0 ? (
        <LedgerChecklist items={ledger} removed={removed} {...(canTick ? { onToggle: toggle } : {})} disabled={confirmDisabled} />
      ) : null}
      {!blocked && onConfirm ? (
        <div className="cpc-actions">
          <button type="button" className="chip cpc-confirm" disabled={confirmDisabled} onClick={() => onConfirm([...removed])}>
            {removed.size > 0 ? `确认定稿（去掉 ${removed.size} 条）` : "确认定稿"}
          </button>
          {onDecline ? (
            <button type="button" className="cpc-decline" disabled={confirmDisabled} onClick={onDecline}>
              先不定
            </button>
          ) : null}
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
