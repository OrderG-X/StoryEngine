/**
 * 改账的规划（写作版本 P2a 片 3B，从 agent/ledger-decisions.ts 挪来）：一次改账请求翻成裁定草案。
 * 只算草案、不写盘；作者点「确认改账」才由 ledger.change 操作按作者档记下（见 recipes/ledger-change.ts）。
 */
import {
  DecisionInput,
  isExact,
  nameKey,
  normalizeForQuote,
  type BookProjection,
  type ChapterLedger,
  type FactView,
  type ItemPlace,
  type ItemPosition,
  type ItemStateRuling,
  type ItemView,
  type LedgerEntry,
  type ThreadView,
} from "@actalk/story-core";
import { itemTexts, stepText, type ItemTexts } from "../../book/item-views.js";
import { storySpanText, WEEKDAY_NAMES } from "../../book/story-timeline.js";

/** 一次最多改几条（卡上摆得下、看得清）。 */
export const MAX_DECISIONS_PER_CHANGE = 20;
/** 作者一次清点最多列几样（完整清点拆不开，超了如实说，不截）。 */
export const MAX_CENSUS_MEMBERS = 100;

export const LEDGER_OPS = [
  "add", "update", "remove", "supersede", "resolve", "group", "importance", "day", "keepDay", "summary",
  "itemMerge", "itemSplit", "itemRetract", "itemState",
] as const;
export type LedgerEditOp = (typeof LEDGER_OPS)[number];

export interface LedgerChangeRequest {
  readonly op: LedgerEditOp;
  readonly id?: string;
  readonly chapter?: number;
  readonly text?: string;
  readonly targetText?: string;
  readonly query?: string;
  readonly importance?: "major" | "normal" | "minor";
  readonly nature?: "hard" | "state" | "event";
  readonly subject?: string;
  readonly attribute?: string;
  readonly value?: string;
  /** group：几组线索，每组第一条留下、其余并进去。 */
  readonly groups?: readonly (readonly string[])[];
  /** day：这一章是故事第几天（到第几天）。 */
  readonly day?: number;
  readonly dayEnd?: number;
  /** itemState：到这一章末这样东西在哪 / 丢了毁了 / 里面是什么（只给一种）。 */
  readonly where?: ItemWhereRequest;
  /** itemState 清点：里面有哪几样（名字；各自可带对齐的旧记录）；complete = 作者说「只有这些」。 */
  readonly members?: readonly ItemMemberRequest[];
  readonly complete?: boolean;
  /**
   * itemState 在哪 / 丢了毁了：旧记法里说它去向的事实（编号或原话），以作者这回定的为准（设计 2.6）。
   * replaces = 只说这一样的那条（顶掉）；overlaps = 一句里说了好几样的那条（留着，只标它以这里为准）。
   */
  readonly replaces?: readonly string[];
  readonly overlaps?: readonly string[];
}

/** 清点里的一样：名字，和它对齐的旧记录（同 replaces / overlaps）。 */
export interface ItemMemberRequest {
  readonly name: string;
  readonly replaces?: readonly string[];
  readonly overlaps?: readonly string[];
}

/** 作者说的去处：谁拿着 / 在哪个地方 / 在哪样东西里面 / 不知道在哪了 / 丢了、毁了。 */
export interface ItemWhereRequest {
  readonly person?: string;
  readonly place?: string;
  readonly inside?: string;
  readonly unknown?: boolean;
  readonly gone?: "lost" | "destroyed";
}

export type LedgerPlanOutcome =
  | { readonly ok: true; readonly decisions: readonly DecisionInput[]; readonly lines: readonly string[] }
  | { readonly ok: false; readonly code: string; readonly reason: string };

const WEIGHT_LABELS = { major: "大伏笔（不许丢）", normal: "普通线索", minor: "小线索（停多久都不提醒）" } as const;

function quoteText(text: string, max = 40): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return `「${flat.length > max ? `${flat.slice(0, max)}…` : flat}」`;
}

