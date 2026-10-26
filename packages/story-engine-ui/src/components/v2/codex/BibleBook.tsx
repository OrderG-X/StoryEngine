/**
 * 设定本（重构 P9）：故事设定、定论（P12）、写作规则、人物、关系、物品、地点、还没建卡。
 *
 * 数据是设定视图（GET /api/bible）：卡上是作者定的（不会变的），「账里记的」是定稿时记账员记的（会变的、按最新一章）。
 * 作者在这里直接改，一次改动一步、可撤销（POST /api/cards，作者档）；AI 补的标「AI 补」，作者可以认下。
 * 账里有、卡里没有的列在「还没建卡」：是人物还是地方，作者点了算，不猜。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentUserAction } from "../../../api/agentChatClient.js";
import { saveCards, type BibleEntry, type BibleView, type CardKind, type CardOp, type UncardedEntry, type WritingRules } from "../../../api/bibleClient.js";
import { AiMark, closeAfter, ConfirmButton, FieldList, FieldValue, InlineEdit, LedgerNotes, type FieldItem } from "./bibleEdit.js";
import { Avatar, PageHead, PresenceStrip, RelationGraph, Sec, Skeleton, firstGlyph } from "./bibleVisual.js";
import { scrollBehavior } from "../../../stores/motionStore.js";

export type BibleCat = "story" | "canon" | "rules" | "chars" | "relations" | "items" | "places" | "uncarded";

const KIND_NAME: Record<CardKind, string> = { character: "人物", place: "地点", item: "物品", lore: "设定" };
const KIND_CAT: Record<CardKind, BibleCat> = { character: "chars", place: "places", item: "items", lore: "story" };

/** 一类设定在设定本哪一页（核账卡「改设定卡」翻过去用）：故事设定和其他设定都在故事设定页。 */
export function bibleCatOf(kind: CardKind | "story" | "canon"): BibleCat {
  return kind === "story" || kind === "canon" ? kind : KIND_CAT[kind];
}

/** 常用标签当快捷（作者想起什么标签都行）。「一句话」「题材」和书架、开书概况认的栏名一致。 */
const FIELD_SUGGESTIONS: Record<CardKind | "story", readonly string[]> = {
  story: ["一句话", "题材", "基调", "主线冲突", "核心谜团", "世界规矩", "时代背景", "结局方向"],
  character: ["身份", "年龄", "性别", "外貌", "性格", "说话方式", "来历", "想要什么", "怕什么", "底线"],
  place: ["样子", "在哪", "规矩", "来历"],
  item: ["样子", "用处", "规矩", "来历"],
  lore: ["内容", "规矩", "例外"],
};

/** 故事设定页顶上的扉页：「一句话」放大，「题材」「基调」做成小签（和 FIELD_SUGGESTIONS 里的栏名一致，按栏名摆，不看内容）。 */
const STORY_HERO = "一句话";
const STORY_CHIPS: readonly string[] = ["题材", "基调"];

const RULE_LIST_NAME = { style: "文风", musts: "一定要做到", bans: "一定不要写", avoid: "别用的说法" } as const;
type RuleListKey = keyof typeof RULE_LIST_NAME;

export interface BibleBookProps {
  readonly cat: BibleCat;
  readonly projectPath: string;
  readonly bible: BibleView | null;
  readonly error: string | null;
  readonly reload: () => Promise<void> | void;
  /** AI 在跑：先别改（跑完设定本会自己刷新）。 */
  readonly busy: boolean;
  /** 打开时先展开哪张卡（正文里名字速览点「在设定本中打开」）。 */
  readonly focusName?: string;
  readonly onJump?: (chapter: number, quote: string) => void;
  /** 改成了：外面刷新开书概况（主角、待处理跟着变）。 */
  readonly onChanged?: () => void;
  /** 跳到别的分类（还没建卡 → 建好的卡）。 */
  readonly onOpenCat?: (cat: BibleCat, name?: string) => void;
  /** 全书到第几章（出场条的长度）；不给就按账里记到的最后一章。 */
  readonly chapterCount?: number;
  /** 书名（故事设定扉页上）。 */
  readonly bookTitle?: string;
  /** 定论页「查前文」：在右边对话里出一张定论卡（P12）。 */
  readonly onAction?: (action: AgentUserAction) => void;
}

const NOTICE_MS = 5000;

