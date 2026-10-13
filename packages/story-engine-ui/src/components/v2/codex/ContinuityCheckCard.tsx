/**
 * ContinuityCheckCard —— 「核账」结果卡（check_continuity，随对应 assistant 消息渲染）。
 *
 * 每条 = 本章原句 ↔ 前文原句（标第几章）+ 哪里对不上 +「改这处」「不是问题」。
 * 「确定」的直接列出；「可能」的默认收起，作者想看再点开（复核把握低，免得一屏噪音）。
 * 「改这处」= 给 agent 发一句只改这一处的意图（对话仍是唯一控制面）；「不是问题」= 记下来（onDismiss 存盘），
 * 下次核这一章不再报；存失败如实提示「没记住」。可撤回。
 * 主按钮「改掉这 N 处」在卡上（R4.5）：N 随「不是问题」实时变，intent 由卡片现拼——逐条列要改的原句，
 * 末尾写明作者标过不是问题的几处别动（服务端下一步不再给笼统的「改掉确定的 N 处」）。
 * 外壳沿用 StepCard，条目样式沿用审稿卡的 .drc-*。
 */
import { useState } from "react";
import { StepCard } from "./StepCard.js";
import type { ChapterMessage } from "../../../types.js";

type ContinuityCheck = NonNullable<ChapterMessage["continuityCheck"]>;
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

function ItemView({ chapter, item, onRevise, onDismiss }: {
  readonly chapter: number;
  readonly item: Item;
  readonly onRevise?: (item: Item) => void;
  readonly onDismiss: () => void;
}) {
  const fix = fixChapterOf(chapter, item);
  return (
    <li className="drc-item">
      <p className="drc-evi serif">{fix === chapter ? "本章" : `第 ${fix} 章`}：「{item.quote}」</p>
      <p className="drc-evi serif">{item.againstSetting ? `设定（${item.againstSetting.label}）` : item.earlierChapter === chapter ? "本章前面" : `第 ${item.earlierChapter} 章`}：「{item.earlierQuote}」</p>
      {item.reason ? <p className="drc-desc">{item.reason}</p> : null}
      <div style={{ display: "flex", gap: 6 }}>
        {onRevise ? (
          <button type="button" className="chip drc-fix" onClick={() => onRevise(item)}>{fix === chapter ? "改这处" : `改第 ${fix} 章`}</button>
        ) : null}
        <button type="button" className="chip drc-fix" onClick={onDismiss}>不是问题</button>
      </div>
    </li>
  );
}

export function ContinuityCheckCard({ check, onRevise, onDismiss }: {
  readonly check: ContinuityCheck;
  readonly onRevise?: (intent: string) => void;
  /** 记下 / 撤回「不是问题」；返回是否存成。缺省只在本卡上划掉。 */
  readonly onDismiss?: (item: Item, undo: boolean) => Promise<boolean>;
}) {
  const [dismissed, setDismissed] = useState<readonly Item[]>([]);
  const [unsaved, setUnsaved] = useState(false);
  const [showMaybe, setShowMaybe] = useState(false);
  const keyOf = (item: Item) => `${item.quote}#${item.earlierQuote}`;
  const dismissedKeys = new Set(dismissed.map(keyOf));
  const sure = check.sure.filter((item) => !dismissedKeys.has(keyOf(item)));
  const maybe = check.maybe.filter((item) => !dismissedKeys.has(keyOf(item)));
  const dismiss = (item: Item) => {
    setDismissed((current) => [...current, item]);
    if (onDismiss) void onDismiss(item, false).then((saved) => { if (!saved) setUnsaved(true); });
  };
  const undoLast = () => {
    const last = dismissed.at(-1);
    if (!last) return;
    setDismissed((current) => current.slice(0, -1));
    if (onDismiss) void onDismiss(last, true);
  };
  const revise = onRevise ? (item: Item) => onRevise(buildContinuityFixIntent(check.chapter, item)) : undefined;
  const total = sure.length + maybe.length;
  return (
    <StepCard
      title={`核账 · 第 ${check.chapter} 章`}
      status={sure.length > 0 ? "attention" : "done"}
      statusLabel={sure.length > 0 ? `确定 ${sure.length} 处` : total > 0 ? `可能 ${maybe.length} 处` : "没发现对不上"}
      defaultOpen
    >
      {total === 0 ? <p className="drc-summary">拿这一章对了前文，没发现前后对不上的地方。</p> : null}
      {/* 主按钮（R4.5）：改掉还没划掉的「确定」N 处，文字随「不是问题」实时变；intent 现拼、圈死范围。 */}
      {sure.length > 0 && onRevise ? (
        <button
          type="button"
          className="chip drc-fix-all"
          onClick={() => onRevise(buildContinuityFixAllIntent(check.chapter, sure, dismissed.length))}
        >
          改掉这 {sure.length} 处
        </button>
      ) : null}
      {sure.length > 0 ? (
        <ul className="drc-list">
          {sure.map((item) => (
            <ItemView key={keyOf(item)} chapter={check.chapter} item={item} onRevise={revise} onDismiss={() => dismiss(item)} />
          ))}
        </ul>
      ) : null}
      {maybe.length > 0 ? (
        <>
          <button type="button" className="chip" onClick={() => setShowMaybe((open) => !open)}>
            {showMaybe ? "收起" : `还有 ${maybe.length} 处可能有问题（点开看）`}
          </button>
          {showMaybe ? (
            <ul className="drc-list">
              {maybe.map((item) => (
                <ItemView key={keyOf(item)} chapter={check.chapter} item={item} onRevise={revise} onDismiss={() => dismiss(item)} />
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
      {dismissed.length > 0 ? (
        <p className="drc-summary">
          {unsaved
            ? `标了 ${dismissed.length} 处不是问题，但没记住（存盘出错），下次核账可能还会报。`
            : `标了 ${dismissed.length} 处不是问题${onDismiss ? "，下次核这一章不再报" : ""}。`}
          {" "}
          <button type="button" className="chip" onClick={undoLast}>撤回上一处</button>
        </p>
      ) : null}
    </StepCard>
  );
}
