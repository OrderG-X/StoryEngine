/**
 * 稿纸底下的那一个按钮（安静账房 2026-11-03：只留「定稿」；已定稿、账没记上时是「补记账」）。核账、另写几版、写下一章都在对话里说。
 * 按钮是现有的结构化动作，不新增绕过对话的路。
 */
import { STEP_HINTS, type PaperAction } from "../../../workspace/chapterProgress.js";
import type { ChapterButton } from "../../../utils/chapterButtons.js";

export function PaperToolbar({
  action,
  busy,
  onChapterButton,
}: {
  readonly action: PaperAction | undefined;
  readonly busy: boolean;
  readonly onChapterButton?: (button: ChapterButton) => void;
}) {
  if (!action || !onChapterButton) return <span />;
  return (
    <div className="cd-tools" role="toolbar" aria-label="本章动作">
      <button
        type="button"
        className="cd-tools-btn is-primary"
        disabled={busy}
        title={STEP_HINTS[action.button]}
        onClick={() => onChapterButton(action.button)}
      >
        {action.label}
      </button>
    </div>
  );
}