export function BibleBook(props: BibleBookProps) {
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ readonly ok: boolean; readonly text: string } | null>(null);
  useEffect(() => setNotice(null), [props.cat]);
  // 存成了的提示几秒后自己收起（没存成的留着，等作者看清原因、点 ×）。
  useEffect(() => {
    if (!notice?.ok) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const save = async (ops: readonly CardOp[], after?: () => void): Promise<boolean> => {
    if (ops.length === 0 || saving) return false;
    setSaving(true);
    const result = await saveCards(props.projectPath, ops);
    setSaving(false);
    if (!result.ok) {
      setNotice({ ok: false, text: result.error });
      return false;
    }
    const said = result.lines.join("；");
    // 末一条以整句引文收尾（「……。」）就不再补句号，免得「。」。」。
    const stop = ["。」", "！」", "？」"].some((end) => said.endsWith(end)) ? "" : "。";
    setNotice(result.lines.length > 0 ? { ok: true, text: `${said}${stop}可在操作历史里撤销。` } : { ok: true, text: "没有变化。" });
    const reloaded = props.reload();
    props.onChanged?.();
    // 重读回来再收起编辑框：先收起会闪一下改前的字。
    await reloaded;
    after?.();
    return true;
  };

  if (!props.bible) {
    return (
      <section className="se-bk" aria-label="设定本">
        {props.error ? (
          <p className="se-sm-error">{props.error} <button type="button" className="se-sm-link" onClick={props.reload}>再读一次</button></p>
        ) : <Skeleton />}
      </section>
    );
  }
  const ctx = pageContext(props, props.bible, props.busy || saving, save);
  return (
    <section className="se-bk" aria-label="设定本">
      {props.busy ? <p className="se-bk-note">AI 正在忙，等它做完再改。</p> : null}
      {notice ? (
        // 浮在页顶、不占地方：占地方的话一出来下面整页往下挪，作者接着点就点歪了。
        <div className="se-bk-notice-pin">
          <div className={`se-bk-notice${notice.ok ? "" : " is-error"}`}>
            <p role="status">{notice.text}</p>
            <button type="button" className="se-bk-notice-x" aria-label="关掉提示" onClick={() => setNotice(null)} />
          </div>
        </div>
      ) : null}
      {props.cat === "story" ? <StoryPage ctx={ctx} /> : null}
      {props.cat === "canon" ? <CanonPage ctx={ctx} /> : null}
      {props.cat === "rules" ? <RulesPage ctx={ctx} /> : null}
      {props.cat === "chars" ? <CardsPage ctx={ctx} kind="character" entries={ctx.bible.characters} /> : null}
      {props.cat === "relations" ? <RelationsPage ctx={ctx} /> : null}
      {props.cat === "items" ? <CardsPage ctx={ctx} kind="item" entries={ctx.bible.items} /> : null}
      {props.cat === "places" ? <CardsPage ctx={ctx} kind="place" entries={ctx.bible.places} /> : null}
      {props.cat === "uncarded" ? <UncardedPage ctx={ctx} /> : null}
    </section>
  );
}

interface PageContext extends BibleBookProps {
  readonly bible: BibleView;
  readonly disabled: boolean;
  readonly save: (ops: readonly CardOp[], after?: () => void) => Promise<boolean>;
  /** 出场条的长度。 */
  readonly total: number;
  readonly kindOf: (name: string) => CardKind;
  /** 打开某张卡（可能在别的分类）。 */
  readonly openName: (name: string) => void;
}

function pageContext(props: BibleBookProps, bible: BibleView, disabled: boolean, save: PageContext["save"]): PageContext {
  const cards = [...bible.characters, ...bible.places, ...bible.items, ...bible.lore];
  const kinds = new Map(cards.map((entry) => [entry.card.name, entry.card.kind] as const));
  const lastSeen = [...cards, ...bible.uncarded].map((entry) => entry.appearances?.last ?? 0);
  const kindOf = (name: string): CardKind => kinds.get(name) ?? "character";
  return {
    ...props,
    bible,
    disabled,
    save,
    total: Math.max(props.chapterCount ?? 0, 0, ...lastSeen),
    kindOf,
    openName: (name) => { if (kinds.has(name)) props.onOpenCat?.(KIND_CAT[kindOf(name)], name); },
  };
}

/* ── 故事设定：扉页（一句话、题材、基调）+ 其余几栏 + 「设定」类卡 ── */

function blankField(label: string): FieldItem {
  return { label, value: "", by: "author" };
}

function StoryPage({ ctx }: { readonly ctx: PageContext }) {
  const story = ctx.bible.story;
  const [editing, setEditing] = useState<string | null>(null);
  const hero = story.find((field) => field.label === STORY_HERO);
  const rest = story.filter((field) => field.label !== STORY_HERO && !STORY_CHIPS.includes(field.label));
  const value = (label: string, field: FieldItem | undefined) => (
    <FieldValue field={field ?? blankField(label)} editing={editing === label} disabled={ctx.disabled}
      onEdit={() => setEditing(label)} onDone={() => setEditing(null)}
      onSet={(next) => ctx.save([{ op: "story.set", label, value: next }])}
      onAccept={() => void ctx.save([{ op: "story.accept", label }])} />
  );
  return (
    <>
      <PageHead title="故事设定" sub="这本书是什么、世界怎么转。写稿和核账都先看这里。" />
      <div className={`se-bk-hero${hero?.by === "ai" ? " is-ai" : ""}`} data-mark={ctx.bookTitle ? firstGlyph(ctx.bookTitle) : ""}>
        {ctx.bookTitle ? <p className="se-bk-hero-kicker">{ctx.bookTitle}</p> : null}
        <div className="se-bk-hero-line">
          {hero || editing === STORY_HERO ? value(STORY_HERO, hero) : (
            <button type="button" className="se-bk-value is-empty" disabled={ctx.disabled} onClick={() => setEditing(STORY_HERO)}>一句话写下这本书讲什么</button>
          )}
        </div>
        <div className="se-bk-hero-chips">
          {STORY_CHIPS.map((label) => {
            const field = story.find((item) => item.label === label);
            if (!field && editing !== label) {
              return <button key={label} type="button" className="se-bk-hero-add" disabled={ctx.disabled} onClick={() => setEditing(label)}>+ {label}</button>;
            }
            return (
              <span key={label} className={`se-bk-hero-chip${editing === label ? " is-editing" : ""}${field?.by === "ai" ? " is-ai" : ""}`}>
                <b>{label}</b>
                <span className="se-bk-hero-chip-v">{value(label, field)}</span>
              </span>
            );
          })}
        </div>
      </div>
      <Sec title="其余几栏" count={rest.length} />
      <FieldList
        fields={rest}
        taken={[STORY_HERO, ...STORY_CHIPS]}
        suggestions={FIELD_SUGGESTIONS.story}
        disabled={ctx.disabled}
        onSet={(label, next) => ctx.save([{ op: "story.set", label, value: next }])}
        onAccept={(label) => void ctx.save([{ op: "story.accept", label }])}
      />
      <CardsPage ctx={ctx} kind="lore" entries={ctx.bible.lore} nested />
    </>
  );
}

/* ── 定论：前后说法打架时作者定下的，全书以它为准（P12） ── */

function CanonPage({ ctx }: { readonly ctx: PageContext }) {
  const canon = ctx.bible.canon;
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const check = (statement: string) => ctx.onAction?.({ toolName: "settle_preview", statement });
  // 定论是一句话：框子折行好看全，粘进来的换行存的时候并掉。
  const oneLine = (text: string): string => text.replace(/\s*\n+\s*/gu, "");
  return (
    <>
      <PageHead title="定论" sub="前后说法打架时你定下的。写稿、核账都以它为准。" stats={[{ value: canon.length, label: "条" }]} />
      <div className="se-bk-panel">
        {canon.length > 0 ? (
          <ul className="se-bk-canon">
            {canon.map((item) => (
              <li key={item.id}>
                {editing === item.id ? (
                  <InlineEdit value={item.text} wrap label="改这条定论" placeholder="一句话说清" disabled={ctx.disabled}
                    onSave={(raw) => { const text = oneLine(raw); closeAfter(text && text !== item.text ? ctx.save([{ op: "canon.set", canon: item.id, text }]) : undefined, () => setEditing(null)); }}
                    onCancel={() => setEditing(null)} />
                ) : (
                  <button type="button" className="se-bk-value serif" disabled={ctx.disabled} onClick={() => setEditing(item.id)}>{item.text}</button>
                )}
                <footer>
                  {ctx.onAction ? (
                    <button type="button" className="se-bk-link" disabled={ctx.disabled} title="查全书哪几句和它对不上" onClick={() => check(item.text)}>查前文</button>
                  ) : null}
                  <ConfirmButton label="删" confirmLabel="确定删" disabled={ctx.disabled} onConfirm={() => void ctx.save([{ op: "canon.set", canon: item.id, text: "" }])} />
                </footer>
              </li>
            ))}
          </ul>
        ) : (
          <p className="se-bk-hint">还没有。核账卡上点「以第 N 章为准」，或跟右边的 AI 说「以这个为准」，就记在这里。</p>
        )}
        {adding ? (
          <InlineEdit value="" wrap label="记一条定论" placeholder="一句话说清，比如：主角今年二十九岁" disabled={ctx.disabled}
            onSave={(raw) => { const text = oneLine(raw); closeAfter(text ? ctx.save([{ op: "canon.add", text }]) : undefined, () => setAdding(false)); }} onCancel={() => setAdding(false)} />
        ) : <button type="button" className="se-bk-add" disabled={ctx.disabled} onClick={() => setAdding(true)}>+ 记一条</button>}
      </div>
    </>
  );
}

/* ── 写作规则 ── */

function RulesPage({ ctx }: { readonly ctx: PageContext }) {
  const rules = ctx.bible.rules;
  const hasAi = rulesHaveAi(rules);
  const setScalar = (field: "perspective" | "notes" | "targetWords" | "minWords", value: string | number | null) =>
    ctx.save([{ op: "rules.set", field, value }]);
  const ruleList = (list: RuleListKey, variant: RuleVariant) => (
    <RuleList title={RULE_LIST_NAME[list]} variant={variant} items={rules[list]} disabled={ctx.disabled}
      onAdd={(text) => ctx.save([{ op: "rules.add", list, text }])}
      onRemove={(text) => void ctx.save([{ op: "rules.remove", list, text }])} />
  );
  return (
    <>
      <PageHead title="写作规则" sub="写稿、核账、去 AI 味都照这里。" stats={[
        { value: rules.style.length + rules.musts.length + rules.bans.length + rules.avoid.length, label: "条规则" },
        { value: rules.exemplars.length, label: "段样本" },
      ]} />
      {hasAi ? (
        <p className="se-bk-note">有几条是 AI 补的。<button type="button" className="se-bk-link" disabled={ctx.disabled} onClick={() => void ctx.save([{ op: "rules.accept" }])}>全部认下</button></p>
      ) : null}
      <div className="se-bk-duo">
        <div className="se-bk-panel">
          <h3>视角</h3>
          <ScalarText value={rules.perspective?.value ?? ""} by={rules.perspective?.by} placeholder="比如：第三人称，紧跟主角" label="视角"
            disabled={ctx.disabled} onSave={(value) => setScalar("perspective", value || null)} />
        </div>
        <div className="se-bk-panel">
          <h3>每章字数</h3>
          <div className="se-bk-words">
            <WordsInput label="目标" value={rules.targetWords?.value} disabled={ctx.disabled} onSave={(value) => setScalar("targetWords", value)} />
            <WordsInput label="至少" value={rules.minWords?.value} disabled={ctx.disabled} onSave={(value) => setScalar("minWords", value)} />
          </div>
        </div>
      </div>
      {ruleList("style", "chips")}
      <div className="se-bk-duo">
        {ruleList("musts", "do")}
        {ruleList("bans", "dont")}
      </div>
      {ruleList("avoid", "strike")}
      <div className="se-bk-panel">
        <h3>补充</h3>
        <ScalarText value={rules.notes?.value ?? ""} by={rules.notes?.by} multiline placeholder="别的要求，写一段" label="补充"
          disabled={ctx.disabled} onSave={(value) => setScalar("notes", value || null)} />
      </div>
      <Exemplars ctx={ctx} />
    </>
  );
}

function rulesHaveAi(rules: WritingRules): boolean {
  return [rules.perspective, rules.targetWords, rules.minWords, rules.notes].some((item) => item?.by === "ai")
    || [...rules.style, ...rules.musts, ...rules.bans, ...rules.avoid, ...rules.exemplars].some((item) => item.by === "ai");
}

function ScalarText({ value, by, multiline, placeholder, label, disabled, onSave }: {
  readonly value: string;
  readonly by?: "author" | "ai";
  readonly multiline?: boolean;
  readonly placeholder: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly onSave: (value: string) => Promise<boolean> | void;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return <InlineEdit value={value} multiline={multiline} placeholder={placeholder} label={label} disabled={disabled}
      onSave={(next) => closeAfter(onSave(next), () => setEditing(false))} onCancel={() => setEditing(false)} />;
  }
  return (
    <p className="se-bk-scalar">
      <button type="button" className={`se-bk-value${value ? "" : " is-empty"}`} disabled={disabled} onClick={() => setEditing(true)}>{value || placeholder}</button>
      {by ? <AiMark by={by} /> : null}
    </p>
  );
}

/** 和核心 rules.set 的上限一致：超了核心会拒，在这儿先拦下、退回原值。 */
const WORDS_MAX = 100_000;

function WordsInput({ label, value, disabled, onSave }: {
  readonly label: string;
  readonly value?: number;
  readonly disabled: boolean;
  readonly onSave: (value: number | null) => void;
}) {
  const [draft, setDraft] = useState(value ? String(value) : "");
  useEffect(() => setDraft(value ? String(value) : ""), [value]);
  const commit = () => {
    const trimmed = draft.trim();
    const next = trimmed === "" ? null : Number(trimmed);
    if (next !== null && (!Number.isInteger(next) || next <= 0 || next > WORDS_MAX)) {
      setDraft(value ? String(value) : "");
      return;
    }
    if ((next ?? undefined) !== value) onSave(next);
  };
  return (
    <label className="se-bk-word">
      <span>{label}</span>
      <input inputMode="numeric" maxLength={6} value={draft} disabled={disabled} placeholder="不限" aria-label={`每章${label}字数`}
        onChange={(event) => setDraft(event.target.value.replace(/\D/gu, ""))}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === "Enter") (event.target as HTMLInputElement).blur(); }} />
      <span>字</span>
    </label>
  );
}

