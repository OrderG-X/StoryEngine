import type { DraftCandidate } from "../../stores/workspaceStore.js";
import { countTextWords } from "../../utils/textUtils.js";

/**
 * 抽卡候选并排面板（阶段三块③）：「再来一版」生成的 2–3 个临时候选并排展示，点「用这版」替换当前工作稿。
 * 纯展示组件——生成/挑中/关闭由 useWorkflowActions + store 负责。候选临时、未落盘，关闭即丢弃、不影响当前工作稿。
 */
export default function DraftCandidatesPanel({ candidates, busy, onPick, onClose }: {
  readonly candidates: readonly DraftCandidate[];
  readonly busy: boolean;
  readonly onPick: (content: string) => void;
  readonly onClose: () => void;
}) {
  return (
    <div className="se-v2-candidates-overlay" role="dialog" aria-label="再来一版候选" aria-modal="true">
      <div className="se-v2-candidates-panel">
        <header className="se-v2-candidates-header">
          <strong>再来一版 · 选一个替换当前工作稿</strong>
          <button className="se-v2-btn se-v2-btn-ghost" onClick={onClose} type="button">关闭</button>
        </header>
        <div className="se-v2-candidates-grid">
          {candidates.map((candidate, index) => {
            const body = candidateBody(candidate.content);
            return (
              <article className="se-v2-candidate-card" key={index}>
                <div className="se-v2-candidate-meta">
                  <span>候选 {index + 1}</span>
                  {/* T14 统一口径：候选字数与稿纸顶栏同函数（正文中文字符，不含标题）。 */}
                  <span>{countTextWords(candidate.content).toLocaleString()} 字</span>
                </div>
                <div className="se-v2-candidate-body">{body}</div>
                <button
                  className="se-v2-btn se-v2-btn-primary se-v2-candidate-pick"
                  disabled={busy}
                  onClick={() => onPick(candidate.content)}
                  type="button"
                >
                  用这版
                </button>
              </article>
            );
          })}
        </div>
        <p className="se-v2-candidates-foot">候选还没落盘，关闭即丢弃；选用后写前自动快照，可在「操作历史」撤销。</p>
      </div>
    </div>
  );
}

/** 去掉候选正文开头的 markdown 标题行，只展示正文。 */
function candidateBody(content: string): string {
  return content.replace(/^#\s.*(?:\r?\n){1,2}/u, "").trim();
}
