/**
 * ContinuityCheckCard —— 「核账」结果卡（check_continuity，随对应 assistant 消息渲染）。
 *
 * 每条 = 本章原句 + 哪里对不上 + 一行小按钮（「对照第 N 章」点开看前文原句、「改这处」「不是问题」）。
 * 对的是设定卡的条目多一个「改设定卡」：错的可能是卡（尤其 AI 补的），点了翻到设定本那张卡，作者自己改。
 * 「确定」的直接列出；「可能」的默认收起，作者想看再点开（复核把握低，免得一屏噪音）。
 * 「改这处」= 给 agent 发一句只改这一处的意图（对话仍是唯一控制面）；「不是问题」= 记下来（onDismiss 存盘），
 * 以后核账不再报；存失败如实提示「没记住」。可撤回。
 * 主按钮「改掉这 N 处」在卡上（R4.5）：N 随「不是问题」实时变，intent 由卡片现拼——逐条列要改的原句，
 * 末尾写明作者标过不是问题的几处别动（服务端下一步不再给笼统的「改掉确定的 N 处」）。
 * 两章打架、和设定打架的（P12「前文一次定死」）：不再给「改这处」——改哪边是作者的决定，改了不记下来下回还会翻烧饼。
 * 这种条目给「以第 N 章为准」「以本章为准」（对设定的「以设定为准」，对定论的「以定论为准」）：出一张定论卡，
 * 查全书哪几句跟着改，作者确认后一次改齐、记进设定本「定论」。主按钮「改掉本章 N 处」只管前文就在本章的。
 * 外壳沿用 StepCard，条目样式沿用审稿卡的 .drc-*。
 */
import { useEffect, useRef, useState } from "react";
import { StepCard } from "./StepCard.js";
import { useMaybeMarks } from "./maybeMarks.js";
import type { ContinuityCheckData } from "../../../type-defs/workspace.js";
import { continuityItemKey } from "../../../workspace/chapterProgress.js";
import type { AgentUserAction } from "../../../api/agentChatClient.js";
import { continuityFixGoal } from "../../../lib/continuity-fix.js";

type ContinuityCheck = ContinuityCheckData;
type Item = ContinuityCheck["sure"][number];

/** 这条的错在哪一章（R7.3 对设定本的条目可能指向前文那章）；缺省＝当前核的章。 */
const fixChapterOf = (chapter: number, item: Item): number =>
  item.fixChapter !== undefined && item.fixChapter > 0 && item.fixChapter !== chapter ? item.fixChapter : chapter;

/** 单条「改这处」的那句话（本章原句 ↔ 前文原句 + 理由），单条按钮和批量 intent 共用同一句式。
 *  R7.3 对设定本的条目：另一边是设定原文；错在前文那章的，改的就是那章，别让作者把对的改成错的。 */
function continuityItemSentence(chapter: number, item: Item): string {
  const reason = item.reason ? `（${item.reason}）` : "";
  const fix = fixChapterOf(chapter, item);
  if (item.againstSetting) {
    return `把第 ${fix} 章里「${item.quote}」这处改掉：它和设定本${item.againstSetting.label}里的「${item.earlierQuote}」对不上${reason}。`;
  }
  const where = item.earlierChapter === chapter ? "本章前面" : `第 ${item.earlierChapter} 章`;
  return `把第 ${fix} 章里「${item.quote}」这处改掉：它和${where}「${item.earlierQuote}」对不上${reason}。`;
}

export function buildContinuityFixIntent(chapter: number, item: Item): string {
  return `${continuityItemSentence(chapter, item)}只改这一处，别的不动。`;
}

/**
 * 批量「改掉这 N 处」的 intent（R4.5）：逐条列要改的本章原句（句式同单条），末尾圈死范围——
 * 只改列出的这几处；作者标过「不是问题」的 dismissedCount 处（含「可能」档划掉的）明确别动，
 * 免得模型自己复查时把划掉的也顺手改了（验收 3.4）。
 */
