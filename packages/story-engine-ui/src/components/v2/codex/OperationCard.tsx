/**
 * 操作卡（写作版本 P2a）：核账、检查这类交给执行器做的事在对话里的样子。
 * 在做：一行带呼吸点 + 最新一句进度；停着：为什么停 +「接着做」「不要了」；结束了：这一轮的话里说过结论就不再显示，
 * 后台做完、重开才收到的照实写一句结论。字都是服务端给的（what / stateText / summary），界面不自己拼。
 */
import type { AgentUserAction } from "../../../api/agentChatClient.js";
import type { OperationCardData } from "../../../type-defs/workspace.js";
import { ENDED_OPERATION_STATES } from "../../../workspace/operationCards.js";

const RUNNING: ReadonlySet<OperationCardData["state"]> = new Set(["queued", "running"]);

/** 在做的操作给主按钮的字幕；没在做返回 null。 */
export function runningOperationCaption(op: OperationCardData | undefined): string | null {
  return op && RUNNING.has(op.state) ? `正在${op.what}…` : null;
}

/**
 * 检查结果是不是查完之后稿子又改过了：同一章，作者眼前有没存的字，或盘上那版不是查的那版。
 * 没有对着工作稿查（checkedVersion 不是字符串）、眼前不是这一章、眼前没稿（定稿后清掉了）都不算。
 */
export function checkedBeforeEdit(
  checkedVersion: string | null | undefined,
  inspectedChapter: number | undefined,
  paper: { readonly chapter: number; readonly baseVersion: string | null; readonly dirty: boolean },
): boolean {
  if (typeof checkedVersion !== "string" || inspectedChapter !== paper.chapter) return false;
  return paper.dirty || (paper.baseVersion !== null && paper.baseVersion !== checkedVersion);
}

export function OperationCard({ op, inLiveTurn, busy, onAction }: {
  readonly op: OperationCardData;
  /** 这一轮还在跑、操作就是这一轮交的：停它用输入框的停止键，卡上不再给「不要了」。 */
  readonly inLiveTurn: boolean;
  readonly busy: boolean;
  readonly onAction?: ((action: AgentUserAction) => void) | undefined;
}) {
  if (ENDED_OPERATION_STATES.has(op.state)) {
    if (op.announced) return null;
    return (
      <div className="se-op-card is-ended" role="status">
        <span className="se-op-text">{op.what}：{op.summary || op.stateText}</span>
      </div>
    );
  }
  if (op.state === "waiting_author" && op.pending) return <ReviseChoice op={op} pending={op.pending} busy={busy} onAction={onAction} />;
  const running = RUNNING.has(op.state);
  const canResume = Boolean(onAction) && op.allowed.includes("resume");
  const canCancel = Boolean(onAction) && op.allowed.includes("cancel") && !inLiveTurn;
  return (
    <div className={`se-op-card${running ? " is-running" : ""}`} role="status">
      {running ? <span className="se-op-dot" aria-hidden="true" /> : null}
      <span className="se-op-text">{op.what}：{running ? (op.progress ?? op.stateText) : op.stateText}</span>
      {canResume || canCancel ? (
        <span className="se-op-acts">
          {canResume ? (
            <button type="button" className="chip" disabled={busy} onClick={() => onAction?.({ kind: "resume", opId: op.opId })}>接着做</button>
          ) : null}
          {canCancel ? (
            <button type="button" className="chip" disabled={busy} onClick={() => onAction?.({ kind: "cancel", opId: op.opId })}>不要了</button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

/** 点了「换上 / 再改一版」交回去的决定（和服务端改写的 decisions 同名）。 */
const DECISION_LABELS: Readonly<Record<string, string>> = { apply: "换上", again: "再改一版" };

/**
 * 改写停着等作者（片 2C）：改前划掉、改后照摆，点「换上」才换进稿子；「再改一版」换个改法；「不要了」稿子不动。
 * 这一轮在跑时也给「不要了」：等作者点的时候这一轮已经说完了。
 */
function ReviseChoice({ op, pending, busy, onAction }: {
  readonly op: OperationCardData;
  readonly pending: NonNullable<OperationCardData["pending"]>;
  readonly busy: boolean;
  readonly onAction?: ((action: AgentUserAction) => void) | undefined;
}) {
  const { revise } = pending;
  return (
    <div className="se-op-card se-op-revise" role="group" aria-label={op.what}>
      {revise.brief ? <p className="se-op-brief">{revise.brief}</p> : null}
      <ul className="se-op-changes">
        {revise.changes.map((change, index) => (
          <li key={index}>
            <p className="se-op-from serif">{change.from}</p>
            <p className="se-op-to serif">{change.to}</p>
          </li>
        ))}
      </ul>
      {revise.failed.length > 0 ? <p className="se-op-failed">{revise.failed.length === 1 ? `这一段没改成：${revise.failed[0]!.why}` : `${revise.failed.length} 段没改成：${revise.failed[0]!.why}`}</p> : null}
      {onAction ? (
        <span className="se-op-acts">
          {pending.decisions.map((decision) => (DECISION_LABELS[decision] ? (
            <button
              key={decision}
              type="button"
              className={decision === "apply" ? "chip is-primary" : "chip"}
              disabled={busy}
              onClick={() => onAction({ kind: "resume", opId: op.opId, answer: { actionId: pending.actionId, decision } })}
            >
              {DECISION_LABELS[decision]}
            </button>
          ) : null))}
          {op.allowed.includes("cancel") ? (
            <button type="button" className="chip" disabled={busy} onClick={() => onAction({ kind: "cancel", opId: op.opId })}>不要了</button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
