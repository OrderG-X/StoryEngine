/**
 * 稿纸顶上的「本章梗概」：点开看全，展开后作者点「改」就地改写（长篇实跑：记账员把方向记反了，定稿后没处改）。
 * 改＝直接改账（ledger.change，作者档裁定 chapter.summary，改前存档、可撤销），不经模型。
 */
import { useState } from "react";
import { newLedgerAction, type AgentUserAction } from "../../../api/agentChatClient.js";
import { InlineEdit } from "./bibleEdit.js";

/** 改梗概：直接改账（ledger.change，作者档、改前存档可撤销）。改的和现在一样，服务端如实说不用改。 */
export function synopsisAction(chapter: number, text: string): AgentUserAction {
  return newLedgerAction([{ op: "summary", chapter, text }]);
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
