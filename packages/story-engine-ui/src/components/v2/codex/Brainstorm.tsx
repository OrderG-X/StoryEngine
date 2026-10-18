/**
 * 头脑风暴（重构 P6 第 5 步，草图 ⑤）：稿纸上方「第 N 章往哪走？」。
 *
 *  - 空章：一行想法输入 +【给我几种走法】→ brainstorm_chapter 结构化动作（章纲员出、核账员核，结果进对话）。
 *  - 有走法卡：几张走法并排（几步、推进哪些线索、核过前文对不对得上），【用这个】挑一种；【再来几种】换一批。
 *  - 挑中以后收成一条「这章打算」：照着自己写，或【让 AI 照这个起草】（generate_draft 带这条方向）；【换一种】撤回。
 * 挑选只记在对话里的那张卡上（picked），不进账；没挑中的不留痕。「写这一章」按钮也照挑中的那种写。
 */
import { useEffect, useState, type FormEvent } from "react";
import type { AgentUserAction } from "../../../api/agentChatClient.js";
import type { BrainstormCardData, BrainstormOptionData } from "../../../type-defs/workspace.js";
import { useChatStore } from "../../../stores/chatStore.js";
import { useChapterDirections } from "../../../workspace/chapterProgress.js";
import { directionGoal } from "../../../utils/brainstormCard.js";

const NAMES = ["甲", "乙", "丙", "丁", "戊", "己"] as const;

/** 走法的代号：甲 / 乙 / 丙…… */
export function optionName(index: number): string {
  return NAMES[index] ?? String(index + 1);
}

/** 「推进：老周回避（停了 6 章）、外乡人是谁」——停太久的标停了几章。 */
export function advancesText(option: BrainstormOptionData): string {
  return option.threads.map((thread) => (thread.stale && thread.idle > 0 ? `${thread.title}（停了 ${thread.idle} 章）` : thread.title)).join("、");
}

function OptionCard({ option, index, checked, onPick, busy }: {
  readonly option: BrainstormOptionData;
  readonly index: number;
  readonly checked: boolean;
  readonly onPick: () => void;
  readonly busy: boolean;
}) {
  const advances = advancesText(option);
  return (
    <article className={`se-bs-opt${option.recommended ? " is-rec" : ""}`} aria-label={`${optionName(index)} · ${option.title}`}>
      <header className="se-bs-opt-h">
        <h3>{optionName(index)} · {option.title}</h3>
        {option.recommended ? <span className="se-bs-rec">推荐</span> : null}
      </header>
      <ol className="se-bs-steps">
        {option.steps.map((step, stepIndex) => <li key={stepIndex}>{step}</li>)}
      </ol>
      {advances ? <p className="se-bs-adv">推进：{advances}</p> : null}
      {option.problems.length > 0 ? (
        <ul className="se-bs-problems" aria-label="和前文对不上">
          {option.problems.map((problem, problemIndex) => (
            <li key={problemIndex}>
              <span>第 {problem.step} 步和第 {problem.earlierChapter} 章对不上：{problem.reason}</span>
              {problem.earlierQuote ? <q className="serif">{problem.earlierQuote}</q> : null}
            </li>
          ))}
        </ul>
      ) : checked ? <p className="se-bs-ok">核过前文：对得上</p> : null}
      <button type="button" className={`se-bs-pick${option.recommended ? " is-primary" : ""}`} disabled={busy} onClick={onPick}>用这个</button>
    </article>
  );
}

function IdeaForm({ initial, label, busy, onSubmit }: {
  readonly initial: string;
  readonly label: string;
  readonly busy: boolean;
  readonly onSubmit: (idea: string) => void;
}) {
  const [idea, setIdea] = useState(initial);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!busy) onSubmit(idea.trim());
  };
  return (
    <form className="se-bs-form" onSubmit={submit}>
      <label className="se-bs-sr" htmlFor="se-bs-idea">你的想法</label>
      <input
        id="se-bs-idea"
        type="text"
        value={idea}
        maxLength={500}
        placeholder="你的想法（可以不填）：比如「这章别急着揭底」"
        onChange={(event) => setIdea(event.target.value)}
      />
      <button type="submit" disabled={busy}>{label}</button>
    </form>
  );
}