function lookup<T>(items: readonly T[], ref: string, idOf: (item: T) => string, textOf: (item: T) => string, what: string):
  | { readonly ok: true; readonly item: T }
  | { readonly ok: false; readonly code: string; readonly reason: string } {
  const trimmed = ref.trim();
  const byId = items.find((item) => idOf(item) === trimmed);
  if (byId) return { ok: true, item: byId };
  const key = nameKey(trimmed);
  if (!key) return { ok: false, code: "missing_target", reason: `没说是哪一条${what}。` };
  const exact = items.filter((item) => nameKey(textOf(item)) === key);
  if (exact.length === 1) return { ok: true, item: exact[0] as T };
  const partial = exact.length > 1 ? exact : items.filter((item) => nameKey(textOf(item)).includes(key));
  if (partial.length === 1) return { ok: true, item: partial[0] as T };
  if (partial.length === 0) return { ok: false, code: "not_found", reason: `账里没找到${quoteText(trimmed)}这条${what}。` };
  const shown = partial.slice(0, 5).map((item) => quoteText(textOf(item))).join("、");
  return { ok: false, code: "ambiguous", reason: `${quoteText(trimmed)}对得上 ${partial.length} 条${what}：${shown}${partial.length > 5 ? " 等" : ""}，请说清是哪一条。` };
}

const findFact = (view: BookProjection, ref: string) =>
  lookup(view.facts.filter((fact) => fact.status !== "retracted"), ref, (fact) => fact.id, (fact) => fact.text, "事实");
const findThread = (view: BookProjection, ref: string, includeClosed = true) =>
  lookup(view.threads.filter((thread) => includeClosed || thread.status !== "closed"), ref, (thread) => thread.id, (thread) => thread.title, "线索");

/**
 * 按编号或名字找东西（叫法也认）：同名几样如实列出来让作者点明（「第 2 章的『表』、第 3 章的『表』」），不猜是哪样（P3b 设计 2.7）。
 */
function findItem(view: BookProjection, ref: string, texts: ItemTexts):
  | { readonly ok: true; readonly item: ItemView }
  | { readonly ok: false; readonly code: string; readonly reason: string } {
  const trimmed = ref.trim();
  const byId = view.items.find((item) => item.id === trimmed || item.mergedFrom.includes(trimmed));
  if (byId) return { ok: true, item: byId };
  const key = nameKey(trimmed);
  if (!key) return { ok: false, code: "missing_target", reason: "没说是哪样东西。" };
  // 同名的认带区分的那个说法（「表（「甲手里攥着…」那件）」，概况、上次的候选里给的就是它）。
  const labelled = view.items.filter((item) => nameKey(texts.label(item.id)) === key);
  if (labelled.length === 1) return { ok: true, item: labelled[0] as ItemView };
  const names = (item: ItemView): string[] => [...(item.name ? [item.name] : []), ...item.mentions].map(nameKey);
  const exact = view.items.filter((item) => names(item).includes(key));
  const found = exact.length > 0 ? exact : view.items.filter((item) => names(item).some((name) => name.includes(key)));
  if (found.length === 1) return { ok: true, item: found[0] as ItemView };
  if (found.length === 0) return { ok: false, code: "not_found", reason: `账里没找到叫${quoteText(trimmed)}的东西（要记它，先在设定本给它建一张物品卡）。` };
  const shown = found.slice(0, 5).map((item) => `「${texts.label(item.id)}」`).join("、");
  return { ok: false, code: "ambiguous", reason: `${quoteText(trimmed)}对得上 ${found.length} 样东西：${shown}${found.length > 5 ? " 等" : ""}，请说清是哪一样。` };
}

type ItemFactLinks = { replaces?: string[]; overlaps?: string[] };

/**
 * 作者说旧记录里它的去向以这回定的为准：按编号或原话找那几条事实（对上多条如实问），只认这一章或更早的（设计 2.6 作者那一支）。
 * 一条事实只说这一样还是一句说了好几样，由作者（经对话 AI）说明，代码不拆。
 */
function itemFactLinks(view: BookProjection, request: { readonly replaces?: readonly string[]; readonly overlaps?: readonly string[] }, chapter: number, label: string):
  | { readonly ok: true; readonly links: ItemFactLinks; readonly said: readonly string[] }
  | { readonly ok: false; readonly code: string; readonly reason: string } {
  const links: ItemFactLinks = {};
  const said: string[] = [];
  for (const key of ["replaces", "overlaps"] as const) {
    for (const ref of request[key] ?? []) {
      const found = findFact(view, ref);
      if (!found.ok) return found;
      const fact = found.item;
      if (fact.chapter > chapter) return { ok: false, code: "later_fact", reason: `${quoteText(fact.text)}记在第 ${fact.chapter} 章，比第 ${chapter} 章晚，没法拿第 ${chapter} 章末的样子去顶它。` };
      const other = key === "replaces" ? links.overlaps : links.replaces;
      if (other?.includes(fact.id)) return { ok: false, code: "conflict", reason: `${quoteText(fact.text)}不能既整条顶掉、又留着只标「${label}」，请说是哪一种。` };
      const list = (links[key] ??= []);
      if (list.includes(fact.id)) continue;
      list.push(fact.id);
      said.push(key === "replaces"
        ? `第 ${fact.chapter} 章的旧记录${quoteText(fact.text)}以这回定的为准，不再算`
        : `第 ${fact.chapter} 章的旧记录${quoteText(fact.text)}留着，其中「${label}」的去向以这回定的为准`);
    }
  }
  return { ok: true, links, said };
}

