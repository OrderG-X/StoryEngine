/**
 * 稿纸顶上的「本章梗概」：点开看全，展开后作者点「改」就地改写（长篇实跑：记账员把方向记反了，定稿后没处改）。
 * 改＝「确认改账」同一个结构化动作（作者档裁定 chapter.summary，改前存档、可撤销），不经模型。
 */
import { useState } from "react";
import type { AgentUserAction } from "../../../api/agentChatClient.js";
import { InlineEdit } from "./bibleEdit.js";

/** 同一章同一句话点两次只记一次；换了说法就是新的一次。 */
function textKey(text: string): string {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0;
  return hash.toString(36);
}

export function synopsisAction(chapter: number, text: string): Extract<AgentUserAction, { readonly toolName: "ledger_decision" }> {
  return {
    toolName: "ledger_decision",
    key: `synopsis-${chapter}-${textKey(text)}`,
    decisions: [{ type: "chapter.summary", chapter, text }],
    label: `改第 ${chapter} 章的梗概`,
  };
}

export function ChapterSynopsis({ chapter, text, busy, onAction }: {
  readonly chapter: number;
  readonly text: string;
  readonly busy: boolean;
  readonly onAction?: (action: AgentUserAction) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  if (editing && onAction) {
    return (
      <div className="cd-synopsis is-open is-editing">
        <b>本章梗概</b>
        <InlineEdit value={text} wrap label="改本章梗概" disabled={busy}
          onSave={(next) => {
            onAction(synopsisAction(chapter, next));
            setEditing(false);
          }}
          onCancel={() => setEditing(false)} />
      </div>
    );
  }
  return (
    <div className={`cd-synopsis${open ? " is-open" : ""}`}>
      <button type="button" className="cd-synopsis-text" aria-expanded={open} title={open ? "收起" : text} onClick={() => setOpen((value) => !value)}>
        <b>本章梗概</b>
        <span>{text}</span>
      </button>
      {open && onAction ? <button type="button" className="cd-synopsis-edit" disabled={busy} onClick={() => setEditing(true)}>改</button> : null}
    </div>
  );
}
