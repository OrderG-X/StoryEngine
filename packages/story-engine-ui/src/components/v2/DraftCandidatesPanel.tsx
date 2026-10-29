import type { DraftCandidate } from "../../stores/uiStore.js";
import { countTextWords } from "../../utils/textUtils.js";

/**
 * 几版并排（「另外几版」卡点开的，写作版本 P2a 片 2D）：AI 一次写的几版都留成了候选，点「用这版」交 draft.adopt 换进工作稿。
 * 纯展示组件；关了几版还在，卡上能再点开。
 */
export default function DraftCandidatesPanel({ candidates, busy, onPick, onClose }: {
  readonly candidates: readonly DraftCandidate[];
  readonly busy: boolean;
  readonly onPick: (candidate: DraftCandidate) => void;
  readonly onClose: () => void;
}) {
  return (
    <div className="se-v2-candidates-overlay" role="dialog" aria-label="几版并排" aria-modal="true">
      <div className="se-v2-candidates-panel">
        <header className="se-v2-candidates-header">
          <strong>选一版换进工作稿</strong>
          <button className="se-v2-btn se-v2-btn-ghost" onClick={onClose} type="button">关闭</button>
        </header>
        <div className="se-v2-candidates-grid">
          {candidates.map((candidate) => {
            return (
              <article className="se-v2-candidate-card" key={candidate.candidateId}>
                <div className="se-v2-candidate-meta">
                  <span>第 {candidate.index} 版{candidate.title ? ` ·「${candidate.title}」` : ""}</span>
                  {/* T14 统一口径：候选字数与稿纸顶栏同函数（正文中文字符，不含标题）。 */}
                  <span>{countTextWords(candidate.body).toLocaleString()} 字</span>
                </div>
                <div className="se-v2-candidate-body">{candidate.body}</div>
                <button
                  className="se-v2-btn se-v2-btn-primary se-v2-candidate-pick"
                  disabled={busy}
                  onClick={() => onPick(candidate)}
                  type="button"
                >
                  用这版
                </button>
              </article>
            );
          })}
        </div>
        <p className="se-v2-candidates-foot">换上前自动存档，可在「历史」里撤销；关了还能在对话的卡上再点开。</p>
      </div>
    </div>
  );
}
