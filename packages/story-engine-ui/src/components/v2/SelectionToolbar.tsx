import { useState } from "react";
import { VISIBLE_SELECTION_REVISION_TEMPLATES, type SelectionRevisionKey } from "./selectionRevisionTemplates.js";

/**
 * 选区浮动操作条（阶段三块②）：在编辑器里选中一段正文时浮出。
 * 6 个固定预设按钮 + 一个「自己说」入口（+ 可选「问 AI」）——点它就地变成输入行，让用户交代具体改写要求。
 *
 * 选区跟踪/定位/改写动作在 WritingPaper + useWorkflowActions 里；WritingPaper 的 selection 由
 * 编辑器 state（ProseMirror）驱动、不受点击工具条影响，故输入态下选区不丢、工具条不消失。
 * 容器 onMouseDown + preventDefault：避免按下按钮时浏览器先清掉编辑器选区（拿不到 targetText）；
 * 唯独输入框用 stopPropagation 隔离，使容器的 preventDefault 不挡住它聚焦。
 */
/** 按钮悬停说明（给作者看的话；problemSummary 是写给模型的，不拿来当提示）。 */
const SELECTION_BUTTON_HINTS: Readonly<Partial<Record<SelectionRevisionKey, string>>> = {
  polish: "不改意思，让这段读起来更顺",
  rewrite: "意思不变，换一种写法",
  deai: "去掉套话和机器腔",
  expand: "补细节，写得更丰满",
  condense: "删掉啰嗦的地方，写得更紧凑",
  continue: "顺着这段往下写一小段",
};

export default function SelectionToolbar({ top, left, busyKey, askOnly = false, onPick, onPickCustom, onAsk }: {
  readonly top: number;
  readonly left: number;
  readonly busyKey: SelectionRevisionKey | null;
  /** 只出「问 AI」（定稿章节不能就地改写时）。 */
  readonly askOnly?: boolean;
  readonly onPick: (key: SelectionRevisionKey) => void;
  readonly onPickCustom?: (instruction: string) => void;
  /** 「问 AI」：不改稿，把选中段引用进右侧输入框，跟 AI 聊这段。 */
  readonly onAsk?: () => void;
}) {
  const busy = busyKey !== null;
  const [customMode, setCustomMode] = useState(false);
  const [text, setText] = useState("");

  const closeCustom = (): void => {
    setCustomMode(false);
    setText("");
  };
  const submit = (): void => {
    const instruction = text.trim();
    if (!instruction || busy) return;
    onPickCustom?.(instruction);
    closeCustom();
  };

  return (
    <div
      className="se-v2-selection-toolbar"
      style={{ top: `${top}px`, left: `${left}px` }}
      role="toolbar"
      aria-label="选区改写"
      onMouseDown={(event) => event.preventDefault()}
    >
      {customMode ? (
        <>
          <input
            className="se-v2-selection-toolbar-input"
            type="text"
            autoFocus
            value={text}
            disabled={busy}
            placeholder="想怎么改？例：写紧张点 / 删掉心理描写 / 让对话更冲"
            aria-label="改写要求"
            style={{ minWidth: 220, fontSize: 13, padding: "3px 6px" }}
            // stopPropagation：阻止事件冒到容器的 preventDefault，否则输入框无法聚焦。
            onMouseDown={(event) => event.stopPropagation()}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); submit(); }
              else if (event.key === "Escape") { event.preventDefault(); closeCustom(); }
            }}
          />
          <button
            type="button"
            className="se-v2-selection-toolbar-btn"
            disabled={busy || text.trim().length === 0}
            onMouseDown={(event) => { event.preventDefault(); submit(); }}
          >
            {busy ? "…" : "改"}
          </button>
          <button
            type="button"
            className="se-v2-selection-toolbar-btn"
            disabled={busy}
            onMouseDown={(event) => { event.preventDefault(); closeCustom(); }}
          >
            返回
          </button>
        </>
      ) : (
        <>
          {askOnly ? null : VISIBLE_SELECTION_REVISION_TEMPLATES.map((template) => (
            <button
              key={template.key}
              className="se-v2-selection-toolbar-btn"
              type="button"
              disabled={busy}
              aria-busy={busyKey === template.key}
              title={SELECTION_BUTTON_HINTS[template.key] ?? template.label}
              onMouseDown={(event) => {
                event.preventDefault();
                if (!busy) onPick(template.key);
              }}
            >
              {busyKey === template.key ? "…" : template.label}
            </button>
          ))}
          {askOnly ? null : <button
            type="button"
            className="se-v2-selection-toolbar-btn"
            disabled={busy}
            title="自己说想怎么改"
            onMouseDown={(event) => {
              event.preventDefault();
              if (!busy) setCustomMode(true);
            }}
          >
            自己说
          </button>}
          {onAsk ? (
            <button
              type="button"
              className="se-v2-selection-toolbar-btn"
              disabled={busy}
              title="不改稿，把这段引用到右边跟 AI 聊"
              onMouseDown={(event) => {
                event.preventDefault();
                if (!busy) onAsk();
              }}
            >
              问 AI
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