export function buildContinuityFixAllIntent(
  chapter: number,
  items: readonly Item[],
  dismissedCount: number,
): string {
  const entries = items.map((item) => continuityItemSentence(chapter, item)).join("");
  return dismissedCount > 0
    ? `${entries}只改这几处；作者标过不是问题的 ${dismissedCount} 处别动。`
    : `${entries}只改这几处，别的不动。`;
}

/**
 * 能由按钮直接改的条目（重构 P6，服务端逐处调 revise_draft，不经模型）：错在这一章的。
 * 错在前文那章的（多半已定稿、没有工作稿）照旧交给 AI。原句是「A……B」拼的也能直接改（改稿定位认省略号）。
 */
export function canFixDirectly(chapter: number, item: Item): boolean {
  return fixChapterOf(chapter, item) === chapter;
}

/** 定论的一边（和 AgentUserAction settle_preview 的 truth / other 同形）。 */
type SettleSide = Extract<AgentUserAction, { readonly toolName: "settle_preview"; readonly truth: unknown }>["truth"];

/**
 * 这条要作者定哪边为准（P12）：两章打架、和设定打架的给两个按钮，和定论打架的只给「以定论为准」
 * （定论要改去设定本改）；前文就在本章的返回 undefined，照旧「改这处」。
 */
export function settleChoices(chapter: number, item: Item): readonly { readonly label: string; readonly action: AgentUserAction }[] | undefined {
  const fix = fixChapterOf(chapter, item);
  const here: SettleSide = { where: "chapter", chapter: fix, quote: item.quote };
  const hereLabel = fix === chapter ? "以本章为准" : `以第 ${fix} 章为准`;
  const reason = item.reason ? { reason: item.reason } : {};
  const pick = (truth: SettleSide, other: SettleSide): AgentUserAction => ({ toolName: "settle_preview", chapter, truth, other, ...reason });
  const setting = item.againstSetting;
  if (setting?.kind === "canon") {
    return [{ label: "以定论为准", action: { toolName: "settle_preview", statement: item.earlierQuote, chapter } }];
  }
  if (setting) {
    const there: SettleSide = { where: "setting", quote: item.earlierQuote, label: setting.label, ...(setting.card ? { card: setting.card } : {}) };
    return [{ label: "以设定为准", action: pick(there, here) }, { label: hereLabel, action: pick(here, there) }];
  }
  if (item.earlierChapter <= 0 || item.earlierChapter === fix) return undefined;
  const there: SettleSide = { where: "chapter", chapter: item.earlierChapter, quote: item.earlierQuote };
  return [{ label: `以第 ${item.earlierChapter} 章为准`, action: pick(there, here) }, { label: hereLabel, action: pick(here, there) }];
}

/** 「改这处」的结构化动作：每处 = 本章原句 + 要和哪句对上。 */
export function continuityFixAction(chapter: number, items: readonly Item[]): AgentUserAction {
  return {
    toolName: "revise_draft",
    chapter,
    fixes: items.map((item) => ({ targetText: item.quote, revisionGoal: continuityFixGoal(chapter, item) })),
  };
}

/** 每条默认只摆本章原句和理由（稿纸上也划了线）；要和哪句对上点「对照…」才展开，免得 N 条就是 4N 行。 */
function ItemView({ chapter, item, onRevise, onSettle, onDismiss }: {
  readonly chapter: number;
  readonly item: Item;
  readonly onRevise?: (item: Item) => void;
  /** 定哪边为准（跨章 / 对设定的条目）：有它就不给「改这处」。 */
  readonly onSettle?: (action: AgentUserAction) => void;
  readonly onDismiss: () => void;
}) {
  const [showSource, setShowSource] = useState(false);
  const choices = onSettle ? settleChoices(chapter, item) : undefined;
  const fix = fixChapterOf(chapter, item);
  const source = item.againstSetting ? `设定（${item.againstSetting.label}）` : item.earlierChapter === chapter ? "本章前面" : `第 ${item.earlierChapter} 章`;
  return (
    <li className="drc-item cck-item">
      <p className="drc-evi serif">{fix === chapter ? null : `第 ${fix} 章：`}「{item.quote}」</p>
      {item.reason ? <p className="drc-desc">{item.reason}</p> : null}
      {showSource ? <p className="drc-evi serif cck-source">{source}：「{item.earlierQuote}」</p> : null}
      <div className="cck-foot">
        <button type="button" className="cck-src" aria-expanded={showSource} onClick={() => setShowSource((open) => !open)}>
          {showSource ? "收起对照" : `对照${source}`}
        </button>
        {choices ? choices.map((choice) => (
          <button key={choice.label} type="button" className="chip drc-fix" onClick={() => onSettle!(choice.action)}>{choice.label}</button>
        )) : onRevise ? (
          <button type="button" className="chip drc-fix" onClick={() => onRevise(item)}>{fix === chapter ? "改这处" : `改第 ${fix} 章`}</button>
        ) : null}
        <button type="button" className="chip drc-fix" onClick={onDismiss}>不是问题</button>
      </div>
    </li>
  );
}

