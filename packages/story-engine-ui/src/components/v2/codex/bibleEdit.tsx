/**
 * 设定本的就地编辑小件（重构 P9）：点一下就改、改完存，空着存 = 删掉这一项。
 * 只管输入，不管存哪：存什么由上层拼成 ops 交给 POST /api/cards（作者档，可撤销）。
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { BibleAppearances, BibleFact, CardAuthor } from "../../../api/bibleClient.js";

/** 一处就地编辑：单行回车存，多行 ⌘/Ctrl+回车存，Esc 取消。 */
export function InlineEdit({ value, multiline, placeholder, label, disabled, onSave, onCancel }: {
  readonly value: string;
  readonly multiline?: boolean;
  readonly placeholder?: string;
  /** 读屏用的名字。 */
  readonly label: string;
  readonly disabled?: boolean;
  readonly onSave: (next: string) => void;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const save = () => {
    if (disabled) return;
    if (draft.trim() === value.trim()) onCancel();
    else onSave(draft.trim());
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    } else if (event.key === "Enter" && !event.nativeEvent.isComposing && (!multiline || event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      save();
    }
  };
  return (
    <span className={`se-bk-edit${multiline ? " is-multi" : ""}`}>
      {multiline ? (
        <textarea ref={ref} value={draft} rows={Math.min(8, Math.max(2, draft.split("\n").length))} placeholder={placeholder} aria-label={label}
          onChange={(event) => setDraft(event.target.value)} onKeyDown={onKeyDown} />
      ) : (
        <input ref={ref} value={draft} placeholder={placeholder} aria-label={label}
          onChange={(event) => setDraft(event.target.value)} onKeyDown={onKeyDown} />
      )}
      <span className="se-bk-edit-acts">
        <button type="button" className="se-bk-btn is-primary" disabled={disabled} onClick={save}>存</button>
        <button type="button" className="se-bk-btn" onClick={onCancel}>算了</button>
      </span>
    </span>
  );
}

/** AI 补的标记：作者点「认下」就算自己的（之后 AI 改要作者点头）。 */
export function AiMark({ by, disabled, onAccept }: { readonly by: CardAuthor; readonly disabled?: boolean; readonly onAccept?: () => void }) {
  if (by !== "ai") return null;
  return (
    <span className="se-bk-ai">
      AI 补
      {onAccept ? <button type="button" className="se-bk-link" disabled={disabled} onClick={onAccept}>认下</button> : null}
    </span>
  );
}

export interface FieldItem {
  readonly label: string;
  readonly value: string;
  readonly by: CardAuthor;
}

/** 「标签：内容」一组：点内容就改，× 删，AI 补的可以认下；底下「+ 加一项」给常用标签当快捷。 */
export function FieldList({ fields, suggestions, disabled, onSet, onAccept, emptyText }: {
  readonly fields: readonly FieldItem[];
  readonly suggestions: readonly string[];
  readonly disabled?: boolean;
  readonly onSet: (label: string, value: string) => void;
  readonly onAccept: (label: string) => void;
  readonly emptyText?: string;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <div className="se-bk-fields">
      {fields.length === 0 && emptyText ? <p className="se-bk-empty">{emptyText}</p> : null}
      {fields.length > 0 ? (
        <dl>
          {fields.map((field) => (
            <div key={field.label} className="se-bk-field">
              <dt>{field.label}</dt>
              <dd>
                {editing === field.label ? (
                  <InlineEdit value={field.value} multiline label={field.label} disabled={disabled}
                    onSave={(next) => { setEditing(null); onSet(field.label, next); }} onCancel={() => setEditing(null)} />
                ) : (
                  <>
                    <button type="button" className="se-bk-value" disabled={disabled} title="点一下改" onClick={() => setEditing(field.label)}>{field.value}</button>
                    <AiMark by={field.by} disabled={disabled} onAccept={() => onAccept(field.label)} />
                    <button type="button" className="se-bk-x" disabled={disabled} aria-label={`删掉「${field.label}」`} onClick={() => onSet(field.label, "")}>×</button>
                  </>
                )}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      <AddField taken={fields.map((field) => field.label)} suggestions={suggestions} disabled={disabled} onAdd={onSet} />
    </div>
  );
}

function AddField({ taken, suggestions, disabled, onAdd }: {
  readonly taken: readonly string[];
  readonly suggestions: readonly string[];
  readonly disabled?: boolean;
  readonly onAdd: (label: string, value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState<string | null>(null);
  const [custom, setCustom] = useState("");
  const free = suggestions.filter((item) => !taken.includes(item));
  const close = () => { setOpen(false); setLabel(null); setCustom(""); };
  if (!open) {
    return <button type="button" className="se-bk-add" disabled={disabled} onClick={() => setOpen(true)}>+ 加一项</button>;
  }
  if (label) {
    return (
      <div className="se-bk-adding">
        <span className="se-bk-adding-label">{label}</span>
        <InlineEdit value="" multiline label={label} placeholder="写上内容" disabled={disabled}
          onSave={(value) => { if (value) onAdd(label, value); close(); }} onCancel={close} />
      </div>
    );
  }
  return (
    <div className="se-bk-adding">
      <div className="se-bk-chips">
        {free.map((item) => <button key={item} type="button" className="se-bk-chip" onClick={() => setLabel(item)}>{item}</button>)}
        <input className="se-bk-chip-input" value={custom} placeholder="自己起个名" aria-label="新一项的名字" maxLength={20}
          onChange={(event) => setCustom(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing && custom.trim()) setLabel(custom.trim());
            if (event.key === "Escape") close();
          }} />
        <button type="button" className="se-bk-link" onClick={close}>算了</button>
      </div>
    </div>
  );
}

/** 账里记的：出场章、定下的、现状。每条带第几章，有原句的点一下回正文那一句。 */
export function LedgerNotes({ appearances, fixed, now, onJump }: {
  readonly appearances?: BibleAppearances;
  readonly fixed: readonly BibleFact[];
  readonly now: readonly BibleFact[];
  readonly onJump?: (chapter: number, quote: string) => void;
}) {
  if (!appearances && fixed.length === 0 && now.length === 0) return null;
  return (
    <div className="se-bk-ledger">
      <h4>账里记的</h4>
      {appearances ? <p className="se-bk-appear">{appearanceText(appearances)}</p> : null}
      <FactGroup title="定下的" facts={fixed} {...(onJump ? { onJump } : {})} />
      <FactGroup title="现在" facts={now} {...(onJump ? { onJump } : {})} />
    </div>
  );
}

export function appearanceText(appearances: BibleAppearances): string {
  const span = appearances.first === appearances.last ? `第 ${appearances.first} 章` : `第 ${appearances.first}–${appearances.last} 章`;
  const pov = appearances.viewpointChapters > 0 ? `，${appearances.viewpointChapters} 章是这个人的视角` : "";
  return `出场 ${span}，共 ${appearances.chapters.length} 章${pov}`;
}

const FACTS_VISIBLE = 6;

function FactGroup({ title, facts, onJump }: { readonly title: string; readonly facts: readonly BibleFact[]; readonly onJump?: (chapter: number, quote: string) => void }) {
  const [all, setAll] = useState(false);
  if (facts.length === 0) return null;
  const shown = all ? facts : facts.slice(0, FACTS_VISIBLE);
  return (
    <div className="se-bk-facts">
      <h5>{title}</h5>
      <ul>
        {shown.map((fact, index) => (
          <li key={`${fact.attribute}-${fact.chapter}-${index}`}>
            <span className="se-bk-fact"><b>{fact.attribute}</b>：{fact.value}</span>
            {fact.quote && onJump ? (
              <button type="button" className="se-bk-ch" title={`「${fact.quote}」`} onClick={() => onJump(fact.chapter, fact.quote!)}>第 {fact.chapter} 章</button>
            ) : <span className="se-bk-ch is-plain">第 {fact.chapter} 章</span>}
          </li>
        ))}
      </ul>
      {facts.length > shown.length ? <button type="button" className="se-bk-link" onClick={() => setAll(true)}>再看 {facts.length - shown.length} 条</button> : null}
    </div>
  );
}

/** 两步删除：先点「删」，再点「确定删」。 */
export function ConfirmButton({ label, confirmLabel, disabled, onConfirm }: {
  readonly label: string;
  readonly confirmLabel: string;
  readonly disabled?: boolean;
  readonly onConfirm: () => void;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) return <button type="button" className="se-bk-link is-danger" disabled={disabled} onClick={() => setAsking(true)}>{label}</button>;
  return (
    <span className="se-bk-confirm">
      <button type="button" className="se-bk-btn is-danger" disabled={disabled} onClick={() => { setAsking(false); onConfirm(); }}>{confirmLabel}</button>
      <button type="button" className="se-bk-btn" onClick={() => setAsking(false)}>算了</button>
    </span>
  );
}