const mergeLinks = (a: ItemFactLinks, b: ItemFactLinks): ItemFactLinks => {
  const out: ItemFactLinks = {};
  for (const key of ["replaces", "overlaps"] as const) {
    const ids = [...new Set([...(a[key] ?? []), ...(b[key] ?? [])])];
    if (ids.length > 0) out[key] = ids;
  }
  return out;
};

/** 本章东西条目的原句里有没有这几个字（找原句）。 */
const quoteHas = (quote: string | undefined, text: string | undefined): boolean =>
  !text || (quote !== undefined && normalizeForQuote(quote).includes(normalizeForQuote(text)));

const entryQuote = (entry: LedgerEntry): string | undefined => entry.evidence[0]?.quote;

/**
 * 某章账里说到这样东西的每个位置（拆开用）：它自己的条目（主体、清点成员）、别的东西装在 / 从它里面、它的特征事实。
 * 只认投影里现在算它的那几处（并进来的编号也算），已经拆走的不算。
 */
function itemPositions(view: BookProjection, ledgers: readonly ChapterLedger[], item: ItemView, chapter: number, quote?: string): ItemPosition[] {
  const ids = new Set([item.id, ...item.mergedFrom]);
  const entries = new Map((ledgers.find((ledger) => ledger.chapter === chapter)?.entries ?? []).map((entry) => [entry.id, entry] as const));
  const out: ItemPosition[] = [];
  const add = (position: ItemPosition): void => {
    if (!out.some((known) => known.entry === position.entry && known.at === position.at && known.index === position.index)) out.push(position);
  };
  for (const step of [...item.history, ...item.asides]) {
    const entry = step.chapter === chapter ? entries.get(step.entry) : undefined;
    if (entry?.kind !== "item" || !quoteHas(entryQuote(entry), quote)) continue;
    if (ids.has(entry.itemRef.id)) add({ entry: entry.id, at: "item" });
    (entry.members ?? []).forEach((member, index) => {
      if (ids.has(member.id)) add({ entry: entry.id, at: "member", index });
    });
  }
  for (const other of view.items) {
    for (const step of [...other.history, ...other.asides]) {
      const entry = step.chapter === chapter ? entries.get(step.entry) : undefined;
      if (entry?.kind !== "item" || !quoteHas(entryQuote(entry), quote)) continue;
      if (step.to?.kind === "inside" && step.to.item === item.id && entry.to?.kind === "inside" && ids.has(entry.to.ref.id)) add({ entry: entry.id, at: "to" });
      if (step.from?.kind === "inside" && step.from.item === item.id && entry.from?.kind === "inside" && ids.has(entry.from.ref.id)) add({ entry: entry.id, at: "from" });
    }
  }
  for (const fact of view.facts) {
    if (fact.item === item.id && fact.chapter === chapter && fact.status !== "retracted" && quoteHas(fact.quote, quote)) add({ entry: fact.id, at: "subject" });
  }
  return out;
}

function itemPlaceOf(view: BookProjection, where: ItemWhereRequest, texts: ItemTexts):
  | { readonly ok: true; readonly state: ItemStateRuling; readonly text: string }
  | { readonly ok: false; readonly code: string; readonly reason: string } {
  const given = [where.person, where.place, where.inside, where.unknown ? "unknown" : undefined, where.gone].filter((value) => value !== undefined);
  if (given.length !== 1) return { ok: false, code: "missing_where", reason: given.length === 0 ? "它在哪？说一种：谁拿着、在哪个地方、在哪样东西里面、不知道在哪了、丢了或毁了。" : "去处只能说一种。" };
  if (where.gone) return { ok: true, state: { kind: "gone", gone: where.gone }, text: where.gone === "lost" ? "丢了" : "毁了" };
  if (where.unknown) return { ok: true, state: { kind: "at", to: { kind: "unknown" } }, text: "不知道在哪了" };
  if (where.person) return { ok: true, state: { kind: "at", to: { kind: "person", ref: { mention: where.person } } }, text: `${where.person}拿着` };
  if (where.place) return { ok: true, state: { kind: "at", to: { kind: "place", text: where.place } }, text: `在${where.place}` };
  const container = findItem(view, where.inside ?? "", texts);
  if (!container.ok) return container;
  const to: ItemPlace = { kind: "inside", ref: { id: container.item.id } };
  return { ok: true, state: { kind: "at", to }, text: `在${texts.label(container.item.id)}里` };
}

