/**
 * 定稿清单（重构 P6，草图 ②）：定稿预览从对话卡改成弹窗。
 *
 *  - 头：定稿第 N 章；这一章记为故事第几天 + 依据原句 +【改天数】；记账员的提醒（没读完前文等）照实列。
 *  - 要你看的（≤8 条先露，其余点开）：每条一句 + 原句 +【记下】【不记】；要确认的改记是【改记】【不改】、默认不改。
 *  - 另外自动记下 N 条：收起；点开每条也能【不记】。
 *  - 定不了时：照实列阻断原因，只有【知道了】；只差字数下限的多一个【就这么短，照样定稿】（只放这一章）。
 *  - 底：【先不定】【确认定稿】。确认＝接着做出这张清单的那次定稿（带上作者去掉的、确认的、改的天数），不经模型。
 *  - 补账清单（P2b）：同一份清单，头是「补记第 N 章的账」、按钮是【确认记账】，正文不动。
 *  - 这章是哪天不知道（前面有章账待记）：天数两栏空着，【填天数】。
 *
 * 作者动过的条目记在 utils/ledgerExclusions（按出清单的那次定稿），关了再开都带得上。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { CommitPreviewCardData } from "../../../type-defs/workspace.js";
import {
  clearLedgerExclusions,
  type DayOverride,
  ledgerDayOverrideFor,
  ledgerExclusionsFor,
  rememberLedgerDayOverride,
  rememberLedgerExclusions,
} from "../../../utils/ledgerExclusions.js";
import { IconClose } from "./icons.js";
import { confirmableCommitPreviewIds } from "./commitConfirm.js";
import { closeCommitSheet, useCommitSheet } from "../../../workspace/commitSheet.js";
import { useChatStore } from "../../../stores/chatStore.js";
import { useBookStore } from "../../../stores/bookStore.js";
import { cardOf } from "../../../utils/messageCards.js";
import { newCommitAction, type AgentUserAction } from "../../../api/agentChatClient.js";
import { usePresence, type PresenceHandle } from "../../../hooks/usePresence.js";

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
  const day = items.find((item) => item.editableDay !== undefined || item.dayUnknown === true);
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
  opId,
  busy,
  onConfirm,
  onClose,
  presence,
  firstCommit = false,
  onCommitShort,
}: {
  readonly preview: CommitPreviewCardData;
  /** 出这张清单的那次定稿：作者动过的条目、改的天数按它记（关了再开带得上）。 */
  readonly opId?: string;
  /** 有动作在跑：按钮先不让点。 */
  readonly busy: boolean;
  /** 传了且能定稿 → 底部有【确认定稿】；参数是作者去掉 / 确认的条目 id、改过的天数。没传＝只看（用掉了、作废了的清单）。 */
  readonly onConfirm?: (excluded: readonly string[], dayOverride?: DayOverride) => void;
  readonly onClose: () => void;
  /** 关的时候播退场（usePresence）。 */
  readonly presence?: PresenceHandle;
  /** 这本书还没定稿过：头一回说一句定稿是干什么的（2026-10-23 从零走查：新作者不知道定稿和存稿有什么两样）。 */
  readonly firstCommit?: boolean;
  /** 只差字数下限时：作者说这章就这么短，重新出清单、这一章不拿下限挡。 */
  readonly onCommitShort?: () => void;
}) {
  const ledger = preview.ledgerChecklist ?? [];
  const { day, review, auto } = splitChecklist(ledger);
  const blocking = preview.blockingReasons?.filter((reason) => reason.trim()) ?? [];
  const blocked = !preview.canCommit || blocking.length > 0;
  const editable = !blocked && Boolean(onConfirm);

  const [toggled, setToggled] = useState<ReadonlySet<string>>(() => (opId ? ledgerExclusionsFor(opId) : new Set()));
  const setKept = (item: ChecklistItem, keep: boolean) => setToggled((current) => {
    const next = new Set(current);
    // 默认记的：不记＝进集合；要确认的改记：改记＝进集合。
    const inSet = item.defaultUnchecked ? keep : !keep;
    if (inSet) next.add(item.id);
    else next.delete(item.id);
    if (opId) rememberLedgerExclusions(opId, next);
    return next;
  });
  const [dayOverride, setDayOverride] = useState<DayOverride | undefined>(() => (opId ? ledgerDayOverrideFor(opId) : undefined));
  const [editingDay, setEditingDay] = useState(false);
  /** 正在打的字：删空了先让它空着（不然一删就弹回原来的数，再打成了「114」）。 */
  const [dayText, setDayText] = useState<string | null>(null);
  const [dayEndText, setDayEndText] = useState<string | null>(null);
  // 记下的头一天、最后一天（确定才有）；作者改了以后按作者的。哪天不知道的两栏空着，作者填了才有。
  const keptDay = day?.editableDay;
  const shownDay = dayOverride?.day ?? keptDay;
  const shownEnd = dayOverride ? dayOverride.dayEnd : day?.editableDayEnd;
  const changeDay = (value: DayOverride | undefined) => {
    setDayOverride(value);
    if (opId) rememberLedgerDayOverride(opId, value);
  };
  /**
   * 改头一天：跨的天数跟着挪（第 20～21 天改成 21 → 第 21～22 天）；要只记一天，把「到第几天」也改成同一天。
   * 这次已经填过「到第几天」就按填的不动（换题材长篇实跑 2026-10-27：先填到第 13 天、再把头一天改成 12，
   * 跟着挪成了第 12～14 天，框里却还显示 13）。章末是哪天说不准的，只改头一天就不替作者定结尾（按这章里换天推）。
   */
  const changeStart = (value: number | undefined) => {
    if (value === undefined) {
      changeDay(undefined);
      return;
    }
    const start = shownDay ?? value;
    const dayEnd = shownEnd === undefined ? undefined : dayEndText !== null ? Math.max(shownEnd, value) : value + Math.max(0, shownEnd - start);
    if (dayEndText !== null && Number(dayEndText) !== dayEnd) setDayEndText(null);
    changeDay({ day: value, ...(dayEnd !== undefined ? { dayEnd } : {}) });
  };
  const changeEnd = (value: number | undefined) => {
    if (value === undefined) return;
    const start = shownDay ?? value;
    changeDay({ day: start, dayEnd: Math.max(value, start) });
  };
  const dayOverrideLabel = dayOverride
    ? `这一章改记为故事第 ${dayOverride.day} 天${dayOverride.dayEnd !== undefined && dayOverride.dayEnd > dayOverride.day ? `到第 ${dayOverride.dayEnd} 天` : ""}`
    : undefined;
  const [showAllReview, setShowAllReview] = useState(false);
  const [showAuto, setShowAuto] = useState(false);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const presenceRef = presence?.ref;
  const setDialogRef = useCallback((el: HTMLDivElement | null) => {
    dialogRef.current = el;
    presenceRef?.(el);
  }, [presenceRef]);
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
  const fill = preview.fill === true;
  const title = fill ? `补记第 ${preview.chapter} 章的账` : `定稿第 ${preview.chapter} 章`;
  const confirmWord = fill ? "确认记账" : "确认定稿";
  const confirmLabel = removed > 0 ? `${confirmWord}（不记 ${removed} 条）` : confirmed > 0 ? `${confirmWord}（改记 ${confirmed} 条）` : confirmWord;

  return (
    <>
      <div className="se-scrim" aria-hidden="true" onClick={onClose} data-closing={presence?.closing || undefined} />
      <div ref={setDialogRef} data-closing={presence?.closing || undefined} className="se-cs" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <header className="se-cs-head">
          <h2>{title}</h2>
          <button type="button" className="se-icon-btn" aria-label="关闭定稿清单" onClick={onClose}><IconClose /></button>
        </header>

        <div className="se-cs-body">
          {firstCommit && editable && !fill ? (
            <p className="se-cs-intro">定稿就是把这章记进账：谁出场、出了什么事、埋了什么线。往后 AI 写、核账，都对着账查。</p>
          ) : null}
          {day ? (
            <div className={`se-cs-day${day.needsConfirm ? " is-attention" : ""}`}>
              <span>{dayOverrideLabel ?? day.label}</span>
              {day.reason && !dayOverride ? <span className="se-cs-day-why">{day.reason}</span> : null}
              {day.detail ? <span className="se-cs-quote serif">依据「{day.detail}」</span> : null}
              {editable && (keptDay !== undefined || day.dayUnknown) ? (
                editingDay ? (
                  <span
                    className="se-cs-day-edit"
                    onBlur={(event) => {
                      // 在两个框之间挪不算改完。
                      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                      setEditingDay(false);
                      setDayText(null);
                      setDayEndText(null);
                    }}
                  >
                    第
                    <input
                      type="number"
                      min={1}
                      autoFocus
                      aria-label="这一章是故事第几天"
                      value={dayText ?? shownDay ?? ""}
                      disabled={busy}
                      onChange={(event) => {
                        setDayText(event.target.value);
                        const next = Number(event.target.value);
                        // 填回原来那一天也算作者定的。
                        changeStart(Number.isInteger(next) && next >= 1 ? next : undefined);
                      }}
                    />
                    天到第
                    <input
                      type="number"
                      min={1}
                      aria-label="这一章到故事第几天"
                      value={dayEndText ?? shownEnd ?? ""}
                      disabled={busy}
                      onChange={(event) => {
                        setDayEndText(event.target.value);
                        const next = Number(event.target.value);
                        // 两头填成同一天＝这一章就这一天（记账员记成跨两天、其实没跨，P6 第 7 步）。
                        changeEnd(Number.isInteger(next) && next >= 1 ? next : undefined);
                      }}
                    />
                    天
                  </span>
                ) : (
                  <button type="button" className="se-cs-quiet" disabled={busy} onClick={() => setEditingDay(true)}>{keptDay === undefined && !dayOverride ? "填天数" : "改天数"}</button>
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
              <div className="se-cs-sec-h">{fill ? "现在还补不了" : "现在还定不了"}</div>
              {blocking.length > 0 ? (
                <ul>{blocking.map((reason) => <li key={reason}>{reason}</li>)}</ul>
              ) : <p>{preview.summary ?? (fill ? "这一章的账现在补不了。" : "这一章现在不满足定稿条件。")}</p>}
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
            <p className="se-cs-none">{auto.length > 0 ? `${day?.needsConfirm ? "除了天数，" : ""}没有要你特别看的，下面这些自动记下。` : "这一章没有要记的账。"}</p>
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
              <summary>没记上 {preview.notRecorded.length} 条</summary>
              <ul>{preview.notRecorded.map((line) => <li key={line}>{line}</li>)}</ul>
            </details>
          ) : null}
        </div>

        <footer className="se-cs-foot">
          <span className="se-cs-hint">{editable ? "写入前自动存档，可撤销" : ""}</span>
          {editable ? (
            <>
              <button type="button" className="se-cs-btn" onClick={onClose}>{fill ? "先不补" : "先不定"}</button>
              <button
                type="button"
                className="se-cs-btn is-primary"
                disabled={busy}
                onClick={() => onConfirm!([...toggled], dayOverride)}
              >
                {confirmLabel}
              </button>
            </>
          ) : blocked && preview.shortOnly && onCommitShort ? (
            <>
              <button type="button" className="se-cs-btn" onClick={onClose}>知道了</button>
              <button type="button" className="se-cs-btn is-primary" disabled={busy} onClick={onCommitShort}>就这么短，照样定稿</button>
            </>
          ) : (
            <button type="button" className="se-cs-btn is-primary" onClick={onClose}>知道了</button>
          )}
        </footer>
      </div>
    </>
  );
}

/** 点「确认定稿」时对话里那句「你：…」：去掉了几条、确认改记几条、改了天数照实说。 */
export function commitConfirmEcho(preview: CommitPreviewCardData, toggled: readonly string[], dayOverride?: DayOverride): string {
  const ledger = preview.ledgerChecklist ?? [];
  const on = new Set(toggled);
  const removed = ledger.filter((item) => item.removable && !item.defaultUnchecked && on.has(item.id)).length;
  const confirmed = ledger.filter((item) => item.removable && item.defaultUnchecked && on.has(item.id)).length;
  const dayEnd = dayOverride?.dayEnd !== undefined && dayOverride.dayEnd > dayOverride.day ? dayOverride.dayEnd : undefined;
  const notes = [
    ...(removed > 0 ? [`账本清单去掉了 ${removed} 条`] : []),
    ...(confirmed > 0 ? [`确认改记 ${confirmed} 条`] : []),
    ...(dayOverride ? [`这一章改记为故事第 ${dayOverride.day} 天${dayEnd !== undefined ? `到第 ${dayEnd} 天` : ""}`] : []),
  ];
  const head = preview.fill ? `确认记账第 ${preview.chapter} 章` : `确认定稿第 ${preview.chapter} 章`;
  return notes.length > 0 ? `${head}（${notes.join("，")}）` : head;
}

/**
 * 弹窗挂在工作台最外层（专注模式、AI 栏收起时也弹得出来）：找到打开的那条消息上的清单。
 * 出它的那次定稿还在等作者点的才能点【确认定稿】（确认＝接着做那次定稿）；用掉了、作废了的只看。
 */
export function CommitSheetHost({ busy, onSendUserAction }: {
  readonly busy: boolean;
  readonly onSendUserAction?: (action: AgentUserAction, options?: { readonly echo?: string }) => void;
}) {
  const openId = useCommitSheet((state) => state.messageId);
  const messages = useChatStore((state) => state.messages);
  const firstCommit = useBookStore((state) => !state.workspace.chapters.some((chapter) => chapter.hasCommittedChapter === true || chapter.status === "committed"));
  // 关上时还要把那张清单留着播完退场：记住最后打开的是哪条。
  const presence = usePresence(Boolean(openId));
  const lastId = useRef(openId);
  if (openId) lastId.current = openId;
  const messageId = openId ?? (presence.mounted ? lastId.current : null);
  if (!messageId) return null;
  const message = messages.find((item) => item.id === messageId);
  const card = message ? cardOf(message, "commit-preview") : undefined;
  if (!message || !card) return null;
  const { preview, opId } = card;
  const pending = cardOf(message, "operation")?.op.pending;
  const answerTo = opId && pending?.kind === "commit" && confirmableCommitPreviewIds(messages).has(messageId) ? { opId, actionId: pending.actionId } : undefined;
  const onConfirm = answerTo && onSendUserAction
    ? (toggled: readonly string[], dayOverride?: DayOverride) => {
      closeCommitSheet();
      clearLedgerExclusions(answerTo.opId);
      const values = dayOverride ? { day: dayOverride.day, ...(dayOverride.dayEnd !== undefined ? { dayEnd: dayOverride.dayEnd } : {}) } : undefined;
      onSendUserAction(
        { kind: "resume", opId: answerTo.opId, answer: { actionId: answerTo.actionId, decision: "commit", ...(toggled.length > 0 ? { excluded: [...toggled] } : {}), ...(values ? { values } : {}) } },
        { echo: commitConfirmEcho(preview, toggled, dayOverride) },
      );
    }
    : undefined;
  const onCommitShort = preview.shortOnly && onSendUserAction
    ? () => {
      closeCommitSheet();
      onSendUserAction(newCommitAction(preview.chapter, { allowShort: true }));
    }
    : undefined;
  return (
    <CommitSheet
      key={messageId}
      preview={preview}
      {...(opId ? { opId } : {})}
      busy={busy}
      {...(onConfirm ? { onConfirm } : {})}
      {...(onCommitShort ? { onCommitShort } : {})}
      onClose={closeCommitSheet}
      presence={presence}
      firstCommit={firstCommit}
    />
  );
}
