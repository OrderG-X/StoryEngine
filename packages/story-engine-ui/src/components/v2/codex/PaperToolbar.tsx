/**
 * 稿纸底下的工具条（重构 P6，草图 ①）：一句核账状态 + 核账 / 定稿（已定稿时是「去第 N 章」）。专注模式也在。
 * 说法和右栏顶卡同源（workspace/chapterProgress），按钮都是现有的结构化动作，不新增绕过对话的路。
 */
import type { ChapterProgress } from "../../../workspace/chapterProgress.js";
import type { ChapterButton } from "../../../utils/chapterButtons.js";
import { requestContinuityFocus } from "./ContinuityMarks.js";

export function PaperToolbar({
  progress,
  busy,
  onChapterButton,
  onOpenChapter,
  reroll,
}: {
  readonly progress: ChapterProgress;
  readonly busy: boolean;
  readonly onChapterButton?: (button: ChapterButton) => void;
  /** 已定稿时「去第 N 章」：换到那一章。 */
  readonly onOpenChapter?: (chapter: number) => void;
  /** 「再来一版」（抽候选稿）：只在还没定稿、有入口时给。 */
  readonly reroll?: { readonly label: string; readonly running: boolean; readonly onClick: () => void; readonly title: string };
}) {
  const { primary, check } = progress;
  const next = progress.commit.done && primary.kind === "open_next" ? progress.next : undefined;
  const buttons: { readonly button: ChapterButton; readonly label: string }[] = progress.commit.done
    ? next !== undefined ? [] : [{ button: "write_next", label: "写下一章" }]
    : !progress.write.done
      ? [{ button: "write", label: "写这一章" }]
      : [
        { button: "check_continuity", label: check.state === "none" ? "核账" : "再核一遍" },
        { button: "commit_preview", label: "定稿" },
      ];
  // 主按钮是「去看那 N 处」时，工具条上没有主按钮——状态那句本身就能点。
  const isPrimary = (button: ChapterButton): boolean => primary.kind === button;
  const canJump = check.state === "issues" || (check.state === "clean" && check.maybe > 0);
  return (
    <div className="cd-tools" role="toolbar" aria-label="本章动作">
      {canJump ? (
        <button type="button" className="cd-tools-status is-link" onClick={requestContinuityFocus} title="在稿纸上看划线的那几句">
          {progress.statusLine}
        </button>
      ) : (
        <span className="cd-tools-status">{progress.statusLine}</span>
      )}
      {reroll ? (
        <button type="button" className="cd-tools-btn is-quiet" disabled={busy || reroll.running} title={reroll.title} onClick={reroll.onClick}>
          {reroll.running ? "生成候选中…" : reroll.label}
        </button>
      ) : null}
      {next !== undefined && onOpenChapter ? (
        <button type="button" className="cd-tools-btn is-primary" disabled={busy} onClick={() => onOpenChapter(next)}>
          {primary.label}
        </button>
      ) : null}
      {onChapterButton ? buttons.map(({ button, label }) => (
        <button
          key={button}
          type="button"
          className={`cd-tools-btn${isPrimary(button) ? " is-primary" : ""}`}
          disabled={busy}
          onClick={() => onChapterButton(button)}
        >
          {label}
        </button>
      )) : null}
    </div>
  );
}
