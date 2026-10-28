/**
 * SettleCard —— 「定论」卡（P12「前文一次定死」）：核账卡上点「以第 N 章为准」、设定本「查前文」、对话里说「以这个为准」都出这张。
 *
 * 上面一句定论；下面按章列要改的句子（原句划掉 → 新句），每句右边 × 划掉不改；设定本、账里跟着改的另列。
 * 主按钮「确认」= 一条作者档命令一次改齐（改前存档、能撤销）；没要改的句子只「记下定论」。
 * 改齐了按钮收起，标题旁写「改齐了」（改了什么对话里那句说了，卡上不再说一遍）。没查全如实说，给「重新查」。
 * 「不改了」= 整张不要（长篇实跑：作者发现是自己记错了，说「这张不要了」，卡上「确认」还一直亮着）；能撤回。
 */
import { useState } from "react";
import { StepCard } from "./StepCard.js";
import type { AgentUserAction } from "../../../api/agentChatClient.js";
import type { SettleCardData } from "../../../type-defs/workspace.js";
import { useChatStore } from "../../../stores/chatStore.js";

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
  /** 划掉 / 恢复；改齐了就不给。 */
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

export function SettleCard({ messageId, data, excluded = [], applied, dropped = false, busy, onAction }: {
  readonly messageId: string;
  readonly data: SettleCardData;
  readonly excluded?: readonly string[];
  /** 改齐了：服务端回的那句结果（有它 = 改齐了）。 */
  readonly applied?: string;
  /** 作者点了「不改了」。 */
  readonly dropped?: boolean;
  readonly busy: boolean;
  readonly onAction?: (action: AgentUserAction) => void;
}) {
  const setExcluded = useChatStore((s) => s.setSettleExcluded);
  const setDropped = useChatStore((s) => s.setSettleDropped);
  const [factsOpen, setFactsOpen] = useState(false);
  const skip = new Set(excluded);
  const done = Boolean(applied);
  const off = !done && dropped;
  const toggle = (key: string) => (done || off || !onAction ? undefined : () => setExcluded(messageId, key, !skip.has(key)));
  const editsLeft = data.edits.filter((edit) => !skip.has(edit.key)).length;
  const fieldsLeft = data.fields.filter((field) => !skip.has(field.key)).length;
  const changes = editsLeft + fieldsLeft;
  const recordsCanon = !data.canonExists && !data.sceneOnly;
  const canConfirm = !done && !off && Boolean(onAction) && (changes > 0 || recordsCanon);
  const recheck = () => onAction?.({ toolName: "settle_preview", statement: data.canon, ...(data.chapter ? { chapter: data.chapter } : {}) });
  const incomplete = data.failures.length > 0 || data.missed.length > 0;
  // 只记定论、哪儿都没改：说「记下了」，不说「改齐了」（换题材长篇实跑第 22 章）。
  const doneLabel = data.edits.length + data.fields.length + data.facts.length > 0 ? "改齐了" : "记下了";
  const statusLabel = done ? doneLabel : off ? "不改了" : data.edits.length > 0 ? `${data.edits.length} 句要改` : data.fields.length > 0 ? `设定 ${data.fields.length} 栏要改` : "没查出要改的";
  return (
    <StepCard title={data.sceneOnly ? "改齐" : "定论"} status={done || off ? "done" : changes > 0 ? "attention" : "done"} statusLabel={statusLabel} defaultOpen keepOpen={canConfirm}>
      <p className="stc-canon serif">{data.canon}</p>
      {data.canonExists ? <p className="drc-summary">设定本里已经记着这条。</p> : null}
      {data.sceneOnly ? <p className="drc-summary">只是那一场的事，改句子，不记进设定本。</p> : null}
      {data.replaces && recordsCanon ? <p className="drc-summary">换掉设定本里原来那条：{data.replaces}</p> : null}
      {off ? null : groupByChapter(data.edits).map((group) => (
        <section key={`${group.chapter}:${group.draft}`} className="stc-group">
          <h4>第 {group.chapter} 章{group.draft ? "（工作稿）" : ""}</h4>
          <ul className="stc-list">
            {group.edits.map((edit) => (
              <Row key={edit.key} from={edit.from} to={edit.to} {...(edit.why ? { why: edit.why } : {})} excluded={skip.has(edit.key)} disabled={busy} onToggle={toggle(edit.key)} />
            ))}
          </ul>
        </section>
      ))}
      {!off && data.fields.length > 0 ? (
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
      {!off && data.facts.length > 0 ? (
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
      {off ? (
        <p className="drc-summary">不改了，书里没动。{onAction ? <> <button type="button" className="se-sm-link" disabled={busy} onClick={() => setDropped(messageId, false)}>撤回</button></> : null}</p>
      ) : null}
      {!done && !off && incomplete ? (
        <p className="drc-summary stc-warn">
          {data.missed.length > 0 ? `核账报的${data.missed.length > 1 ? ` ${data.missed.length} 句` : "那句"}（${[...new Set(data.missed.map((item) => `第 ${item.chapter} 章`))].join("、")}）这次没查出改法。` : ""}
          {data.failures.length > 0 ? `没查全：${data.failures.join("；")}。` : ""}
          {onAction ? <> <button type="button" className="se-sm-link" disabled={busy} onClick={recheck}>重新查</button></> : null}
        </p>
      ) : null}
      {canConfirm ? (
        <div className="cpc-actions">
          <span className="cpc-counts">{changes > 0 ? `改 ${changes} 处，改前存档、能撤销` : data.replaces ? "换掉设定本里原来那条定论" : "记进设定本「定论」"}</span>
          <button type="button" className="se-sm-link stc-drop" disabled={busy} onClick={() => setDropped(messageId, true)}>不改了</button>
          <button
            type="button"
            className="cpc-confirm"
            disabled={busy}
            onClick={() => onAction!({ toolName: "settle_apply", token: data.token, excluded: [...skip] })}
          >
            {changes > 0 ? "确认" : data.replaces ? "换掉旧的" : "记下定论"}
          </button>
        </div>
      ) : null}
    </StepCard>
  );
}
