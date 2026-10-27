/**
 * 记账员的上下文（重构 P3）：全部从投影确定性地拼，不读旧文件、不问模型。
 *
 * 四段：人物（已确立名字 + 别称）、开着的线索（T 短号）、现在有效的事实（F 短号）、最近的时间表；
 * 重定稿时多一段：这一章上次定稿开的线索（R 短号，本章还在开就沿用编号）。
 * 短号只在这一次调用里有效，由 handles 换回真编号；模型交回来的短号对不上就当指向不存在的东西。
 *
 * 事实只列 hard / state，选取规则是精确的字符串出现与否（不是语义判断）：
 *  1. 主体的已确立名字或别称在本章正文里逐字出现的，全列；
 *  2. 再加最近 RECENT_FACT_CHAPTERS 章新记的；
 *  3. 超过 MAX_PROMPT_FACTS 条，先留第 1 类，再按记下的章从新到旧截断，如实写「另有 x 条没列」。
 *  没列的分两种报：按规则本来就不列的（主体没出现、也不是最近记的）只告诉模型；超了上限截掉的才算
 *  「没看全」（omittedFacts），定稿预览如实提醒作者。
 */
import {
  nameKey,
  normalizeForQuote,
  threadsForPrompt,
  timelineTable,
  timelineText,
  type BookProjection,
  type FactView,
  type SettingCardsFile,
} from "@actalk/story-core";

export const MAX_PROMPT_THREADS = 200;
export const MAX_PROMPT_FACTS = 120;
export const RECENT_FACT_CHAPTERS = 3;
export const PROMPT_TIMELINE_CHAPTERS = 10;

export interface KeeperContext {
  /** 拼好的上下文段，直接接在本章正文后面。 */
  readonly text: string;
  /** 「T3」→ 线索真编号。 */
  readonly threadHandles: ReadonlyMap<string, string>;
  /** 「F7」→ 事实真编号。 */
  readonly factHandles: ReadonlyMap<string, string>;
  /** 「R2」→ 这一章上次定稿时开的线索真编号（重定稿才有）。 */
  readonly reopenHandles: ReadonlyMap<string, string>;
  /** 「T3」→ 线索标题、「F7」→ 事实内容（模型在说明里提了短号时换成名字给作者看）。 */
  readonly handleNames: ReadonlyMap<string, string>;
  readonly omittedThreads: number;
  /** 和本章有关、但超了上限没列给记账员的事实条数（按规则本来就不列的不算）。 */
  readonly omittedFacts: number;
}

const THREAD_TYPE_LABELS = { question: "悬念", intent: "打算", goal: "目标" } as const;

function castSection(projection: BookProjection): string {
  if (projection.cast.length === 0) return "";
  const lines = projection.cast.map((member) => (member.aliases.length > 0 ? `${member.name}（又叫：${member.aliases.join("、")}）` : member.name));
  return `【本书已出场的人物（name 务必逐字沿用这里的写法；正文用了别的称呼就写进 nameUsed）】\n${lines.join("\n")}`;
}

/**
 * 设定本里有卡、账里还没出场过的人物（换题材长篇实跑 2026-10-27：父亲的卡叫「林国栋」，前两章只叫「父亲」，
 * 记账员只看得到已出场的人，自己编了个「林父」——出场、事实都记在「林父」名下，跟那张卡对不上）。
 * 带上别名和卡上的关系，模型才认得出正文里的称呼指的是谁。
 */