function fail(code: string, reason: string): LedgerPlanOutcome {
  return { ok: false, code, reason };
}

function proposal(decisions: DecisionInput[], lines: string[]): LedgerPlanOutcome {
  return { ok: true, decisions, lines };
}

/**
 * 一次改账请求翻成裁定（在一份投影上算，不写盘）。指向的事实 / 线索按编号或原话查准，查不准如实说、列候选，绝不猜。
 */
export function planOnView(view: BookProjection, request: LedgerChangeRequest, ledgers: readonly ChapterLedger[] = []): LedgerPlanOutcome {
  const latest = view.upTo;

  switch (request.op) {
    case "itemMerge": {
      const texts = itemTexts(view.items);
      const groups = (request.groups ?? []).filter((group) => group.length > 0);
      if (groups.length === 0) return fail("missing_target", "要把哪几样当成同一样？第一样留下，其余并进去。");
      const decisions: DecisionInput[] = [];
      const lines: string[] = [];
      for (const group of groups) {
        const resolved: ItemView[] = [];
        for (const ref of group) {
          const found = findItem(view, ref, texts);
          if (!found.ok) return fail(found.code, found.reason);
          if (!resolved.some((item) => item.id === found.item.id)) resolved.push(found.item);
        }
        const [into, ...from] = resolved;
        if (!into || from.length === 0) return fail("too_few", "至少要两样不同的东西才能并成一样。");
        decisions.push({ type: "item.merge", from: from.map((item) => item.id), into: into.id });
        lines.push(`把${from.map((item) => `「${texts.label(item.id)}」`).join("")}并进「${texts.label(into.id)}」（账里写它的地方都算同一样）`);
      }
      return proposal(decisions, lines);
    }
    case "itemSplit": {
      const texts = itemTexts(view.items);
      const found = findItem(view, request.query ?? request.id ?? "", texts);
      if (!found.ok) return fail(found.code, found.reason);
      const name = request.text?.trim();
      if (!name) return fail("missing_text", "拆出来的那样叫什么？");
      if (request.chapter === undefined) return fail("missing_chapter", `是第几章写的「${texts.label(found.item.id)}」其实是另一样？`);
      const refs = itemPositions(view, ledgers, found.item, request.chapter, request.targetText);
      if (refs.length === 0) return fail("not_found", `第 ${request.chapter} 章的账里没有「${texts.label(found.item.id)}」${request.targetText ? `、原句带${quoteText(request.targetText)}` : ""}的记录。`);
      return proposal(
        [{ type: "item.split", item: found.item.id, refs, name }],
        [`第 ${request.chapter} 章写的「${texts.label(found.item.id)}」（${refs.length} 处）不是那一样，另记成「${name}」`],
      );
    }
    case "itemRetract": {
      const texts = itemTexts(view.items);
      const found = findItem(view, request.query ?? request.id ?? "", texts);
      if (!found.ok) return fail(found.code, found.reason);
      if (request.chapter === undefined) return fail("missing_chapter", `「${texts.label(found.item.id)}」是第几章那条记错了？`);
      const ids = new Set([found.item.id, ...found.item.mergedFrom]);
      const ledger = ledgers.find((item) => item.chapter === request.chapter);
      const steps = [...found.item.history, ...found.item.asides].filter((step) => {
        if (step.chapter !== request.chapter || step.op === "appear") return false;
        const entry = ledger?.entries.find((item) => item.id === step.entry);
        return entry?.kind === "item" && ids.has(entry.itemRef.id) && quoteHas(step.quote, request.targetText);
      });
      const unique = steps.filter((step, index) => steps.findIndex((other) => other.entry === step.entry) === index);
      if (unique.length === 0) return fail("not_found", `第 ${request.chapter} 章没记过「${texts.label(found.item.id)}」${request.targetText ? `原句带${quoteText(request.targetText)}` : ""}的去向。`);
      if (unique.length > 1) {
        const shown = unique.slice(0, 5).map((step) => `${stepText(step, texts)}${step.quote ? quoteText(step.quote, 20) : ""}`).join("；");
        return fail("ambiguous", `第 ${request.chapter} 章记了「${texts.label(found.item.id)}」${unique.length} 条：${shown}，请说是哪一条（说那句原话里的几个字）。`);
      }
      const step = unique[0]!;
      return proposal(
        [{ type: "item.retract", entry: step.entry }],
        [`第 ${request.chapter} 章「${texts.label(found.item.id)}：${stepText(step, texts)}」这条记错了，不算`],
      );
    }
    case "itemState": {
      const texts = itemTexts(view.items);
      const found = findItem(view, request.query ?? request.id ?? "", texts);
      if (!found.ok) return fail(found.code, found.reason);
      const chapter = request.chapter ?? latest;
      if (!view.chapters.some((item) => item.chapter === chapter)) return fail("unknown_chapter", `第 ${chapter} 章还没定稿，东西在哪定稿时记。`);
      let state: ItemStateRuling;
      let said: string;
      let own: ItemFactLinks = {};
      const aligned: string[] = [];
      if (request.members) {
        if (request.members.length > MAX_CENSUS_MEMBERS) return fail("too_many", `一次清点最多列 ${MAX_CENSUS_MEMBERS} 样，这次列了 ${request.members.length} 样。`);
        const members: { id: string; replaces?: string[]; overlaps?: string[] }[] = [];
        for (const ref of request.members) {
          const member = findItem(view, ref.name, texts);
          if (!member.ok) return fail(member.code, member.reason);
          const links = itemFactLinks(view, ref, chapter, texts.label(member.item.id));
          if (!links.ok) return fail(links.code, links.reason);
          aligned.push(...links.said);
          const existing = members.find((item) => item.id === member.item.id);
          const merged = mergeLinks(existing ?? {}, links.links);
          // 同一样写了两遍、两遍对同一条旧记录给的说法不一样：如实问，不合成两种都要。
          const both = merged.replaces?.find((id) => merged.overlaps?.includes(id));
          if (both !== undefined) return fail("conflict", `${quoteText(view.facts.find((fact) => fact.id === both)?.text ?? "那条旧记录")}不能既整条顶掉、又留着只标「${texts.label(member.item.id)}」，请说是哪一种。`);
          if (existing) Object.assign(existing, merged);
          else members.push({ id: member.item.id, ...merged });
        }
        const complete = request.complete === true;
        state = { kind: "census", members, complete };
        const listed = members.map((member) => texts.label(member.id)).join("、");
        said = complete ? (members.length > 0 ? `里面只有${listed}` : "里面空了") : `里面有${listed}（没说只有这些）`;
      } else {
        const where = itemPlaceOf(view, request.where ?? {}, texts);
        if (!where.ok) return fail(where.code, where.reason);
        state = where.state;
        said = where.text;
        const links = itemFactLinks(view, request, chapter, texts.label(found.item.id));
        if (!links.ok) return fail(links.code, links.reason);
        own = links.links;
        aligned.push(...links.said);
      }
      return proposal(
        [{ type: "item.state", item: found.item.id, chapter, state, ...own }],
        [`到第 ${chapter} 章末，「${texts.label(found.item.id)}」${said}（以你定的为准）${aligned.length > 0 ? `；${aligned.join("；")}` : ""}`],
      );
    }
    case "add": {
      if (!request.text?.trim()) return fail("missing_text", "要记的事实是什么？请说一句具体可核对的话。");
      const chapter = request.chapter ?? latest;
      if (!view.chapters.some((item) => item.chapter === chapter)) return fail("unknown_chapter", `第 ${chapter} 章还没定稿，事实没法记在那一章。`);
      const structured = Boolean(request.subject && request.attribute && request.value);
      const nature = request.nature && request.nature !== "event" && structured ? request.nature : "event";
      return proposal(
        [{
          type: "fact.assert",
          chapter,
          nature,
          ...(structured ? { subject: request.subject, attribute: request.attribute, value: request.value } : {}),
          text: request.text.trim(),
        } as DecisionInput],
        [`在第 ${chapter} 章补记一条事实：${quoteText(request.text, 60)}${request.nature && request.nature !== "event" && !structured ? "（没说清谁、哪方面、是什么，先按「发生过的事」记）" : ""}`],
      );
    }
    case "update": {
      if (!request.id && !request.targetText) return fail("missing_target", "要改哪一条事实？");
      if (!request.text?.trim()) return fail("missing_text", "要改成什么？");
      const found = findFact(view, request.id ?? request.targetText ?? "");
      if (!found.ok) return fail(found.code, found.reason);
      const old: FactView = found.item;
      const structured = old.nature !== "event" && old.subject && old.attribute;
      return proposal(
        [{
          type: "fact.assert",
          chapter: old.chapter,
          nature: structured ? old.nature : "event",
          ...(structured ? { subject: old.subject, attribute: old.attribute, value: request.value?.trim() || old.value } : {}),
          text: request.text.trim(),
          corrects: old.id,
          // 说的是一样东西：改后的那条还挂在那样东西上，不按名字重新认（同名两样分不开，设计 2.7）。
          ...(old.item !== undefined && old.subject ? { subject: old.subject, subjectId: old.item } : {}),
        } as DecisionInput],
        [`把第 ${old.chapter} 章的事实${quoteText(old.text)}改成${quoteText(request.text, 60)}`],
      );
    }
    case "remove": {
      const found = findFact(view, request.id ?? request.targetText ?? "");
      if (!found.ok) return fail(found.code, found.reason);
      return proposal([{ type: "fact.retract", fact: found.item.id }], [`删掉第 ${found.item.chapter} 章记错的事实${quoteText(found.item.text)}`]);
    }
    case "supersede": {
      const found = findFact(view, request.id ?? request.targetText ?? "");
      if (!found.ok) return fail(found.code, found.reason);
      const chapter = request.chapter ?? latest;
      if (chapter <= found.item.chapter) return fail("bad_chapter", `那条事实是第 ${found.item.chapter} 章记的，「从第几章起不再成立」要在它之后。`);
      if (found.item.status !== "current") return fail("not_current", `${quoteText(found.item.text)}已经不成立了，不用再标。`);
      return proposal(
        [{ type: "fact.expire", fact: found.item.id, chapter }],
        [`事实${quoteText(found.item.text)}从第 ${chapter} 章起不再成立`],
      );
    }
    case "resolve": {
      if (!request.query?.trim() && !request.id) return fail("missing_target", "要收哪一条？请说出那条线索的标题或关键词。");
      const found = findThread(view, request.id ?? request.query ?? "");
      if (!found.ok) return fail(found.code, found.reason);
      const thread: ThreadView = found.item;
      if (thread.status === "closed") return fail("already_closed", `线索「${thread.title}」已经收了（第 ${thread.closedAt} 章）。`);
      const chapter = request.chapter ?? latest;
      return proposal([{ type: "thread.close", thread: thread.id, chapter }], [`把线索「${thread.title}」记为第 ${chapter} 章已收`]);
    }
    case "keepDay": {
      // 作者定的天数和按记下的推出来的对不上：以作者定的为准；两处写明的星期算不拢：照写的留着。
      // 都是记「不是问题」裁定，以后不再提；账、正文都不动。
      const chapter = request.chapter ?? latest;
      const conflicts = view.timeConflicts.filter((conflict) => conflict.chapter === chapter);
      const weekdays = view.weekdayConflicts.filter((conflict) => conflict.chapter === chapter);
      if (conflicts.length === 0 && weekdays.length === 0) return fail("unchanged", `第 ${chapter} 章你定的天数、写的星期和记下的没有对不上的，不用改。`);
      return proposal(
        [...conflicts, ...weekdays].map((conflict) => ({ type: "issue.dismiss", issue: conflict.key })),
        [
          ...conflicts.map((conflict) => `第 ${chapter} 章以你定的第 ${conflict.authorDay} 天为准`),
          ...weekdays.map((conflict) => `第 ${chapter} 章写的${WEEKDAY_NAMES[conflict.weekday]}照留，不再提`),
        ],
      );
    }
    case "day": {
      const chapter = request.chapter ?? latest;
      const current = view.chapters.find((item) => item.chapter === chapter);
      if (!current) return fail("unknown_chapter", `第 ${chapter} 章还没定稿，天数定稿时在清单上改。`);
      if (!request.day || request.day < 1) return fail("missing_day", `第 ${chapter} 章该是故事第几天？`);
      const day = request.day;
      if (request.dayEnd !== undefined && request.dayEnd < day) return fail("bad_day", `到第 ${request.dayEnd} 天比第 ${day} 天还早，请说清这一章是第几天到第几天。`);
      // 给了结尾才记结尾（和开头一样 = 明确就这一天）；只说开头的，结尾按这章里换天推（写作版本 P3 设计 2.5，T4：不再吞掉）。
      const dayEnd = request.dayEnd;
      const days = (from: number, to: number | undefined) => (to !== undefined && to > from ? `第 ${from} 天到第 ${to} 天` : `第 ${from} 天`);
      const { start, end } = current.time;
      const sameStart = isExact(start) && start.lo === day;
      if (sameStart && (dayEnd === undefined || (isExact(end) && end.lo === dayEnd))) {
        return fail("unchanged", `第 ${chapter} 章记的就是故事${storySpanText(current.time) ?? days(day, dayEnd)}，不用改。`);
      }
      const was = storySpanText(current.time);
      const from = was ? `从故事${was}` : "";
      return proposal(
        [{ type: "chapter.day", chapter, day, ...(dayEnd !== undefined ? { dayEnd } : {}) }],
        [`第 ${chapter} 章${from}改记为${from ? "" : "故事"}${days(day, dayEnd)}`],
      );
    }
    case "summary": {
      const chapter = request.chapter ?? latest;
      const current = view.chapters.find((item) => item.chapter === chapter);
      if (!current) return fail("unknown_chapter", `第 ${chapter} 章还没定稿，梗概定稿时在清单上看。`);
      const text = request.text?.trim();
      if (!text) return fail("missing_text", `第 ${chapter} 章的梗概要改成什么？`);
      if (current.summary === text) return fail("unchanged", `第 ${chapter} 章的梗概就是这样，不用改。`);
      return proposal([{ type: "chapter.summary", chapter, text }], [`第 ${chapter} 章的梗概改成：${text}`]);
    }
    case "importance": {
      const ref = request.id ?? request.query;
      if (!ref || !request.importance) return fail("missing_target", "调大小要知道是哪一条、调成大伏笔还是小线索。");
      const found = findThread(view, ref);
      if (!found.ok) return fail(found.code, found.reason);
      return proposal(
        [{ type: "thread.weight", thread: found.item.id, weight: request.importance }],
        [`线索「${found.item.title}」定为${WEIGHT_LABELS[request.importance]}`],
      );
    }
    case "group": {
      const groups = (request.groups ?? []).filter((group) => group.length > 0);
      if (groups.length === 0) {
        return fail("missing_target", "要归并哪几条？先看开着的线索，把讲同一件事的几条一起给出（第一条留下，其余并进去）。");
      }
      const decisions: DecisionInput[] = [];
      const lines: string[] = [];
      const used = new Set<string>();
      for (const group of groups) {
        const resolved: ThreadView[] = [];
        for (const ref of group) {
          const found = findThread(view, ref);
          if (!found.ok) return fail(found.code, found.reason);
          if (!resolved.some((thread) => thread.id === found.item.id)) resolved.push(found.item);
        }
        const [into, ...from] = resolved;
        if (!into || from.length === 0) return fail("too_few", "每组至少要两条不同的线索才能归并。");
        if ([into, ...from].some((thread) => used.has(thread.id))) return fail("overlap", "同一条线索出现在两组里，请分清各组。");
        for (const thread of [into, ...from]) used.add(thread.id);
        decisions.push({ type: "thread.merge", from: from.map((thread) => thread.id), into: into.id });
        lines.push(`把 ${from.map((thread) => `「${thread.title}」`).join("")}并进「${into.title}」`);
      }
      if (decisions.length > MAX_DECISIONS_PER_CHANGE) return fail("too_many", `一次最多归并 ${MAX_DECISIONS_PER_CHANGE} 组，请分几次。`);
      return proposal(decisions, lines);
    }
  }
}