/** 规则怎么摆：文风是一串小签，要做到 / 不要写各一栏打勾打叉，别用的说法划掉。 */
type RuleVariant = "chips" | "do" | "dont" | "strike";

function RuleList({ title, variant, items, disabled, onAdd, onRemove }: {
  readonly title: string;
  readonly variant: RuleVariant;
  readonly items: readonly { readonly text: string; readonly by: "author" | "ai" }[];
  readonly disabled: boolean;
  readonly onAdd: (text: string) => Promise<boolean> | void;
  readonly onRemove: (text: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <div className={`se-bk-panel se-bk-rulebox is-${variant}`}>
      <h3>{title}{items.length > 0 ? <small> {items.length}</small> : null}</h3>
      {items.length > 0 ? (
        <ul className={`se-bk-rules is-${variant}`}>
          {items.map((item) => (
            <li key={item.text} className={item.by === "ai" ? "is-ai" : undefined}>
              <span>{item.text}</span>
              <AiMark by={item.by} />
              <button type="button" className="se-bk-x" disabled={disabled} aria-label={`删掉这条：${item.text}`} onClick={() => onRemove(item.text)}>×</button>
            </li>
          ))}
        </ul>
      ) : null}
      {adding ? (
        <InlineEdit value="" label={`加一条${title}`} placeholder="一条一句" disabled={disabled}
          onSave={(text) => closeAfter(text ? onAdd(text) : undefined, () => setAdding(false))} onCancel={() => setAdding(false)} />
      ) : <button type="button" className="se-bk-add" disabled={disabled} onClick={() => setAdding(true)}>+ 加一条</button>}
    </div>
  );
}

function Exemplars({ ctx }: { readonly ctx: PageContext }) {
  const exemplars = ctx.bible.rules.exemplars;
  const [adding, setAdding] = useState(false);
  return (
    <div className="se-bk-panel">
      <h3>文风样本{exemplars.length > 0 ? <small> {exemplars.length}</small> : null}</h3>
      <p className="se-bk-hint">贴一段你自己写的，AI 照它的节奏和用词写。</p>
      {exemplars.length > 0 ? (
        <ul className="se-bk-samples">
          {exemplars.map((item) => (
            <li key={item.id}>
              <p className="serif">{item.text}</p>
              <footer>
                {item.note ? <span>{item.note}</span> : null}
                <AiMark by={item.by} />
                <ConfirmButton label="删" confirmLabel="确定删" disabled={ctx.disabled} onConfirm={() => void ctx.save([{ op: "exemplar.remove", exemplar: item.id }])} />
              </footer>
            </li>
          ))}
        </ul>
      ) : null}
      {adding ? (
        <InlineEdit value="" multiline label="文风样本" placeholder="贴一段原文" disabled={ctx.disabled}
          onSave={(text) => closeAfter(text ? ctx.save([{ op: "exemplar.add", text }]) : undefined, () => setAdding(false))} onCancel={() => setAdding(false)} />
      ) : <button type="button" className="se-bk-add" disabled={ctx.disabled} onClick={() => setAdding(true)}>+ 贴一段</button>}
    </div>
  );
}

/* ── 一类卡：人物 / 物品 / 地点 / 设定。一张卡一格，点开占满一行 ── */

const FILTER_FROM = 8;

/** 页头一句说明。 */
const KIND_LEAD: Record<CardKind, string> = {
  character: "卡上是你定的；账里记的跟着定稿走。",
  place: "故事发生在哪。",
  item: "要紧的东西。",
  lore: "",
};

function hasAi(entry: BibleEntry): boolean {
  return entry.card.by === "ai" || entry.card.fields.some((field) => field.by === "ai");
}

function CardsPage({ ctx, kind, entries, nested }: {
  readonly ctx: PageContext;
  readonly kind: CardKind;
  readonly entries: readonly BibleEntry[];
  /** 嵌在故事设定页下面（标题小一号）。 */
  readonly nested?: boolean;
}) {
  const kindName = KIND_NAME[kind];
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(() => focusedCard(entries, ctx.focusName));
  useEffect(() => {
    const focused = focusedCard(entries, ctx.focusName);
    if (focused) setOpen(focused);
    // 只在要求聚焦的名字变了时跟：作者自己点开别的卡不被拽回。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.focusName]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((entry) => [entry.card.name, ...entry.card.aliases, ...entry.ledgerAliases].some((name) => name.toLowerCase().includes(q)));
  }, [entries, query]);
  const uncarded = kind === "character" ? ctx.bible.uncarded.filter((entry) => entry.character && !entry.skipped).length : 0;
  const pending = entries.filter(hasAi).length;
  const openName = (name: string) => {
    if (entries.some((entry) => entry.card.name === name)) setOpen(name);
    else ctx.openName(name);
  };

  const head = nested ? <Sec title="其他设定" count={entries.length} /> : (
    <PageHead title={kindName} sub={KIND_LEAD[kind]} stats={[
      { value: entries.length, label: "张卡" },
      { value: pending, label: "待认下" },
      ...(kind === "character" ? [{ value: entries.filter((entry) => entry.appearances).length, label: "出过场" }] : []),
    ]} />
  );
  return (
    <div className="se-bk-cards">
      {head}
      <div className="se-bk-toolbar">
        {entries.length >= FILTER_FROM ? (
          <input className="se-bk-filter" type="search" value={query} placeholder={`找${kindName}…`} aria-label={`找${kindName}`}
            onChange={(event) => setQuery(event.target.value)} />
        ) : null}
        {creating ? (
          <InlineEdit value="" label={`新${kindName}的名字`} placeholder="名字" disabled={ctx.disabled}
            onSave={(name) => {
              setCreating(false);
              if (name) void ctx.save([{ op: "card.create", kind, name }], () => setOpen(name));
            }}
            onCancel={() => setCreating(false)} />
        ) : <button type="button" className="se-bk-add" disabled={ctx.disabled} onClick={() => setCreating(true)}>+ 新{kindName}</button>}
        {uncarded > 0 ? (
          <button type="button" className="se-bk-link" onClick={() => ctx.onOpenCat?.("uncarded")}>账里还有 {uncarded} 个人没建卡</button>
        ) : null}
      </div>
      {shown.length === 0 && query ? <p className="se-bk-empty">没找到「{query.trim()}」。</p> : null}
      {entries.length === 0 && !nested ? <p className="se-bk-blank">还没有{kindName}卡。点「+ 新{kindName}」建一张，或者在右边让 AI 补。</p> : null}
      {shown.length > 0 ? (
        <ul className="se-bk-grid">
          {shown.map((entry) => (
            <li key={entry.card.id} className={open === entry.card.name ? "is-open" : undefined}>
              <CardView ctx={ctx} entry={entry} open={open === entry.card.name} onOpenName={openName}
                onToggle={() => setOpen(open === entry.card.name ? null : entry.card.name)} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function focusedCard(entries: readonly BibleEntry[], name: string | undefined): string | null {
  if (!name) return entries.length === 1 ? entries[0]!.card.name : null;
  const hit = entries.find((entry) => [entry.card.name, ...entry.card.aliases, ...entry.ledgerAliases].includes(name));
  return hit?.card.name ?? null;
}

function CardView({ ctx, entry, open, onToggle, onOpenName }: {
  readonly ctx: PageContext;
  readonly entry: BibleEntry;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onOpenName: (name: string) => void;
}) {
  const card = entry.card;
  const [renaming, setRenaming] = useState(false);
  const [addingAlias, setAddingAlias] = useState(false);
  const self = useRef<HTMLElement>(null);
  // 点开的卡占满一行、可能挪了位置：滚到眼前。
  useEffect(() => { if (open) self.current?.scrollIntoView?.({ block: "nearest", behavior: scrollBehavior() }); }, [open]);
  const firstField = card.fields[0];
  const tags = (
    <>
      {card.protagonist ? <span className="se-bk-tag is-hero">主角</span> : null}
      {card.by === "ai" ? <span className="se-bk-tag">AI 补</span> : null}
    </>
  );
  return (
    <article ref={self} className={`se-bk-card${open ? " is-open" : ""}${card.by === "ai" ? " is-ai" : ""}${card.protagonist ? " is-hero" : ""}`}>
      {open ? (
        <header className="se-bk-profile">
          <Avatar name={card.name} kind={card.kind} large />
          <div className="se-bk-profile-id">
            {renaming ? (
              <InlineEdit value={card.name} label="改名" disabled={ctx.disabled}
                onSave={(name) => closeAfter(name ? ctx.save([{ op: "card.rename", card: card.id, name }]) : undefined, () => setRenaming(false))}
                onCancel={() => setRenaming(false)} />
            ) : <div className="se-bk-card-title"><span className="se-bk-name">{card.name}</span>{tags}</div>}
            <div className="se-bk-aliases">
              <span className="se-bk-k">也叫</span>
              {card.aliases.map((alias) => (
                <span key={alias} className="se-bk-alias">
                  {alias}
                  <button type="button" className="se-bk-x" disabled={ctx.disabled} aria-label={`去掉别名「${alias}」`}
                    onClick={() => void ctx.save([{ op: "card.aliases", card: card.id, remove: [alias] }])}>×</button>
                </span>
              ))}
              {entry.ledgerAliases.map((alias) => (
                <button key={alias} type="button" className="se-bk-alias is-ledger" disabled={ctx.disabled} title="账里这么叫过，点一下记成别名"
                  onClick={() => void ctx.save([{ op: "card.aliases", card: card.id, add: [alias] }])}>{alias} +</button>
              ))}
              {addingAlias ? (
                <InlineEdit value="" label="加别名" placeholder="别名" disabled={ctx.disabled}
                  onSave={(alias) => closeAfter(alias ? ctx.save([{ op: "card.aliases", card: card.id, add: [alias] }]) : undefined, () => setAddingAlias(false))}
                  onCancel={() => setAddingAlias(false)} />
              ) : <button type="button" className="se-bk-link" disabled={ctx.disabled} onClick={() => setAddingAlias(true)}>+ 别名</button>}
            </div>
          </div>
          <div className="se-bk-card-acts">
            {renaming ? null : <button type="button" className="se-bk-link" disabled={ctx.disabled} onClick={() => setRenaming(true)}>改名</button>}
            {card.kind === "character" && !card.protagonist ? (
              <button type="button" className="se-bk-link" disabled={ctx.disabled} onClick={() => void ctx.save([{ op: "card.protagonist", card: card.id }])}>设为主角</button>
            ) : null}
            {hasAi(entry) ? (
              <button type="button" className="se-bk-link" disabled={ctx.disabled} onClick={() => void ctx.save([{ op: "field.accept", card: card.id }])}>全部认下</button>
            ) : null}
            <ConfirmButton label="删卡" confirmLabel={`确定删「${card.name}」`} disabled={ctx.disabled}
              onConfirm={() => void ctx.save([{ op: "card.delete", card: card.id }])} />
            <button type="button" className="se-bk-collapse" aria-expanded={true} aria-label={`收起「${card.name}」`} title="收起" onClick={onToggle} />
          </div>
        </header>
      ) : (
        <button type="button" className="se-bk-card-head" aria-expanded={false} onClick={onToggle}>
          <Avatar name={card.name} kind={card.kind} />
          <span className="se-bk-card-id">
            <span className="se-bk-card-title"><span className="se-bk-name">{card.name}</span>{tags}</span>
            {firstField ? (
              <span className="se-bk-peek" title={`${firstField.label}：${firstField.value}`}>{firstField.value}</span>
            ) : <span className="se-bk-peek is-empty">还没写</span>}
          </span>
          {entry.appearances ? <span className="se-bk-count">{entry.appearances.chapters.length} 章</span> : null}
          {entry.appearances ? <PresenceStrip chapters={entry.appearances.chapters} total={ctx.total} /> : null}
        </button>
      )}
      {open ? (
        <div className="se-bk-card-body">
          <Sec title="卡上写的" count={card.fields.length} />
          <FieldList
            fields={card.fields}
            suggestions={FIELD_SUGGESTIONS[card.kind]}
            disabled={ctx.disabled}
            onSet={(label, value) => ctx.save([{ op: "field.set", card: card.id, label, value }])}
            onAccept={(label) => void ctx.save([{ op: "field.accept", card: card.id, label }])}
          />
          {entry.relations.length > 0 ? (
            <div className="se-bk-rel">
              <Sec title="关系" count={entry.relations.length} />
              <ul>
                {entry.relations.map((relation) => (
                  <li key={relation.id}>
                    <button type="button" className="se-bk-relchip" title={`打开「${relation.other}」`} onClick={() => onOpenName(relation.other)}>
                      <Avatar name={relation.other} kind={ctx.kindOf(relation.other)} />
                      <b>{relation.other}</b>
                      <span>{relation.label}</span>
                    </button>
                    <AiMark by={relation.by} />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <LedgerNotes appearances={entry.appearances} fixed={entry.fixed} now={entry.now} total={ctx.total} {...(ctx.onJump ? { onJump: ctx.onJump } : {})} />
        </div>
      ) : null}
    </article>
  );
}

/* ── 关系：上面一张图，下面逐条改 ── */

function RelationsPage({ ctx }: { readonly ctx: PageContext }) {
  const relations = ctx.bible.relations;
  const names = useMemo(() => [...ctx.bible.characters, ...ctx.bible.places, ...ctx.bible.items, ...ctx.bible.lore].map((entry) => entry.card.name), [ctx.bible]);
  const [editing, setEditing] = useState<string | null>(null);
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [label, setLabel] = useState("");
  const canAdd = a && b && a !== b && label.trim() && !ctx.disabled;
  return (
    <>
      <PageHead title="关系" sub={relations.length > 0 ? "点图里的人打开那张卡。" : undefined} stats={[
        { value: relations.length, label: "条关系" },
        { value: relations.filter((relation) => relation.by === "ai").length, label: "待认下" },
      ]} />
      {relations.length === 0 ? <p className="se-bk-blank">还没记关系。在下面选两张卡记一句，或者在右边让 AI 整理。</p> : null}
      {relations.length > 0 ? (
        <RelationGraph relations={relations} kindOf={ctx.kindOf} onOpen={ctx.openName} {...(ctx.bible.protagonist ? { center: ctx.bible.protagonist } : {})} />
      ) : null}
      {relations.length > 0 ? <Sec title="逐条" count={relations.length} /> : null}
      {relations.length > 0 ? (
        <ul className="se-bk-relations">
          {relations.map((relation) => (
            <li key={relation.id} className={relation.by === "ai" ? "is-ai" : undefined}>
              <span className="se-bk-pair">
                <Avatar name={relation.a} kind={ctx.kindOf(relation.a)} /><b>{relation.a}</b>
                <span className="se-bk-pair-sep" aria-hidden="true" />
                <Avatar name={relation.b} kind={ctx.kindOf(relation.b)} /><b>{relation.b}</b>
              </span>
              {editing === relation.id ? (
                <InlineEdit value={relation.label} label={`${relation.a}和${relation.b}的关系`} disabled={ctx.disabled}
                  onSave={(next) => closeAfter(ctx.save([{ op: "relation.set", a: relation.a, b: relation.b, label: next }]), () => setEditing(null))}
                  onCancel={() => setEditing(null)} />
              ) : (
                <>
                  <button type="button" className="se-bk-value" disabled={ctx.disabled} onClick={() => setEditing(relation.id)}>{relation.label}</button>
                  <AiMark by={relation.by} disabled={ctx.disabled} onAccept={() => void ctx.save([{ op: "relation.set", a: relation.a, b: relation.b, label: relation.label }])} />
                  <button type="button" className="se-bk-x" disabled={ctx.disabled} aria-label={`删掉${relation.a}和${relation.b}的关系`}
                    onClick={() => void ctx.save([{ op: "relation.set", a: relation.a, b: relation.b, label: "" }])}>×</button>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {names.length >= 2 ? (
        <form className="se-bk-reladd" onSubmit={(event) => {
          event.preventDefault();
          if (!canAdd) return;
          void ctx.save([{ op: "relation.set", a, b, label: label.trim() }], () => { setLabel(""); });
        }}>
          <select value={a} aria-label="一方" onChange={(event) => setA(event.target.value)}>
            <option value="">选一个</option>
            {names.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
          <span>—</span>
          <select value={b} aria-label="另一方" onChange={(event) => setB(event.target.value)}>
            <option value="">选一个</option>
            {names.filter((name) => name !== a).map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
          <input value={label} placeholder="什么关系，一句话" aria-label="关系" onChange={(event) => setLabel(event.target.value)} />
          <button type="submit" className="se-bk-btn is-primary" disabled={!canAdd}>记下</button>
        </form>
      ) : <p className="se-bk-empty">先建两张卡，才能记关系。</p>}
    </>
  );
}

/* ── 还没建卡：账里有、卡里没有的 ── */

const KIND_ORDER: readonly CardKind[] = ["character", "place", "item", "lore"];

function UncardedPage({ ctx }: { readonly ctx: PageContext }) {
  // 作者说过不用建卡的收在最底下一行（泛称、群体、物件……不用一条条看着）。
  const entries = useMemo(() => ctx.bible.uncarded.filter((entry) => !entry.skipped), [ctx.bible.uncarded]);
  const skipped = useMemo(() => ctx.bible.uncarded.filter((entry) => entry.skipped), [ctx.bible.uncarded]);
  const [showSkipped, setShowSkipped] = useState(false);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? entries.filter((entry) => [entry.name, ...entry.aliases].some((name) => name.toLowerCase().includes(q))) : entries;
  }, [entries, query]);
  const create = (entry: UncardedEntry, kind: CardKind) =>
    void ctx.save([{ op: "card.create", kind, name: entry.name, ...(entry.aliases.length > 0 ? { aliases: [...entry.aliases] } : {}) }]);
  return (
    <>
      <PageHead title="还没建卡" sub="定稿时账里记下、还没有卡的。建了卡，写稿和核账就按卡上写的来。" stats={[
        { value: entries.filter((entry) => entry.character).length, label: "个人" },
        { value: entries.filter((entry) => !entry.character).length, label: "个别的" },
      ]} />
      {entries.length >= FILTER_FROM ? (
        <div className="se-bk-toolbar">
          <input className="se-bk-filter" type="search" value={query} placeholder="找…" aria-label="找还没建卡的" onChange={(event) => setQuery(event.target.value)} />
        </div>
      ) : null}
      {entries.length === 0 ? <p className="se-bk-blank is-done">{skipped.length > 0 ? "要建的都建了。" : "账里记下的都有卡了，没有落下的。"}</p> : null}
      {shown.length > 0 ? (
        <ul className="se-bk-grid">
          {shown.map((entry) => (
            <li key={entry.name} className={open === entry.name ? "is-open" : undefined}>
              <article className={`se-bk-card is-uncarded${open === entry.name ? " is-open" : ""}`}>
                <button type="button" className="se-bk-card-head" aria-expanded={open === entry.name} onClick={() => setOpen(open === entry.name ? null : entry.name)}>
                  <span className="se-bk-av is-ghost" aria-hidden="true">{firstGlyph(entry.name)}</span>
                  <span className="se-bk-card-id">
                    <span className="se-bk-card-title"><span className="se-bk-name">{entry.name}</span></span>
                    {entry.aliases.length > 0 ? <span className="se-bk-peek">也叫 {entry.aliases.join("、")}</span> : null}
                  </span>
                  {entry.appearances ? <span className="se-bk-count">{entry.appearances.chapters.length} 章</span> : null}
                  {open !== entry.name && entry.appearances ? <PresenceStrip chapters={entry.appearances.chapters} total={ctx.total} /> : null}
                </button>
                <div className="se-bk-make">
                  {entry.character ? (
                    <button type="button" className="se-bk-btn" disabled={ctx.disabled} onClick={() => create(entry, "character")}>建人物卡</button>
                  ) : (
                    <>
                      <span className="se-bk-k">建成</span>
                      {KIND_ORDER.map((kind) => (
                        <button key={kind} type="button" className="se-bk-btn" disabled={ctx.disabled} onClick={() => create(entry, kind)}>{KIND_NAME[kind]}</button>
                      ))}
                    </>
                  )}
                  <button type="button" className="se-bk-link se-bk-skip" disabled={ctx.disabled} onClick={() => void ctx.save([{ op: "uncarded.skip", name: entry.name }])}>不用建卡</button>
                </div>
                {open === entry.name ? (
                  <div className="se-bk-card-body">
                    <LedgerNotes appearances={entry.appearances} fixed={entry.fixed} now={entry.now} total={ctx.total} {...(ctx.onJump ? { onJump: ctx.onJump } : {})} />
                  </div>
                ) : null}
              </article>
            </li>
          ))}
        </ul>
      ) : null}
      {skipped.length > 0 ? (
        <div className="se-bk-skipped">
          <button type="button" className="se-bk-link" aria-expanded={showSkipped} onClick={() => setShowSkipped(!showSkipped)}>
            不用建卡的 {skipped.length} 个{showSkipped ? "（收起）" : ""}
          </button>
          {showSkipped ? (
            <ul>
              {skipped.map((entry) => (
                <li key={entry.name}>
                  <span>{entry.name}</span>
                  <button type="button" className="se-bk-link" disabled={ctx.disabled} onClick={() => void ctx.save([{ op: "uncarded.unskip", name: entry.name }])}>放回</button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
