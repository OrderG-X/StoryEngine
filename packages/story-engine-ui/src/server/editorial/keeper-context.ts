/**
 * 记账员的上下文（重构 P3）：全部从投影确定性地拼，不读旧文件、不问模型。
 *
 * 四段：人物（已确立名字 + 别称）、开着的线索（T 短号）、现在有效的事实（F 短号）、最近的时间表。
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
  normalizeForQuote,
  threadsForPrompt,
  timelineTable,
  timelineText,
  type BookProjection,
  type FactView,
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

function threadSection(projection: BookProjection, handles: Map<string, string>): { text: string; omitted: number } {
  const { threads, omitted } = threadsForPrompt(projection, { limit: MAX_PROMPT_THREADS });
  if (threads.length === 0) return { text: "", omitted: 0 };
  const lines = threads.map((thread, index) => {
    const handle = `T${index + 1}`;
    handles.set(handle, thread.id);
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

function factSection(projection: BookProjection, draft: string, handles: Map<string, string>): { text: string; omitted: number } {
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

/** projection 应是「算到上一章」的投影；draft 是本章正文。 */
export function buildKeeperContext(projection: BookProjection, draft: string): KeeperContext {
  const threadHandles = new Map<string, string>();
  const factHandles = new Map<string, string>();
  const threads = threadSection(projection, threadHandles);
  const facts = factSection(projection, draft, factHandles);
  const sections = [castSection(projection), threads.text, facts.text, timelineSection(projection)].filter((part) => part.length > 0);
  return {
    text: sections.join("\n\n"),
    threadHandles,
    factHandles,
    omittedThreads: threads.omitted,
    omittedFacts: facts.omitted,
  };
}
