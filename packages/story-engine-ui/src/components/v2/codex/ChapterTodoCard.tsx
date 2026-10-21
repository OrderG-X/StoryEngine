/**
 * 右栏顶卡「第 N 章还差什么」（重构 P6，草图 ①）：写 / 核账 / 定稿三行打勾 + 一个主按钮。
 * 说法和稿纸底下的工具条同源（workspace/chapterProgress）。主按钮按顺序取第一个没做完的：
 * 写这一章 → 核账 → 去看那 N 处 → 定稿 → 去第 N 章（后面第一个没定稿的章）。
 */
import type { ReactNode } from "react";
import { STEP_HINTS, type ChapterProgress } from "../../../workspace/chapterProgress.js";
import type { ChapterButton } from "../../../utils/chapterButtons.js";
import { requestContinuityFocus } from "./ContinuityMarks.js";

const COUNT = ["", "一", "两", "三"];

export function ChapterTodoCard({
  progress,
  busy,
  busyCaption,
  onChapterButton,
  onOpenChapter,
  children,
}: {
  readonly progress: ChapterProgress;
  readonly busy: boolean;
  /** 有动作在跑时主按钮上说的那句（如「AI 在写…」）。 */
  readonly busyCaption?: string | null;
  readonly onChapterButton?: (button: ChapterButton) => void;
  /** 「去第 N 章」：换到那一章。 */
  readonly onOpenChapter?: (chapter: number) => void;
  /** 卡下面的小字行（编辑部读前文、不急的事）。 */
  readonly children?: ReactNode;
}) {
  if (progress.chapter <= 0) return null;
  const steps = [
    { key: "write", label: "写", hint: undefined, ...progress.write },
    { key: "check", label: "核账", hint: STEP_HINTS.check_continuity, done: progress.check.done, text: progress.check.text },
    { key: "commit", label: "定稿", hint: STEP_HINTS.commit_preview, ...progress.commit },
  ];
  const left = steps.filter((step) => !step.done).length;
  const title = progress.commit.done ? `第 ${progress.chapter} 章已定稿` : `第 ${progress.chapter} 章还差${COUNT[left] ?? left}步`;
  const { primary } = progress;
  const onPrimary = () => {
    if (primary.kind === "show_issues") requestContinuityFocus();
    else if (primary.kind === "open_next") {
      if (progress.next) onOpenChapter?.(progress.next);
    } else onChapterButton?.(primary.kind);
  };
  const actionable = primary.kind === "show_issues" || (primary.kind === "open_next" ? Boolean(onOpenChapter) : Boolean(onChapterButton));
  const attention = progress.check.state === "issues";
  return (
    <div className="se-todo-wrap">
      <section className="se-todo-card" aria-label={title}>
        <div className="se-todo-card-h">{title}</div>
        <ul className="se-todo-steps">
          {steps.map((step) => (
            <li key={step.key} className={step.done ? "is-done" : ""}>
              <span className="se-todo-mark" aria-hidden="true">{step.done ? "✓" : "○"}</span>
              <span className="se-todo-step-label" title={step.hint}>{step.label}</span>
              <span className={`se-todo-step-text${step.key === "check" && attention ? " is-attention" : ""}`} title={step.text}>{step.text}</span>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="se-todo-primary"
          disabled={busy || !actionable}
          title={primary.kind in STEP_HINTS ? STEP_HINTS[primary.kind as keyof typeof STEP_HINTS] : undefined}
          onClick={onPrimary}
        >
          {busy && busyCaption ? busyCaption : primary.label}
        </button>
      </section>
      {children}
    </div>
  );
}