export function BrainstormPanel({ chapter, draftEmpty, hidden, busy, onAction }: {
  readonly chapter: number;
  /** 稿纸是空的（还没写）：没有走法卡时才露「往哪走」这一块。 */
  readonly draftEmpty: boolean;
  /** 已定稿 / 正在出稿：整块不出。 */
  readonly hidden: boolean;
  readonly busy: boolean;
  readonly onAction?: (action: AgentUserAction) => void;
}) {
  const directions = useChapterDirections(chapter);
  const setPicked = useChatStore((s) => s.setDirectionPicked);
  const [asked, setAsked] = useState(false);
  const [folded, setFolded] = useState(false);
  const [stepsOpen, setStepsOpen] = useState(false);

  // 换章：收起、展开都回到默认。
  useEffect(() => {
    setAsked(false);
    setFolded(false);
    setStepsOpen(false);
  }, [chapter]);
  // 想完了（不再忙）就不再显示「在想」。
  useEffect(() => {
    if (!busy) setAsked(false);
  }, [busy]);
  // 来了新的一批走法：展开给作者看。
  useEffect(() => {
    if (directions) setFolded(false);
  }, [directions?.messageId]);

  if (hidden || !onAction) return null;

  const brainstorm = (idea: string, avoid?: readonly string[]) => {
    setAsked(true);
    onAction({ toolName: "brainstorm_chapter", chapter, ...(idea ? { idea } : {}), ...(avoid && avoid.length > 0 ? { avoid } : {}) });
  };
  const thinking = asked && busy;

  if (!directions) {
    if (!draftEmpty) return null;
    return (
      <section className="se-bs is-ask" aria-label="往哪走">
        <div className="se-bs-top">
          <h2>第 {chapter} 章往哪走？</h2>
          <p>{thinking ? "章纲员在读前文想走法，核账员接着对前文，要一两分钟……" : "章纲员读过前文，给你几种走法挑；也可以直接在下面写，或点「写这一章」。"}</p>
        </div>
        <IdeaForm initial="" label={thinking ? "在想…" : "给我几种走法"} busy={busy} onSubmit={(idea) => brainstorm(idea)} />
      </section>
    );
  }

  const data: BrainstormCardData = directions.data;
  const picked = directions.picked !== undefined ? data.options[directions.picked] : undefined;

  if (picked) {
    const index = directions.picked!;
    return (
      <section className="se-bs is-picked" aria-label="这章打算">
        <div className="se-bs-plan">
          <button type="button" className="se-bs-plan-h" aria-expanded={draftEmpty || stepsOpen} onClick={() => setStepsOpen((open) => !open)}>
            <b>这章打算</b>
            <span>{optionName(index)} · {picked.title}</span>
          </button>
          <div className="se-bs-plan-actions">
            {draftEmpty ? (
              <button
                type="button"
                className="se-bs-pick is-primary"
                disabled={busy}
                onClick={() => onAction({ toolName: "generate_draft", chapter, chapterGoal: directionGoal(picked) })}
              >
                让 AI 照这个起草
              </button>
            ) : null}
            <button type="button" className="se-bs-link" disabled={busy} onClick={() => setPicked(directions.messageId, null)}>换一种</button>
          </div>
        </div>
        {draftEmpty || stepsOpen ? (
          <>
            <ol className="se-bs-steps">
              {picked.steps.map((step, stepIndex) => <li key={stepIndex}>{step}</li>)}
            </ol>
            {draftEmpty ? <p className="se-bs-note">照这个自己在下面写也行。没挑中的不会记进账里。</p> : null}
          </>
        ) : null}
      </section>
    );
  }

  if (folded) {
    return (
      <section className="se-bs is-folded" aria-label="往哪走">
        <button type="button" className="se-bs-plan-h" aria-expanded={false} onClick={() => setFolded(false)}>
          <b>第 {chapter} 章往哪走</b>
          <span>有 {data.options.length} 种走法，点开挑</span>
        </button>
      </section>
    );
  }

  return (
    <section className="se-bs" aria-label="往哪走">
      <div className="se-bs-top">
        <h2>第 {chapter} 章往哪走？</h2>
        <p>
          {thinking
            ? "章纲员在换一批走法……"
            : `章纲员给了 ${data.options.length} 种走法${data.idea ? `（照你说的「${data.idea}」）` : ""}${data.checked ? "，核账员替每种对过前文" : ""}。挑一种，没挑中的不会记进账里。`}
        </p>
        {data.checkNote ? <p className="se-bs-warn">{data.checkNote}</p> : null}
        {data.coldNote ? <p className="se-bs-faint">{data.coldNote}</p> : null}
        <button type="button" className="se-bs-link se-bs-fold" onClick={() => setFolded(true)}>收起</button>
      </div>
      <div className="se-bs-grid">
        {data.options.map((option, index) => (
          <OptionCard
            key={`${directions.messageId}-${index}`}
            option={option}
            index={index}
            checked={data.checked}
            busy={busy}
            onPick={() => setPicked(directions.messageId, index)}
          />
        ))}
      </div>
      <IdeaForm
        key={directions.messageId}
        initial={data.idea ?? ""}
        label={thinking ? "在想…" : "再来几种"}
        busy={busy}
        onSubmit={(idea) => brainstorm(idea, data.options.map((option) => option.title))}
      />
    </section>
  );
}

/** 对话里那张小卡：几种走法的名字；挑过的标出来。细节在稿纸上方。 */
export function DirectionsCard({ data, picked }: { readonly data: BrainstormCardData; readonly picked?: number }) {
  return (
    <div className="se-dir-card" role="group" aria-label={`第 ${data.chapter} 章的走法`}>
      <div className="se-dir-h">第 {data.chapter} 章 · {data.options.length} 种走法</div>
      <ul>
        {data.options.map((option, index) => (
          <li key={index} className={picked === undefined ? "" : picked === index ? "is-picked" : "is-dim"}>
            <span>{optionName(index)} · {option.title}</span>
            {picked === index ? <em>用了这个</em> : option.recommended && picked === undefined ? <em>推荐</em> : null}
            {option.problems.length > 0 ? <small>和前文对不上 {option.problems.length} 处</small> : null}
          </li>
        ))}
      </ul>
      <div className="se-dir-f">{picked === undefined ? "在稿纸上方挑。" : "没挑中的不会记进账里。"}</div>
    </div>
  );
}
