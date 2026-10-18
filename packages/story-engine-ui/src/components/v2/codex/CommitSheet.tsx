/**
 * 定稿清单（重构 P6，草图 ②）：定稿预览从对话卡改成弹窗。
 *
 *  - 头：定稿第 N 章；这一章记为故事第几天 + 依据原句 +【改天数】；记账员的提醒（没读完前文等）照实列。
 *  - 要你看的（≤8 条先露，其余点开）：每条一句 + 原句 +【记下】【不记】；要确认的改记是【改记】【不改】、默认不改。
 *  - 另外自动记下 N 条：收起；点开每条也能【不记】。
 *  - 定不了时：照实列阻断原因，只有【知道了】。
 *  - 底：【先不定】【定稿】。定稿＝现有「确认定稿」结构化动作（带上作者去掉的、确认的、改的天数），不经模型。
 *
 * 作者动过的条目记在 utils/ledgerExclusions（按章 + 预览令牌），关了再开、从别处点「确认定稿」都带得上。
 */
import { useEffect, useRef, useState } from "react";
import type { CommitPreviewCardData } from "../../../type-defs/workspace.js";
import {
  ledgerDayOverrideForCard,
  ledgerExclusionsForCard,
  rememberLedgerDayOverride,
  rememberLedgerExclusions,
} from "../../../utils/ledgerExclusions.js";
import { IconClose } from "./icons.js";
import { confirmableCommitPreviewMessageId } from "./commitConfirm.js";
import { closeCommitSheet, useCommitSheet } from "../../../workspace/commitSheet.js";
import { useChatStore } from "../../../stores/chatStore.js";
import { cardOf } from "../../../utils/messageCards.js";
import { commitConfirmAction } from "../../../utils/workflowHelpers.js";
import type { SuggestedAction } from "../../../types.js";

type ChecklistItem = NonNullable<CommitPreviewCardData["ledgerChecklist"]>[number];

/** 「要你看的」先露几条（一屏读得完），其余点开。 */
const REVIEW_VISIBLE = 8;

/** 这条最终写不写：默认记的条目在集合里＝不记；要确认的改记（defaultUnchecked）反过来，在集合里＝确认改记。 */
export const isItemKept = (item: ChecklistItem, toggled: ReadonlySet<string>): boolean =>
  item.defaultUnchecked ? toggled.has(item.id) : !toggled.has(item.id);

/** 清单分三份：天数、要你看的、自动记下的（只提示、不能去掉的也算在自动那份里，照列）。 */
export function splitChecklist(items: readonly ChecklistItem[]): {
  readonly day: ChecklistItem | undefined;
  readonly review: readonly ChecklistItem[];
  readonly auto: readonly ChecklistItem[];
} {
  const day = items.find((item) => item.editableDay !== undefined);
  const rest = items.filter((item) => item !== day);
  return {
    day,
    review: rest.filter((item) => item.needsConfirm),
    auto: rest.filter((item) => !item.needsConfirm),
  };
}

/**
 * 「要你看的」按原因归组：同一原因（第一次出场、收掉线索……）只在组头说一遍，组按头一次出现的先后排。
 * 没带原因的（旧预览，原因还嵌在 label 里）各自成行、没有组头。
 */
export function groupByReason(items: readonly ChecklistItem[]): readonly { readonly reason?: string; readonly items: readonly ChecklistItem[] }[] {
  const groups: { reason?: string; items: ChecklistItem[] }[] = [];
  for (const item of items) {
    const reason = item.reason?.trim();
    const group = reason ? groups.find((candidate) => candidate.reason === reason) : undefined;
    if (group) group.items.push(item);
    else groups.push({ ...(reason ? { reason } : {}), items: [item] });
  }
  return groups;
}

/** 先露前 limit 条（按归组后的顺序数），超出的点开再看。 */
function takeRows(groups: ReturnType<typeof groupByReason>, limit: number): ReturnType<typeof groupByReason> {
  let left = limit;
  return groups.flatMap((group) => {
    if (left <= 0) return [];
    const items = group.items.slice(0, left);
    left -= items.length;
    return [{ ...group, items }];
  });
}

function ReviewRow({ item, kept, disabled, onSet }: {
  readonly item: ChecklistItem;
  readonly kept: boolean;
  readonly disabled: boolean;
  readonly onSet?: (keep: boolean) => void;
}) {
  const [yes, no] = item.defaultUnchecked ? ["改记", "不改"] : ["记下", "不记"];
  return (
    <li className={`se-cs-row${kept ? "" : " is-off"}`}>
      <div className="se-cs-row-text">
        <div className="se-cs-row-label">{item.label}</div>
        {item.detail ? <div className="se-cs-quote serif">「{item.detail}」</div> : null}
      </div>
      {item.removable && onSet ? (
        <div className="se-cs-choice" role="group" aria-label={item.label}>
          <button type="button" aria-pressed={kept} className={kept ? "on" : ""} disabled={disabled} onClick={() => onSet(true)}>{yes}</button>
          <button type="button" aria-pressed={!kept} className={kept ? "" : "on"} disabled={disabled} onClick={() => onSet(false)}>{no}</button>
        </div>
      ) : null}
    </li>
  );
}