function cardCastSection(projection: BookProjection, cards: SettingCardsFile | undefined): string {
  if (!cards) return "";
  const known = new Set(projection.cast.flatMap((member) => [member.key, ...member.aliases.map(nameKey)]));
  const byId = new Map(cards.cards.map((card) => [card.id, card] as const));
  const lines = cards.cards
    .filter((card) => card.kind === "character" && ![card.name, ...card.aliases].some((name) => known.has(nameKey(name))))
    .map((card) => {
      const relations = cards.relations
        .filter((relation) => relation.a === card.id || relation.b === card.id)
        .flatMap((relation) => {
          const other = byId.get(relation.a === card.id ? relation.b : relation.a);
          return other ? [`和${other.name}：${relation.label}`] : [];
        });
      const notes = [...(card.aliases.length > 0 ? [`又叫：${card.aliases.join("、")}`] : []), ...relations];
      return notes.length > 0 ? `${card.name}（${notes.join("；")}）` : card.name;
    });
  if (lines.length === 0) return "";
  return `【设定本里还没出场的人物（正文写到他们时 name、事实的 subject 都照这里的写法；正文的称呼写进 nameUsed）】\n${lines.join("\n")}`;
}

function threadSection(projection: BookProjection, handles: Map<string, string>, names: Map<string, string>): { text: string; omitted: number } {
  const { threads, omitted } = threadsForPrompt(projection, { limit: MAX_PROMPT_THREADS });
  if (threads.length === 0) return { text: "", omitted: 0 };
  const lines = threads.map((thread, index) => {
    const handle = `T${index + 1}`;
    handles.set(handle, thread.id);
    names.set(handle, thread.title);
    const idle = thread.idleChapters > 0 ? `，停了 ${thread.idleChapters} 章` : "";
    const last = thread.lastNote === thread.title ? "" : `；最近（第 ${thread.lastTouchedAt} 章）：${thread.lastNote}`;
    return `${handle} [${THREAD_TYPE_LABELS[thread.type]}] ${thread.title}（第 ${thread.openedAt} 章开${idle}${last}）`;
  });
  const more = omitted > 0 ? `\n（另有 ${omitted} 条开着的线索没列出）` : "";
  return {
    text: `【开着的线索（推进、收口时 thread 填这里的编号，不要新造；不在这里的才算新开）】\n${lines.join("\n")}${more}`,
    omitted,
  };
}

/** 这一章上次定稿时开的一条线索（重定稿时给记账员对照）。 */
export interface ReopenableThread {
  readonly thread: string;
  readonly type: keyof typeof THREAD_TYPE_LABELS;
  readonly title: string;
  readonly note: string;
}

/**
 * 重定稿（2026-10-24 长篇走查）：改了前面一章再定稿，记账员按新稿重记，线索换了说法就成了新编号，
 * 后文推进、收口的还是旧编号——一章改两句，九条线索在后文成了没头的。列出上次开的，本章还在开的沿用编号。
 */
function reopenSection(reopenable: readonly ReopenableThread[], handles: Map<string, string>, names: Map<string, string>): string {
  if (reopenable.length === 0) return "";
  const lines = reopenable.map((thread, index) => {
    const handle = `R${index + 1}`;
    handles.set(handle, thread.thread);
    names.set(handle, thread.title);
    const note = thread.note === thread.title ? "" : `（上次记的：${thread.note}）`;
    return `${handle} [${THREAD_TYPE_LABELS[thread.type]}] ${thread.title}${note}`;
  });
  return `【这一章上次定稿时开的线索（正文改过、这次重新记账；后文还接着这些线索）：本章正文还在开的，照样报 op = open，thread 填这里的编号、title 沿用；本章已经不开了的不报】\n${lines.join("\n")}`;
}

/** 主体名（含人物别称）在正文里逐字出现。 */
function mentionedSubjects(projection: BookProjection, draft: string): Set<string> {
  const text = normalizeForQuote(draft);
  const mentioned = new Set<string>();
  const appears = (name: string): boolean => {
    const key = normalizeForQuote(name);
    return key.length > 0 && text.includes(key);
  };
  for (const member of projection.cast) {
    if (appears(member.name) || member.aliases.some(appears)) mentioned.add(member.key);
  }
  for (const subject of projection.subjects) {
    if (appears(subject.name)) mentioned.add(subject.key);
  }
  return mentioned;
}