/** 一批改账请求一起算：各条的裁定、给作者看的话接起来；算不成的如实列进「没改成」（同一条裁定只记一次）。 */
export function planLedgerRequests(view: BookProjection, requests: readonly LedgerChangeRequest[], ledgers: readonly ChapterLedger[] = []): {
  readonly decisions: readonly DecisionInput[];
  readonly lines: readonly string[];
  readonly notDone: readonly string[];
} {
  const decisions: DecisionInput[] = [];
  const lines: string[] = [];
  const notDone: string[] = [];
  const seen = new Set<string>();
  for (const request of requests) {
    const planned = planOnView(view, request, ledgers);
    if (!planned.ok) {
      notDone.push(planned.reason.endsWith("。") ? planned.reason.slice(0, -1) : planned.reason);
      continue;
    }
    const fresh = planned.decisions.filter((decision) => {
      const key = JSON.stringify(decision);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (fresh.length === 0) continue;
    if (decisions.length + fresh.length > MAX_DECISIONS_PER_CHANGE) {
      notDone.push(`一次最多改 ${MAX_DECISIONS_PER_CHANGE} 条，${planned.lines.join("；")}这次没算上，分几次改`);
      continue;
    }
    decisions.push(...fresh);
    lines.push(...planned.lines);
  }
  return { decisions, lines, notDone };
}

/** 按钮、记录里带的裁定读回来（核心的格式校验）；不对的整批不收。 */
export function readDecisions(raw: unknown): readonly DecisionInput[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_DECISIONS_PER_CHANGE) return undefined;
  const decisions: DecisionInput[] = [];
  for (const item of raw) {
    const parsed = DecisionInput.safeParse(item);
    if (!parsed.success) return undefined;
    decisions.push(parsed.data);
  }
  return decisions;
}

const MAX_TEXT_CHARS = 2000;
const IMPORTANCE = ["major", "normal", "minor"] as const;
const NATURES = ["hard", "state", "event"] as const;

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim().slice(0, MAX_TEXT_CHARS) : undefined);
const positive = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined);
const oneOf = <T extends string>(items: readonly T[], value: unknown): T | undefined => items.find((item) => item === value);

