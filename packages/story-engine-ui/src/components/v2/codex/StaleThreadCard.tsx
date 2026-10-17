/**
 * StaleThreadCard — 伏笔/线索待收口提醒卡：某条已埋的伏笔或已开的线索连续多章没有推进（如埋了 5 章没人收）。
 * 数据来自 commit_preview 的 staleThreadWarnings（消息上的线索提醒卡），由引擎确定性判定（超 3 章未触及）。
 * 关键：这是固定展示的「防遗漏」护栏——不管助手在正文回执里怎么措辞，只要引擎报了就照实显示，
 * 不让模型把「埋了不收」淡化成「留白/后续再说」。只提示、不阻断入库。
 */
import { StepCard } from "./StepCard.js";

export interface StaleThreadWarningView {
  readonly kind: string;
  readonly title: string;
  readonly lastTouchedChapter: number;
  readonly chaptersSinceTouched: number;
  readonly message: string;
}

export function StaleThreadCard({ warnings }: { readonly warnings: readonly StaleThreadWarningView[] }) {
  if (warnings.length === 0) return null;
  return (
    <StepCard
      title="伏笔 / 线索待收口"
      status="attention"
      statusLabel={`${warnings.length} 条久未推进`}
      defaultOpen
    >
      <p className="stc-note">
        下面这些伏笔/线索已经好几章没有推进了（引擎确定性判定）。别让它们埋了不收、开了没下文——考虑在本章推进或收口：
      </p>
      <ul className="stc-list">
        {warnings.map((warning) => (
          <li className="stc-item" key={`${warning.kind}|${warning.title}`}>
            <span className="stc-kind">{warning.kind}</span>
            <span className="stc-title">{warning.title}</span>
            <span className="stc-gap">已 {warning.chaptersSinceTouched} 章没推进</span>
            <span className="stc-since">上次第 {warning.lastTouchedChapter} 章</span>
          </li>
        ))}
      </ul>
    </StepCard>
  );
}
