/**
 * 设定本（重构 P9）：故事设定、写作规则、人物、关系、物品、地点、还没建卡。
 *
 * 数据是设定视图（GET /api/bible）：卡上是作者定的（不会变的），「账里记的」是定稿时记账员记的（会变的、按最新一章）。
 * 作者在这里直接改，一次改动一步、可撤销（POST /api/cards，作者档）；AI 补的标「AI 补」，作者可以认下。
 * 账里有、卡里没有的列在「还没建卡」：是人物还是地方，作者点了算，不猜。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { saveCards, type BibleEntry, type BibleView, type CardKind, type CardOp, type UncardedEntry, type WritingRules } from "../../../api/bibleClient.js";
import { AiMark, ConfirmButton, FieldList, FieldValue, InlineEdit, LedgerNotes, type FieldItem } from "./bibleEdit.js";
import { Avatar, PresenceStrip, RelationGraph, firstGlyph } from "./bibleVisual.js";

export type BibleCat = "story" | "rules" | "chars" | "relations" | "items" | "places" | "uncarded";

const KIND_NAME: Record<CardKind, string> = { character: "人物", place: "地点", item: "物品", lore: "设定" };
const KIND_CAT: Record<CardKind, BibleCat> = { character: "chars", place: "places", item: "items", lore: "story" };

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
  readonly reload: () => void;
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
}

export function BibleBook(props: BibleBookProps) {
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ readonly ok: boolean; readonly text: string } | null>(null);
  useEffect(() => setNotice(null), [props.cat]);

  const save = async (ops: readonly CardOp[], after?: () => void): Promise<boolean> => {
    if (ops.length === 0 || saving) return false;
    setSaving(true);
    const result = await saveCards(props.projectPath, ops);
    setSaving(false);
    if (!result.ok) {
      setNotice({ ok: false, text: result.error });
      return false;
    }
    setNotice(result.lines.length > 0 ? { ok: true, text: `${result.lines.join("；")}。可在操作历史里撤销。` } : { ok: true, text: "没有变化。" });
    props.reload();
    props.onChanged?.();
    after?.();
    return true;
  };

  if (!props.bible) {
    return (
      <section className="se-bk" aria-label="设定本">
        {props.error ? (
          <p className="se-sm-error">{props.error} <button type="button" className="se-sm-link" onClick={props.reload}>再读一次</button></p>
        ) : <p className="se-sm-empty">正在读…</p>}
      </section>
    );
  }
  const ctx = pageContext(props, props.bible, props.busy || saving, save);
  return (
    <section className="se-bk" aria-label="设定本">
      {props.busy ? <p className="se-bk-note">AI 正在忙，等它做完再改。</p> : null}
      {notice ? <p className={`se-bk-notice${notice.ok ? "" : " is-error"}`} role="status">{notice.text}</p> : null}
      {props.cat === "story" ? <StoryPage ctx={ctx} /> : null}
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

function PageHead({ title, sub }: { readonly title: string; readonly sub?: string }) {
  return (
    <header className="se-sm-top">
      <h2 className="se-sm-h">{title}</h2>
      {sub ? <p className="se-sm-sum">{sub}</p> : null}
    </header>
  );
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
      onSet={(next) => void ctx.save([{ op: "story.set", label, value: next }])}
      onAccept={() => void ctx.save([{ op: "story.accept", label }])} />
  );
  return (
    <>
      <PageHead title="故事设定" />
      <div className={`se-bk-hero${hero?.by === "ai" ? " is-ai" : ""}`}>
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
                <span className="se-bk-k">{label}</span>
                {value(label, field)}
              </span>
            );
          })}
        </div>
      </div>
      <FieldList
        fields={rest}
        taken={[STORY_HERO, ...STORY_CHIPS]}
        suggestions={FIELD_SUGGESTIONS.story}
        disabled={ctx.disabled}
        onSet={(label, next) => void ctx.save([{ op: "story.set", label, value: next }])}
        onAccept={(label) => void ctx.save([{ op: "story.accept", label }])}
      />
      <CardsPage ctx={ctx} kind="lore" entries={ctx.bible.lore} nested />
    </>
  );
}

/* ── 写作规则 ── */

function RulesPage({ ctx }: { readonly ctx: PageContext }) {
  const rules = ctx.bible.rules;
  const hasAi = rulesHaveAi(rules);
  const setScalar = (field: "perspective" | "notes" | "targetWords" | "minWords", value: string | number | null) =>
    void ctx.save([{ op: "rules.set", field, value }]);
  const ruleList = (list: RuleListKey, variant: RuleVariant) => (
    <RuleList title={RULE_LIST_NAME[list]} variant={variant} items={rules[list]} disabled={ctx.disabled}
      onAdd={(text) => void ctx.save([{ op: "rules.add", list, text }])}
      onRemove={(text) => void ctx.save([{ op: "rules.remove", list, text }])} />
  );
  return (
    <>
      <PageHead title="写作规则" sub="写稿、核账、去 AI 味都照这里。" />
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
  readonly onSave: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return <InlineEdit value={value} multiline={multiline} placeholder={placeholder} label={label} disabled={disabled}
      onSave={(next) => { setEditing(false); onSave(next); }} onCancel={() => setEditing(false)} />;
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
  readonly onAdd: (text: string) => void;
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
          onSave={(text) => { setAdding(false); if (text) onAdd(text); }} onCancel={() => setAdding(false)} />
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
          onSave={(text) => { setAdding(false); if (text) void ctx.save([{ op: "exemplar.add", text }]); }} onCancel={() => setAdding(false)} />
      ) : <button type="button" className="se-bk-add" disabled={ctx.disabled} onClick={() => setAdding(true)}>+ 贴一段</button>}
    </div>
  );
}

