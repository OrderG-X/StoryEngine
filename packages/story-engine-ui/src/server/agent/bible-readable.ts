/**
 * 设定视图 → 给对话 AI 读的中文（重构 P9）：只有名字，不带编号；AI 补的标出来（AI 改它不用作者点头，改作者写的要）。
 */
import {
  KIND_LABELS,
  RULE_LIST_LABELS,
  type BibleAppearances,
  type BibleEntry,
  type BibleFact,
  type BibleView,
  type CardAuthor,
  type UncardedEntry,
  type WritingRules,
} from "@actalk/story-core";

const AI_MARK = "（AI 补的）";
const mark = (by: CardAuthor): string => (by === "ai" ? AI_MARK : "");

function appearanceLine(appearances: BibleAppearances | undefined): string | undefined {
  if (!appearances) return undefined;
  const span = appearances.first === appearances.last ? `第 ${appearances.first} 章` : `第 ${appearances.first}–${appearances.last} 章`;
  const viewpoint = appearances.viewpointChapters > 0 ? `，其中 ${appearances.viewpointChapters} 章是这个人的视角` : "";
  return `出场：${span}，共 ${appearances.chapters.length} 章${viewpoint}`;
}

function factLines(title: string, facts: readonly BibleFact[]): string[] {
  return facts.length > 0 ? [`${title}：`, ...facts.map((fact) => `- ${fact.attribute}：${fact.value}（第 ${fact.chapter} 章）`)] : [];
}

export function entryText(entry: BibleEntry): string[] {
  const card = entry.card;
  const aliases = [...card.aliases, ...entry.ledgerAliases];
  return [
    `【${KIND_LABELS[card.kind]}】${card.name}${card.protagonist ? "（主角）" : ""}${mark(card.by)}${aliases.length > 0 ? `（也叫：${aliases.join("、")}）` : ""}`,
    ...(card.fields.length > 0 ? ["卡上写的：", ...card.fields.map((field) => `- ${field.label}：${field.value}${mark(field.by)}`)] : ["卡上还没写东西。"]),
    ...(entry.relations.length > 0 ? ["关系：", ...entry.relations.map((relation) => `- 和${relation.other}：${relation.label}${mark(relation.by)}`)] : []),
    ...factLines("正文里已经定下的", entry.fixed),
    ...factLines("账里记的现状（按最新一章）", entry.now),
    ...[appearanceLine(entry.appearances)].filter((line): line is string => line !== undefined),
  ];
}

export function uncardedText(entry: UncardedEntry): string[] {
  return [
    `【还没建卡】${entry.name}${entry.character ? "（出场人物）" : ""}${entry.aliases.length > 0 ? `（也叫：${entry.aliases.join("、")}）` : ""}`,
    ...factLines("正文里已经定下的", entry.fixed),
    ...factLines("账里记的现状（按最新一章）", entry.now),
    ...[appearanceLine(entry.appearances)].filter((line): line is string => line !== undefined),
  ];
}

export function rulesText(rules: WritingRules): string[] {
  const lines: string[] = [];
  if (rules.perspective) lines.push(`- 视角：${rules.perspective.value}${mark(rules.perspective.by)}`);
  if (rules.targetWords) lines.push(`- 每章目标字数：${rules.targetWords.value}${mark(rules.targetWords.by)}`);
  if (rules.minWords) lines.push(`- 每章至少字数：${rules.minWords.value}${mark(rules.minWords.by)}`);
  for (const list of ["style", "musts", "bans", "avoid"] as const) {
    if (rules[list].length > 0) lines.push(`- ${RULE_LIST_LABELS[list]}：${rules[list].map((item) => `${item.text}${mark(item.by)}`).join("；")}`);
  }
  if (rules.notes) lines.push(`- 补充：${rules.notes.value}${mark(rules.notes.by)}`);
  if (rules.exemplars.length > 0) lines.push(`- 文风样本 ${rules.exemplars.length} 段（开头：${rules.exemplars.map((item) => `「${item.text.slice(0, 12)}…」`).join("、")}）`);
  return lines.length > 0 ? lines : ["- 还没定。"];
}

export function storyText(bible: BibleView): string[] {
  return bible.story.length > 0 ? bible.story.map((field) => `- ${field.label}：${field.value}${mark(field.by)}`) : ["- 还没写。"];
}

/** 全书设定一览：故事设定、写作规则全给；卡只列名字（要细看带名字再读）。 */
export function bibleOverviewText(bible: BibleView): string[] {
  const names = (entries: readonly BibleEntry[]): string =>
    entries.length > 0 ? entries.map((entry) => `${entry.card.name}${entry.card.protagonist ? "（主角）" : ""}`).join("、") : "（没有）";
  return [
    "故事设定：",
    ...storyText(bible),
    "写作规则：",
    ...rulesText(bible.rules),
    // 定论对话 AI 也得看得见：作者问「定论有哪些」、要改哪一条时才说得上来。
    ...(bible.canon.length > 0 ? [`定论（${bible.canon.length}，作者定下的，全书以它为准）：`, ...bible.canon.map((item) => `- ${item.text}`)] : []),
    `人物卡（${bible.characters.length}）：${names(bible.characters)}`,
    `地点卡（${bible.places.length}）：${names(bible.places)}`,
    `物品卡（${bible.items.length}）：${names(bible.items)}`,
    `设定卡（${bible.lore.length}）：${names(bible.lore)}`,
    ...(bible.uncarded.length > 0
      ? [`账里有、还没建卡（${bible.uncarded.length}）：${bible.uncarded.slice(0, 30).map((entry) => entry.name).join("、")}${bible.uncarded.length > 30 ? " 等" : ""}`]
      : []),
  ];
}
