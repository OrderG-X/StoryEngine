/**
 * 右栏顶上一条「第 N 章」进度（重构 P6，2026-10-22 压成一行）：写 / 核账 / 定稿打勾 + 一个主按钮。
 * 说法和稿纸底下的工具条同源（workspace/chapterProgress）。主按钮按顺序取第一个没做完的：
 * 写这一章 → 核账 → 去看那 N 处 → 定稿 → 去第 N 章（后面第一个没定稿的章）。
 */
import type { ReactNode } from "react";
import { STEP_HINTS, type ChapterProgress } from "../../../workspace/chapterProgress.js";
import type { ChapterButton } from "../../../utils/chapterButtons.js";
import { requestContinuityFocus } from "./ContinuityMarks.js";

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
  const title = progress.commit.done ? `第 ${progress.chapter} 章已定稿` : `第 ${progress.chapter} 章`;
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
        {/* 三步一行：做完打勾；每步的细话（写了多少字、核出几处）悬停看。核出要看的几处直接标在「核账」上。 */}
        <ol className="se-todo-steps">
          {steps.map((step) => (
            <li key={step.key} className={step.done ? "is-done" : ""} title={step.hint ? `${step.text}。${step.hint}` : step.text}>
              <span className="se-todo-mark" aria-hidden="true">{step.done ? "✓" : "○"}</span>
              <span className="se-todo-step-label">{step.label}</span>
              {step.key === "check" && attention ? <span className="se-todo-step-text is-attention">{progress.check.sure} 处</span> : null}
              <span className="sr-only">：{step.text}</span>
            </li>
          ))}
        </ol>
        <button
          type="button"
          className={`se-todo-primary${busy ? " is-busy" : ""}`}
          disabled={busy || !actionable}
          title={primary.kind in STEP_HINTS ? STEP_HINTS[primary.kind as keyof typeof STEP_HINTS] : undefined}
          onClick={onPrimary}
        >
          {busy && busyCaption ? busyCaption : primary.label}
        </button>
      </section>
      {children ? <div className="se-todo-notes">{children}</div> : null}
    </div>
  );
}