/* ── 一类卡：人物 / 物品 / 地点 / 设定。一张卡一格，点开占满一行 ── */

const FILTER_FROM = 8;

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
  const uncarded = kind === "character" ? ctx.bible.uncarded.filter((entry) => entry.character).length : 0;
  const pending = entries.filter(hasAi).length;
  const openName = (name: string) => {
    if (entries.some((entry) => entry.card.name === name)) setOpen(name);
    else ctx.openName(name);
  };

  const head = nested ? (
    <h3 className="se-bk-subhead">其他设定{entries.length > 0 ? <small> {entries.length}</small> : null}</h3>
  ) : (
    <PageHead title={kindName} sub={entries.length > 0 ? `${entries.length} 张卡${pending > 0 ? `，${pending} 张有 AI 补的待认下` : ""}` : `还没有${kindName}卡。`} />
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
  useEffect(() => { if (open) self.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" }); }, [open]);
  const firstField = card.fields[0];
  return (
    <article ref={self} className={`se-bk-card${open ? " is-open" : ""}${card.by === "ai" ? " is-ai" : ""}${card.protagonist ? " is-hero" : ""}`}>
      <button type="button" className="se-bk-card-head" aria-expanded={open} onClick={onToggle}>
        <Avatar name={card.name} kind={card.kind} large={open} />
        <span className="se-bk-card-id">
          <span className="se-bk-card-title">
            <span className="se-bk-name">{card.name}</span>
            {card.protagonist ? <span className="se-bk-tag is-hero">主角</span> : null}
            {card.by === "ai" ? <span className="se-bk-tag">AI 补</span> : null}
          </span>
          {open ? null : firstField ? (
            <span className="se-bk-peek" title={`${firstField.label}：${firstField.value}`}>{firstField.value}</span>
          ) : <span className="se-bk-peek is-empty">还没写</span>}
        </span>
        {entry.appearances ? <span className="se-bk-count">{entry.appearances.chapters.length} 章</span> : null}
        {!open && entry.appearances ? <PresenceStrip chapters={entry.appearances.chapters} total={ctx.total} /> : null}
      </button>
      {open ? (
        <div className="se-bk-card-body">
          <div className="se-bk-card-acts">
            {renaming ? (
              <InlineEdit value={card.name} label="改名" disabled={ctx.disabled}
                onSave={(name) => { setRenaming(false); if (name) void ctx.save([{ op: "card.rename", card: card.id, name }]); }}
                onCancel={() => setRenaming(false)} />
            ) : <button type="button" className="se-bk-link" disabled={ctx.disabled} onClick={() => setRenaming(true)}>改名</button>}
            {card.kind === "character" && !card.protagonist ? (
              <button type="button" className="se-bk-link" disabled={ctx.disabled} onClick={() => void ctx.save([{ op: "card.protagonist", card: card.id }])}>设为主角</button>
            ) : null}
            {hasAi(entry) ? (
              <button type="button" className="se-bk-link" disabled={ctx.disabled} onClick={() => void ctx.save([{ op: "field.accept", card: card.id }])}>全部认下</button>
            ) : null}
            <ConfirmButton label="删卡" confirmLabel={`确定删「${card.name}」`} disabled={ctx.disabled}
              onConfirm={() => void ctx.save([{ op: "card.delete", card: card.id }])} />
          </div>
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
                onSave={(alias) => { setAddingAlias(false); if (alias) void ctx.save([{ op: "card.aliases", card: card.id, add: [alias] }]); }}
                onCancel={() => setAddingAlias(false)} />
            ) : <button type="button" className="se-bk-link" disabled={ctx.disabled} onClick={() => setAddingAlias(true)}>+ 别名</button>}
          </div>
          <FieldList
            fields={card.fields}
            suggestions={FIELD_SUGGESTIONS[card.kind]}
            disabled={ctx.disabled}
            onSet={(label, value) => void ctx.save([{ op: "field.set", card: card.id, label, value }])}
            onAccept={(label) => void ctx.save([{ op: "field.accept", card: card.id, label }])}
          />
          {entry.relations.length > 0 ? (
            <div className="se-bk-rel">
              <h4>关系</h4>
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
      <PageHead title="关系" sub={relations.length > 0 ? `${relations.length} 条` : "还没记关系。"} />
      {relations.length > 0 ? (
        <RelationGraph relations={relations} kindOf={ctx.kindOf} onOpen={ctx.openName} {...(ctx.bible.protagonist ? { center: ctx.bible.protagonist } : {})} />
      ) : null}
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
                  onSave={(next) => { setEditing(null); void ctx.save([{ op: "relation.set", a: relation.a, b: relation.b, label: next }]); }}
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
  const entries = ctx.bible.uncarded;
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
      <PageHead title="还没建卡" sub={entries.length > 0 ? `定稿时账里记下的，${entries.length} 个还没有卡。建了卡，写稿和核账就按卡上写的来。` : "账里记下的都有卡了。"} />
      {entries.length >= FILTER_FROM ? (
        <div className="se-bk-toolbar">
          <input className="se-bk-filter" type="search" value={query} placeholder="找…" aria-label="找还没建卡的" onChange={(event) => setQuery(event.target.value)} />
        </div>
      ) : null}
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
    </>
  );
}