export function CommitSheet({
  preview,
  busy,
  onConfirm,
  onClose,
}: {
  readonly preview: CommitPreviewCardData;
  /** 有动作在跑：按钮先不让点。 */
  readonly busy: boolean;
  /** 传了且能定稿 → 底部有【定稿】；参数是作者去掉 / 确认的条目 id、改过的天数。没传＝只看（旧预览）。 */
  readonly onConfirm?: (excluded: readonly string[], dayOverride?: number) => void;
  readonly onClose: () => void;
}) {
  const ledger = preview.ledgerChecklist ?? [];
  const { day, review, auto } = splitChecklist(ledger);
  const blocking = preview.blockingReasons?.filter((reason) => reason.trim()) ?? [];
  const blocked = !preview.canCommit || blocking.length > 0;
  const editable = !blocked && Boolean(onConfirm);

  const [toggled, setToggled] = useState<ReadonlySet<string>>(() => ledgerExclusionsForCard(preview.chapter, preview.previewToken));
  const setKept = (item: ChecklistItem, keep: boolean) => setToggled((current) => {
    const next = new Set(current);
    // 默认记的：不记＝进集合；要确认的改记：改记＝进集合。
    const inSet = item.defaultUnchecked ? keep : !keep;
    if (inSet) next.add(item.id);
    else next.delete(item.id);
    rememberLedgerExclusions(preview.chapter, preview.previewToken, next);
    return next;
  });
  const [dayOverride, setDayOverride] = useState<number | undefined>(() => ledgerDayOverrideForCard(preview.chapter, preview.previewToken));
  const [editingDay, setEditingDay] = useState(false);
  const changeDay = (value: number | undefined) => {
    setDayOverride(value);
    rememberLedgerDayOverride(preview.chapter, preview.previewToken, value);
  };
  const [showAllReview, setShowAllReview] = useState(false);
  const [showAuto, setShowAuto] = useState(false);

  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const removed = ledger.filter((item) => item.removable && !item.defaultUnchecked && toggled.has(item.id)).length;
  const confirmed = ledger.filter((item) => item.removable && item.defaultUnchecked && toggled.has(item.id)).length;
  const autoKept = auto.filter((item) => item.removable && isItemKept(item, toggled)).length;
  const reviewGroups = groupByReason(review);
  const reviewShown = showAllReview ? reviewGroups : takeRows(reviewGroups, REVIEW_VISIBLE);
  const reviewCount = review.length + (day?.needsConfirm ? 1 : 0);
  const title = `定稿第 ${preview.chapter} 章`;
  const confirmLabel = removed > 0 ? `定稿（不记 ${removed} 条）` : confirmed > 0 ? `定稿（改记 ${confirmed} 条）` : "定稿";

  return (
    <>
      <div className="se-scrim" aria-hidden="true" onClick={onClose} />
      <div ref={dialogRef} className="se-cs" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <header className="se-cs-head">
          <h2>{title}</h2>
          <button type="button" className="se-icon-btn" aria-label="关闭定稿清单" onClick={onClose}><IconClose /></button>
        </header>

        <div className="se-cs-body">
          {day ? (
            <div className={`se-cs-day${day.needsConfirm ? " is-attention" : ""}`}>
              <span>{dayOverride !== undefined ? `这一章改记为故事第 ${dayOverride} 天` : day.label}</span>
              {day.detail ? <span className="se-cs-quote serif">依据「{day.detail}」</span> : null}
              {editable && day.editableDay !== undefined ? (
                editingDay ? (
                  <label className="se-cs-day-edit">
                    第
                    <input
                      type="number"
                      min={1}
                      autoFocus
                      aria-label="这一章是故事第几天"
                      value={dayOverride ?? day.editableDay}
                      disabled={busy}
                      onChange={(event) => {
                        const next = Number(event.target.value);
                        changeDay(Number.isInteger(next) && next >= 1 && next !== day.editableDay ? next : undefined);
                      }}
                      onBlur={() => setEditingDay(false)}
                    />
                    天
                  </label>
                ) : (
                  <button type="button" className="se-cs-quiet" disabled={busy} onClick={() => setEditingDay(true)}>改天数</button>
                )
              ) : null}
            </div>
          ) : null}

          {preview.notes && preview.notes.length > 0 ? (
            <ul className="se-cs-notes">
              {preview.notes.map((note) => <li key={note}>{note}</li>)}
            </ul>
          ) : null}

          {blocked ? (
            <section className="se-cs-blocked">
              <div className="se-cs-sec-h">现在还定不了</div>
              {blocking.length > 0 ? (
                <ul>{blocking.map((reason) => <li key={reason}>{reason}</li>)}</ul>
              ) : <p>{preview.summary ?? "这一章现在不满足定稿条件。"}</p>}
            </section>
          ) : null}

          {!blocked && review.length > 0 ? (
            <section>
              <div className="se-cs-sec-h">要你看的 {reviewCount} 条</div>
              {reviewShown.map((group, index) => (
                <div key={group.reason ?? `row-${group.items[0]?.id ?? index}`} className="se-cs-group">
                  {group.reason ? <div className="se-cs-group-h">{group.reason}</div> : null}
                  <ul className="se-cs-list">
                    {group.items.map((item) => (
                      <ReviewRow
                        key={item.id}
                        item={item}
                        kept={isItemKept(item, toggled)}
                        disabled={busy}
                        {...(editable ? { onSet: (keep: boolean) => setKept(item, keep) } : {})}
                      />
                    ))}
                  </ul>
                </div>
              ))}
              {review.length > REVIEW_VISIBLE ? (
                <button type="button" className="se-cs-quiet" onClick={() => setShowAllReview((open) => !open)}>
                  {showAllReview ? "收起" : `还有 ${review.length - REVIEW_VISIBLE} 条要你看`}
                </button>
              ) : null}
            </section>
          ) : null}

          {!blocked && review.length === 0 ? (
            <p className="se-cs-none">{auto.length > 0 ? "没有要你特别看的，下面这些自动记下。" : "这一章没有要记的账。"}</p>
          ) : null}

          {!blocked && auto.length > 0 ? (
            <section className="se-cs-auto">
              <button type="button" className="se-cs-fold" aria-expanded={showAuto} onClick={() => setShowAuto((open) => !open)}>
                {showAuto ? "收起" : `另外自动记下 ${autoKept} 条（不对的点开去掉）`}
              </button>
              {showAuto ? (
                <ul className="se-cs-list is-compact">
                  {auto.map((item) => (
                    <ReviewRow
                      key={item.id}
                      item={item}
                      kept={isItemKept(item, toggled)}
                      disabled={busy}
                      {...(editable ? { onSet: (keep: boolean) => setKept(item, keep) } : {})}
                    />
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}

          {preview.notRecorded && preview.notRecorded.length > 0 ? (
            <details className="se-cs-missed">
              <summary>没记上 {preview.notRecorded.length} 条（原句对不上）</summary>
              <ul>{preview.notRecorded.map((line) => <li key={line}>{line}</li>)}</ul>
            </details>
          ) : null}
        </div>

        <footer className="se-cs-foot">
          <span className="se-cs-hint">{editable ? "写入前自动存档，可撤销" : ""}</span>
          {editable ? (
            <>
              <button type="button" className="se-cs-btn" onClick={onClose}>先不定</button>
              <button
                type="button"
                className="se-cs-btn is-primary"
                disabled={busy}
                onClick={() => onConfirm!([...toggled], dayOverride)}
              >
                {confirmLabel}
              </button>
            </>
          ) : (
            <button type="button" className="se-cs-btn is-primary" onClick={onClose}>知道了</button>
          )}
        </footer>
      </div>
    </>
  );
}

/**
 * 弹窗挂在工作台最外层（专注模式、AI 栏收起时也弹得出来）：找到打开的那条消息上的预览。
 * 只有最新一张没用掉的可定稿预览能点【定稿】；旧的只看。
 */
export function CommitSheetHost({ busy, onSuggestedAction }: {
  readonly busy: boolean;
  readonly onSuggestedAction?: (action: SuggestedAction) => void;
}) {
  const messageId = useCommitSheet((state) => state.messageId);
  const messages = useChatStore((state) => state.messages);
  if (!messageId) return null;
  const message = messages.find((item) => item.id === messageId);
  const preview = message ? cardOf(message, "commit-preview")?.preview : undefined;
  if (!preview) return null;
  const confirmable = confirmableCommitPreviewMessageId(messages) === messageId && Boolean(onSuggestedAction);
  const onConfirm = confirmable
    ? (excluded: readonly string[], dayOverride?: number) => {
      closeCommitSheet();
      onSuggestedAction!(commitConfirmAction({
        chapter: preview.chapter,
        ...(preview.previewToken ? { previewToken: preview.previewToken } : {}),
        ...(excluded.length > 0 ? { excluded } : {}),
        ...(dayOverride !== undefined ? { dayOverride } : {}),
      }));
    }
    : undefined;
  return <CommitSheet key={messageId} preview={preview} busy={busy} {...(onConfirm ? { onConfirm } : {})} onClose={closeCommitSheet} />;
}
