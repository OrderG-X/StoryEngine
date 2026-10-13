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
 * 要确认的改记（R7.4）反过来：默认不勾（这条改记不作数、旧设定不动），作者勾上（change_confirm 前缀随确认带上）才写。
 */
import { useState, type ReactNode } from "react";
import type { CommitPreviewCardData } from "../../../type-defs/workspace.js";
import { StepCard } from "./StepCard.js";
import { ledgerDayOverrideForCard, ledgerExclusionsForCard, rememberLedgerDayOverride, rememberLedgerExclusions } from "../../../utils/ledgerExclusions.js";

type ChecklistItem = NonNullable<CommitPreviewCardData["ledgerChecklist"]>[number];

/** 清单先露几条，其余收起（一屏读得完）。 */
const LEDGER_VISIBLE = 6;

/** 这条最终写不写：默认勾的条目不勾才去掉；要确认的改记（defaultUnchecked，R7.4）反过来——勾上才算确认。 */
const isItemChecked = (item: ChecklistItem, toggled: ReadonlySet<string>): boolean =>
  item.defaultUnchecked ? toggled.has(item.id) : !toggled.has(item.id);

/** 作者实际去掉（不写）的常规条目数：要确认的改记没勾不算「去掉」——那是没确认，不是拒收。 */
function countRemoved(items: readonly ChecklistItem[], toggled: ReadonlySet<string>): number {
  return items.filter((item) => item.removable && !item.defaultUnchecked && toggled.has(item.id)).length;
}

/** 作者勾上（确认）的待确认改记数。 */
function countConfirmed(items: readonly ChecklistItem[], toggled: ReadonlySet<string>): number {
  return items.filter((item) => item.removable && item.defaultUnchecked && toggled.has(item.id)).length;
}

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


function LedgerChecklist({ items, removed, onToggle, disabled, dayOverride, onDayChange }: {
  readonly items: readonly ChecklistItem[];
  readonly removed: ReadonlySet<string>;
  readonly onToggle?: (id: string) => void;
  readonly disabled: boolean;
  readonly dayOverride?: number;
  readonly onDayChange?: (day: number | undefined) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? items : items.slice(0, LEDGER_VISIBLE);
  const removables = items.filter((item) => item.removable);
  const activeCount = removables.filter((item) => isItemChecked(item, removed)).length;
  const confirmTotal = removables.filter((item) => item.defaultUnchecked).length;
  return (
    <div className="cpc-ledger">
      <p className="cpc-ledger-title">
        这次入账会记下{removables.length > 0 ? ` ${activeCount} 条` : ""}{onToggle && removables.length > 0 ? "（不对的勾掉，勾掉的不写）" : ""}
        {confirmTotal > 0 ? `；有 ${confirmTotal} 条要你确认，默认不改` : ""}
      </p>
      <ul className="cpc-ledger-list">
        {shown.map((item) => (
          <li key={item.id} className={`cpc-ledger-item${isItemChecked(item, removed) ? "" : " is-removed"}${item.removable ? "" : " is-note"}${item.needsConfirm ? " is-confirm" : ""}`}>
            {item.editableDay !== undefined && onDayChange ? (
              <span className="cpc-ledger-day">
                <span className="cpc-ledger-label">{item.label}</span>
                <label className="cpc-ledger-day-edit">
                  改成第
                  <input
                    type="number"
                    min={1}
                    aria-label="这一章是故事第几天"
                    value={dayOverride ?? item.editableDay}
                    disabled={disabled}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      onDayChange(Number.isInteger(next) && next >= 1 && next !== item.editableDay ? next : undefined);
                    }}
                  />
                  天
                </label>
              </span>
            ) : item.removable && onToggle ? (
              <label>
                <input type="checkbox" checked={isItemChecked(item, removed)} disabled={disabled} onChange={() => onToggle(item.id)} />
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
  /** 传了且可定稿 → 渲染「确认定稿」按钮；参数是作者在账本清单上勾掉的条目 id、改过的「第几天」。 */
  readonly onConfirm?: (excluded: readonly string[], dayOverride?: number) => void;
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
  // 勾选记在共享处（utils/ledgerExclusions）：卡片重挂载不丢，建议条上的「确认定稿」也带得上。
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => ledgerExclusionsForCard(preview.chapter, preview.previewToken));
  const toggle = (id: string) => setRemoved((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    rememberLedgerExclusions(preview.chapter, preview.previewToken, next);
    return next;
  });
  const canTick = !blocked && Boolean(onConfirm);
  const [dayOverride, setDayOverride] = useState<number | undefined>(() => ledgerDayOverrideForCard(preview.chapter, preview.previewToken));
  const changeDay = (day: number | undefined) => {
    setDayOverride(day);
    rememberLedgerDayOverride(preview.chapter, preview.previewToken, day);
  };

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
        <LedgerChecklist
          items={ledger}
          removed={removed}
          {...(canTick ? { onToggle: toggle, onDayChange: changeDay } : {})}
          {...(dayOverride !== undefined ? { dayOverride } : {})}
          disabled={confirmDisabled}
        />
      ) : null}
      {!blocked && onConfirm ? (
        <div className="cpc-actions">
          <button type="button" className="chip cpc-confirm" disabled={confirmDisabled} onClick={() => onConfirm([...removed], dayOverride)}>
            {countRemoved(ledger, removed) > 0
              ? `确认定稿（去掉 ${countRemoved(ledger, removed)} 条）`
              : countConfirmed(ledger, removed) > 0
                ? `确认定稿（含要确认的改记 ${countConfirmed(ledger, removed)} 条）`
                : "确认定稿"}
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
        <IssueCountSection label="文稿问题" count={draftIssueCount} items={preview.draftIssues ?? []} />
      ) : null}
      {typeof semanticIssueCount === "number" && semanticIssueCount > 0 ? (
        <IssueCountSection label="语义/连续性问题" count={semanticIssueCount} items={preview.semanticIssues ?? []} />
      ) : null}
      {typeof summary === "string" && summary.trim() ? (
        <p className="cpc-summary">{summary}</p>
      ) : null}
    </StepCard>
  );
}
