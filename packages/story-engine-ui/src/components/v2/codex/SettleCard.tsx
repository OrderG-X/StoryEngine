/**
 * SettleCard —— 「定论」卡（P12「前文一次定死」；写作版本 P2a 片 3C 起是 canon.propose 停下等作者点时的样子）：
 * 核账卡上点「以第 N 章为准」、设定本「查前文」、对话里说「以这个为准」都出这张。
 *
 * 上面一句定论；下面按章列要改的句子（原句划掉 → 新句），每句右边 × 划掉不改；设定本、账里跟着改的另列。
 * 主按钮「确认」= 一条作者档命令一次改齐（改前存档、能撤销）；没要改的句子只「记下定论」。没查全如实说，给「重新查」。
 * 「不改了」= 整张不要（这次操作停掉，书里没动）。
 */
import { useState } from "react";
import { StepCard } from "./StepCard.js";
import type { SettleCardData } from "../../../type-defs/workspace.js";

type Edit = SettleCardData["edits"][number];

function groupByChapter(edits: readonly Edit[]): { readonly chapter: number; readonly draft: boolean; readonly edits: readonly Edit[] }[] {
  const groups = new Map<string, { chapter: number; draft: boolean; edits: Edit[] }>();
  for (const edit of edits) {
    const key = `${edit.chapter}:${edit.draft ? "d" : "c"}`;
    const group = groups.get(key) ?? { chapter: edit.chapter, draft: edit.draft, edits: [] };
    group.edits.push(edit);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.chapter - b.chapter || Number(a.draft) - Number(b.draft));
}

function Row({ from, to, why, excluded, disabled, onToggle }: {
  readonly from: string;
  readonly to: string;
  readonly why?: string;
  readonly excluded: boolean;
  readonly disabled: boolean;
  /** 划掉 / 恢复；没给就不能划。 */
  readonly onToggle: (() => void) | undefined;
}) {
  return (
    <li className={`stc-row${excluded ? " is-excluded" : ""}`}>
      <div className="stc-change">
        <p className="stc-from serif">{from}</p>
        <p className="stc-to serif">{to}</p>
        {why ? <p className="stc-why">{why}</p> : null}
      </div>
      {onToggle ? (
        <button type="button" className="stc-x" disabled={disabled} aria-label={excluded ? "改回来：这句也改" : "这句不改"} title={excluded ? "这句也改" : "这句不改"} onClick={onToggle}>
          {excluded ? "↺" : "×"}
        </button>
      ) : null}
    </li>
  );
}

export function SettleCard({ data, excluded, busy, onToggle, onConfirm, onDrop, onRecheck }: {
  readonly data: SettleCardData;
  /** 作者划掉不改的几处（key）。 */
  readonly excluded: readonly string[];
  readonly busy: boolean;
  /** 划掉 / 改回来一处；没给就不能划。 */
  readonly onToggle?: (key: string) => void;
  readonly onConfirm?: () => void;
  readonly onDrop?: () => void;
  readonly onRecheck?: () => void;
}) {
  const [factsOpen, setFactsOpen] = useState(false);
  const skip = new Set(excluded);
  const toggle = (key: string) => (onToggle ? () => onToggle(key) : undefined);
  const editsLeft = data.edits.filter((edit) => !skip.has(edit.key)).length;
  const fieldsLeft = data.fields.filter((field) => !skip.has(field.key)).length;
  const changes = editsLeft + fieldsLeft;
  const recordsCanon = !data.canonExists && !data.sceneOnly;
  const canConfirm = Boolean(onConfirm) && (changes > 0 || recordsCanon);
  const incomplete = data.failures.length > 0 || data.missed.length > 0;
  const statusLabel = data.edits.length > 0 ? `${data.edits.length} 句要改` : data.fields.length > 0 ? `设定 ${data.fields.length} 栏要改` : "没查出要改的";
  return (
    <StepCard title={data.sceneOnly ? "改齐" : "定论"} status={changes > 0 ? "attention" : "done"} statusLabel={statusLabel} defaultOpen keepOpen={canConfirm}>
      <p className="stc-canon serif">{data.canon}</p>
      {data.canonExists ? <p className="drc-summary">设定本里已经记着这条。</p> : null}
      {data.sceneOnly ? <p className="drc-summary">只是那一场的事，改句子，不记进设定本。</p> : null}
      {data.replaces && recordsCanon ? <p className="drc-summary">换掉设定本里原来那条：{data.replaces}</p> : null}
      {groupByChapter(data.edits).map((group) => (
        <section key={`${group.chapter}:${group.draft}`} className="stc-group">
          <h4>第 {group.chapter} 章{group.draft ? "（工作稿）" : ""}</h4>
          <ul className="stc-list">
            {group.edits.map((edit) => (
              <Row key={edit.key} from={edit.from} to={edit.to} {...(edit.why ? { why: edit.why } : {})} excluded={skip.has(edit.key)} disabled={busy} onToggle={toggle(edit.key)} />
            ))}
          </ul>
        </section>
      ))}
      {data.fields.length > 0 ? (
        <section className="stc-group">
          <h4>设定本</h4>
          <ul className="stc-list">
            {data.fields.map((field) => (
              <Row key={field.key} from={`${field.card ? `${field.card} · ` : ""}${field.label}：${field.from || "（空）"}`} to={field.to}
                excluded={skip.has(field.key)} disabled={busy} onToggle={toggle(field.key)} />
            ))}
          </ul>
        </section>
      ) : null}
      {data.facts.length > 0 ? (
        <>
          <button type="button" className="chip stc-facts-toggle" aria-expanded={factsOpen} onClick={() => setFactsOpen((open) => !open)}>
            {factsOpen ? "收起" : `账里跟着改 ${data.facts.length} 条`}
          </button>
          {factsOpen ? (
            <ul className="stc-facts">
              {data.facts.map((fact, index) => (
                <li key={index}>第 {fact.chapter} 章：{fact.before}{fact.after ? ` → ${fact.after}` : "（作废）"}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
      {incomplete ? (
        <p className="drc-summary stc-warn">
          {data.missed.length > 0 ? `核账报的${data.missed.length > 1 ? ` ${data.missed.length} 句` : "那句"}（${[...new Set(data.missed.map((item) => `第 ${item.chapter} 章`))].join("、")}）这次没查出改法。` : ""}
          {data.failures.length > 0 ? `没查全：${data.failures.join("；")}。` : ""}
          {onRecheck ? <> <button type="button" className="se-sm-link" disabled={busy} onClick={onRecheck}>重新查</button></> : null}
        </p>
      ) : null}
      {canConfirm || onDrop ? (
        <div className="cpc-actions">
          <span className="cpc-counts">{changes > 0 ? `改 ${changes} 处，改前存档、能撤销` : data.replaces ? "换掉设定本里原来那条定论" : recordsCanon ? "记进设定本「定论」" : "要改的都划掉了"}</span>
          {onDrop ? <button type="button" className="se-sm-link stc-drop" disabled={busy} onClick={onDrop}>不改了</button> : null}
          {canConfirm ? (
            <button type="button" className="cpc-confirm" disabled={busy} onClick={onConfirm}>
              {changes > 0 ? "确认" : data.replaces ? "换掉旧的" : "记下定论"}
            </button>
          ) : null}
        </div>
      ) : null}
    </StepCard>
  );
}