const GONE = ["lost", "destroyed"] as const;

/** 对齐的旧记录：编号或原话的列表（只给一条时直接写一个字符串也认）。 */
function factRefs(value: Record<string, unknown>): { replaces?: string[]; overlaps?: string[] } {
  const out: { replaces?: string[]; overlaps?: string[] } = {};
  for (const key of ["replaces", "overlaps"] as const) {
    const raw = value[key];
    const list = (Array.isArray(raw) ? raw : [raw]).map(text).filter((item): item is string => item !== undefined);
    if (list.length > 0) out[key] = [...new Set(list)];
  }
  return out;
}

function itemStateFields(value: Record<string, unknown>): Record<string, unknown> {
  const raw = typeof value.where === "object" && value.where !== null && !Array.isArray(value.where) ? (value.where as Record<string, unknown>) : {};
  const where = Object.fromEntries(Object.entries({
    person: text(raw.person),
    place: text(raw.place),
    inside: text(raw.inside),
    unknown: raw.unknown === true ? true : undefined,
    gone: oneOf(GONE, raw.gone),
  }).filter(([, item]) => item !== undefined));
  // 成员：名字，或 { name, replaces, overlaps }；空字符串当没写，写了别的样子留个空名字，planOnView 如实说没说是哪样（不悄悄少列一样）。
  const members = Array.isArray(value.members)
    ? value.members.flatMap((member): ItemMemberRequest[] => {
      if (typeof member === "string") return text(member) ? [{ name: text(member) as string }] : [];
      const record = typeof member === "object" && member !== null && !Array.isArray(member) ? (member as Record<string, unknown>) : {};
      return [{ name: text(record.name) ?? "", ...factRefs(record) }];
    })
    : undefined;
  return {
    ...(Object.keys(where).length > 0 ? { where } : {}),
    ...(members ? { members } : {}),
    ...(value.complete === true ? { complete: true } : {}),
    ...factRefs(value),
  };
}