export function ContinuityCheckCard({ check, dismissed: dismissedKeysList = [], superseded = false, onRevise, onFixAction, onDismiss }: {
  readonly check: ContinuityCheck;
  /** 同一章后来又核过：这张是旧结果，说一句、不给改的按钮（上面不传 onRevise / onFixAction）。 */
  readonly superseded?: boolean;
  /** 作者点过「不是问题」的条目键（存在卡上，稿纸划线共用一份）。 */
  readonly dismissed?: readonly string[];
  /** 交给 AI 改（发一句只改这几处的话）：错在前文那章、原句不逐字的走这条。 */
  readonly onRevise?: (intent: string) => void;
  /** 按钮直接改（结构化动作，不经模型）：能直接改的条目走这条。 */
  readonly onFixAction?: (action: AgentUserAction) => void;
  /** 记下 / 撤回「不是问题」；返回是否存成。 */
  readonly onDismiss?: (item: Item, undo: boolean) => Promise<boolean>;
}) {
  const [unsaved, setUnsaved] = useState(false);
  const [showMaybe, setShowMaybe] = useState(false);
  const shownMaybeRef = useRef(false);
  const [showEarlier, setShowEarlier] = useState(false);
  const keyOf = continuityItemKey;
  const dismissedKeys = new Set(dismissedKeysList);
  const allItems = [...check.sure, ...check.maybe, ...(check.earlierOpen ?? [])];
  const dismissed = dismissedKeysList
    .map((key) => allItems.find((item) => keyOf(item) === key))
    .filter((item): item is Item => item !== undefined);
  const sure = check.sure.filter((item) => !dismissedKeys.has(keyOf(item)));
  const maybe = check.maybe.filter((item) => !dismissedKeys.has(keyOf(item)));
  const earlier = (check.earlierOpen ?? []).filter((item) => !dismissedKeys.has(keyOf(item)));
  const earlierChapters = [...new Set(earlier.map((item) => fixChapterOf(check.chapter, item)))].sort((a, b) => a - b);
  const dismiss = (item: Item) => {
    if (onDismiss) void onDismiss(item, false).then((saved) => { if (!saved) setUnsaved(true); });
  };
  const undoLast = () => {
    const last = dismissed.at(-1);
    if (!last) return;
    if (onDismiss) void onDismiss(last, true);
  };
  const reviseOne = (item: Item): void => {
    if (onFixAction && canFixDirectly(check.chapter, item)) onFixAction(continuityFixAction(check.chapter, [item]));
    else onRevise?.(buildContinuityFixIntent(check.chapter, item));
  };
  const canRevise = (item: Item): boolean => Boolean(onRevise) || (Boolean(onFixAction) && canFixDirectly(check.chapter, item));
  // 主按钮只管前文就在本章的；两章打架、对设定的要作者定哪边为准，各自点。
  const sureHere = sure.filter((item) => canFixDirectly(check.chapter, item) && !settleChoices(check.chapter, item));
  const reviseAll = (): void => {
    if (onFixAction) onFixAction(continuityFixAction(check.chapter, sureHere));
    else onRevise?.(buildContinuityFixAllIntent(check.chapter, sureHere, dismissed.length));
  };
  const canReviseAll = sureHere.length > 0 && (Boolean(onRevise) || Boolean(onFixAction));
  // 点开「可能」那段，稿纸上才把这一章的「可能」划出来；收起就撤（默认不划，见 maybeMarks）。
  const toggleMaybe = (): void => {
    const next = !showMaybe;
    setShowMaybe(next);
    useMaybeMarks.getState().show(next ? check.chapter : null);
  };
  useEffect(() => () => {
    if (shownMaybeRef.current && useMaybeMarks.getState().chapter === check.chapter) useMaybeMarks.getState().show(null);
  }, [check.chapter]);
  shownMaybeRef.current = showMaybe;
  const total = sure.length + maybe.length;
  // 什么都没报、也没划掉过的：卡头一行「没发现对不上」就说完了，不再摆一段同样意思的话、也不给展开箭头。
  const empty = total === 0 && earlier.length === 0 && dismissed.length === 0;
  return (
    <StepCard
      title={`核账 · 第 ${check.chapter} 章`}
      status={sure.length > 0 ? "attention" : "done"}
      statusLabel={sure.length > 0 ? `确定 ${sure.length} 处` : total > 0 ? `可能 ${maybe.length} 处` : "没发现对不上"}
      defaultOpen
    >
      {empty ? null : <>
      {superseded ? <p className="drc-summary">后来又核过，以最新一张为准。</p> : null}
      {/* 主按钮（R4.5）：改掉还没划掉的「确定」N 处，文字随「不是问题」实时变；intent 现拼、圈死范围。 */}
      {canReviseAll ? (
        <button
          type="button"
          className="chip drc-fix-all"
          onClick={reviseAll}
        >
          {sureHere.length < sure.length ? `改掉本章 ${sureHere.length} 处` : `改掉这 ${sureHere.length} 处`}
        </button>
      ) : null}
      {sure.length > 0 ? (
        <ul className="drc-list">
          {sure.map((item) => (
            <ItemView key={keyOf(item)} chapter={check.chapter} item={item} {...(canRevise(item) ? { onRevise: reviseOne } : {})} {...(onFixAction ? { onSettle: onFixAction } : {})} onDismiss={() => dismiss(item)} />
          ))}
        </ul>
      ) : null}
      {maybe.length > 0 ? (
        <>
          <button type="button" className="chip" onClick={toggleMaybe}>
            {showMaybe ? "收起" : `还有 ${maybe.length} 处可能有问题（点开看）`}
          </button>
          {showMaybe ? (
            <ul className="drc-list">
              {maybe.map((item) => (
                <ItemView key={keyOf(item)} chapter={check.chapter} item={item} {...(canRevise(item) ? { onRevise: reviseOne } : {})} {...(onFixAction ? { onSettle: onFixAction } : {})} onDismiss={() => dismiss(item)} />
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
      {/* 错在前面某章、之前报过还没改的：不算这一章的问题，收起成一行（作者没改就每章重报一遍，吵）。 */}
      {earlier.length > 0 ? (
        <>
          <button type="button" className="chip" onClick={() => setShowEarlier((open) => !open)}>
            {showEarlier ? "收起" : `第 ${earlierChapters.join("、")} 章还有 ${earlier.length} 处之前报过、还没改`}
          </button>
          {showEarlier ? (
            <ul className="drc-list">
              {earlier.map((item) => (
                <ItemView key={keyOf(item)} chapter={check.chapter} item={item} {...(canRevise(item) ? { onRevise: reviseOne } : {})} {...(onFixAction ? { onSettle: onFixAction } : {})} onDismiss={() => dismiss(item)} />
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
      {dismissed.length > 0 ? (
        <p className="drc-summary">
          {unsaved
            ? `标了 ${dismissed.length} 处不是问题，但没记住（存盘出错），下次核账可能还会报。`
            : `标了 ${dismissed.length} 处不是问题${onDismiss ? "，以后核账不再报" : ""}。`}
          {" "}
          <button type="button" className="chip" onClick={undoLast}>撤回上一处</button>
        </p>
      ) : null}
      </>}
    </StepCard>
  );
}
