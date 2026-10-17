/**
 * NameConsistencyCard — 人物名一致性提醒卡：本章出现的名字疑似把已确立角色名写歪（如 林宁→林棠）。
 * 数据来自 commit_preview 的 nameConsistencyWarnings（消息上的名字提醒卡），由引擎确定性判定。
 * 关键：这是固定展示的写前一致性护栏——不管助手在正文回执里怎么措辞，只要引擎报了就照实、醒目显示，
 * 不让模型把「疑似写歪」淡化成「有意设计/无关紧要」。只提示、不阻断入库。
 */
import { StepCard } from "./StepCard.js";

export interface NameConsistencyWarningView {
  readonly establishedName: string;
  readonly driftedVariant: string;
  readonly message: string;
}

export function NameConsistencyCard({ warnings }: { readonly warnings: readonly NameConsistencyWarningView[] }) {
  if (warnings.length === 0) return null;
  return (
    <StepCard
      title="人物名一致性"
      status="attention"
      statusLabel={`${warnings.length} 处疑似写歪`}
      defaultOpen
    >
      <p className="ncc-note">
        下面的名字与本书已确立角色名形近、疑似写错（引擎确定性判定）。请确认应沿用已确立的名字，还是这确实是另一个角色：
      </p>
      <ul className="ncc-list">
        {warnings.map((warning) => (
          <li className="ncc-item" key={`${warning.establishedName}|${warning.driftedVariant}`}>
            <span className="ncc-drift">{warning.driftedVariant}</span>
            <span className="ncc-arrow">→ 应为</span>
            <span className="ncc-canonical">{warning.establishedName}</span>
          </li>
        ))}
      </ul>
    </StepCard>
  );
}