function factSection(projection: BookProjection, draft: string, handles: Map<string, string>, names: Map<string, string>): { text: string; omitted: number } {
  const live = projection.facts.filter(
    (fact): fact is FactView & { subjectKey: string } =>
      fact.status === "current" && (fact.nature === "hard" || fact.nature === "state") && fact.subjectKey !== undefined,
  );
  if (live.length === 0) return { text: "", omitted: 0 };
  const mentioned = mentionedSubjects(projection, draft);
  const recentFrom = projection.upTo - RECENT_FACT_CHAPTERS + 1;
  const picked = live.filter((fact) => mentioned.has(fact.subjectKey) || fact.chapter >= recentFrom);
  const ranked = [...picked].sort(
    (a, b) => Number(mentioned.has(b.subjectKey)) - Number(mentioned.has(a.subjectKey)) || b.chapter - a.chapter || (a.id < b.id ? -1 : 1),
  );
  const kept = ranked.slice(0, MAX_PROMPT_FACTS);
  // 两种没列：主体没在本章出现、也不是最近记的（按规则本来就不列）；和本章有关但超了上限（真没看全）。
  const unrelated = live.length - picked.length;
  const omitted = picked.length - kept.length;
  // 展示按主体归组、组内按章序，模型好对照。
  const order = new Map<string, number>();
  for (const fact of kept) if (!order.has(fact.subjectKey)) order.set(fact.subjectKey, order.size);
  const grouped = [...kept].sort((a, b) => (order.get(a.subjectKey) ?? 0) - (order.get(b.subjectKey) ?? 0) || a.chapter - b.chapter);
  const lines = grouped.map((fact, index) => {
    const handle = `F${index + 1}`;
    handles.set(handle, fact.id);
    names.set(handle, fact.text);
    const nature = fact.nature === "hard" ? "不会变" : "会变";
    const head = fact.attribute && fact.value !== undefined ? `${fact.subject} · ${fact.attribute}：${fact.value}` : fact.text;
    return `${handle} ${head}（第 ${fact.chapter} 章，${nature}）`;
  });
  const more = [
    omitted > 0 ? `\n（另有 ${omitted} 条和本章有关的事实，太多没列出）` : "",
    unrelated > 0 ? `\n（另有 ${unrelated} 条有效的事实，主体没在本章出现，没列出）` : "",
  ].join("");
  return {
    text: `【现在有效的事实（本章明写推翻其中某条时，replaces 填它的编号）】\n${lines.join("\n")}${more}`,
    omitted,
  };
}

function timelineSection(projection: BookProjection): string {
  const rows = timelineTable(projection).slice(-PROMPT_TIMELINE_CHAPTERS);
  if (rows.length === 0) return "";
  return `【前文的时间（最近 ${rows.length} 章；照表对，不要自己推算故事第几天）】\n${timelineText(rows)}`;
}

/** projection 应是「算到上一章」的投影；draft 是本章正文；reopenable = 重定稿时这一章上次开的线索；cards = 设定卡（没有就不列卡上的人）。 */
export function buildKeeperContext(
  projection: BookProjection,
  draft: string,
  reopenable: readonly ReopenableThread[] = [],
  cards?: SettingCardsFile,
): KeeperContext {
  const threadHandles = new Map<string, string>();
  const factHandles = new Map<string, string>();
  const reopenHandles = new Map<string, string>();
  const handleNames = new Map<string, string>();
  const threads = threadSection(projection, threadHandles, handleNames);
  const reopen = reopenSection(reopenable, reopenHandles, handleNames);
  const facts = factSection(projection, draft, factHandles, handleNames);
  const sections = [castSection(projection), cardCastSection(projection, cards), threads.text, reopen, facts.text, timelineSection(projection)].filter((part) => part.length > 0);
  return {
    text: sections.join("\n\n"),
    threadHandles,
    factHandles,
    reopenHandles,
    handleNames,
    omittedThreads: threads.omitted,
    omittedFacts: facts.omitted,
  };
}