/** 一条改账请求读回来（交来的参数、记录里存的）：op 不认识是 undefined；别的字段形状不对就当没给（planOnView 如实说缺什么）。 */
export function readLedgerRequest(raw: unknown): LedgerChangeRequest | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const op = oneOf(LEDGER_OPS, value.op);
  if (!op) return undefined;
  const groups = Array.isArray(value.groups)
    ? value.groups
      .map((group) => (Array.isArray(group) ? group.map(text).filter((item): item is string => item !== undefined) : []))
      .filter((group) => group.length > 0)
      .slice(0, MAX_DECISIONS_PER_CHANGE)
    : [];
  const fields: Record<string, unknown> = {
    id: text(value.id),
    chapter: positive(value.chapter),
    text: text(value.text),
    targetText: text(value.targetText),
    query: text(value.query),
    importance: oneOf(IMPORTANCE, value.importance),
    nature: oneOf(NATURES, value.nature),
    subject: text(value.subject),
    attribute: text(value.attribute),
    value: text(value.value),
    day: positive(value.day),
    dayEnd: positive(value.dayEnd),
    ...(op === "group" || op === "itemMerge" ? { groups } : {}),
    ...(op === "itemState" ? itemStateFields(value) : {}),
  };
  return { op, ...Object.fromEntries(Object.entries(fields).filter(([, item]) => item !== undefined)) } as LedgerChangeRequest;
}
