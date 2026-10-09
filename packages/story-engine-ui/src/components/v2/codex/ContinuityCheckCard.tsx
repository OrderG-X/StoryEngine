/**
 * ContinuityCheckCard —— 「核账」结果卡（check_continuity，随对应 assistant 消息渲染）。
 *
 * 每条 = 本章原句 ↔ 前文原句（标第几章）+ 哪里对不上 +「改这处」「不是问题」。
 * 「确定」的直接列出；「可能」的默认收起，作者想看再点开（复核把握低，免得一屏噪音）。
 * 「改这处」= 给 agent 发一句只改这一处的意图（对话仍是唯一控制面）；「不是问题」只在本卡上划掉。
 * 外壳沿用 StepCard，条目样式沿用审稿卡的 .drc-*。
 */
import { useState } from "react";
import { StepCard } from "./StepCard.js";
import type { ChapterMessage } from "../../../types.js";

type ContinuityCheck = NonNullable<ChapterMessage["continuityCheck"]>;
type Item = ContinuityCheck["sure"][number];

export function buildContinuityFixIntent(chapter: number, item: Item): string {
  const where = item.earlierChapter === chapter ? "本章前面" : `第 ${item.earlierChapter} 章`;
  return `把第 ${chapter} 章里「${item.quote}」这处改掉：它和${where}「${item.earlierQuote}」对不上（${item.reason}）。只改这一处，别的不动。`;
}

function ItemView({ chapter, item, onRevise, onDismiss }: {
  readonly chapter: number;
  readonly item: Item;
  readonly onRevise?: (item: Item) => void;
  readonly onDismiss: () => void;
}) {
  return (
    <li className="drc-item">
      <p className="drc-evi serif">本章：「{item.quote}」</p>
      <p className="drc-evi serif">{item.earlierChapter === chapter ? "本章前面" : `第 ${item.earlierChapter} 章`}：「{item.earlierQuote}」</p>
      {item.reason ? <p className="drc-desc">{item.reason}</p> : null}
      <div style={{ display: "flex", gap: 6 }}>
        {onRevise ? (
          <button type="button" className="chip drc-fix" onClick={() => onRevise(item)}>改这处</button>
        ) : null}
        <button type="button" className="chip drc-fix" onClick={onDismiss}>不是问题</button>
      </div>
    </li>
  );
}

export function ContinuityCheckCard({ check, onRevise }: {
  readonly check: ContinuityCheck;
  readonly onRevise?: (intent: string) => void;
}) {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [showMaybe, setShowMaybe] = useState(false);
  const keyOf = (item: Item) => `${item.quote}#${item.earlierQuote}`;
  const sure = check.sure.filter((item) => !dismissed.has(keyOf(item)));
  const maybe = check.maybe.filter((item) => !dismissed.has(keyOf(item)));
  const dismiss = (item: Item) => setDismissed((current) => new Set([...current, keyOf(item)]));
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
    </StepCard>
  );
}
