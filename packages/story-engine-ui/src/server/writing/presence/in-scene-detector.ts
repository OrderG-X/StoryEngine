/**
 * 本章在场人物（重构 P9 改读设定视图）：从人物卡 + 账里出场过、还没建卡的人里挑本章要带进上下文的。
 *
 * 信号（都是确定性的，题材中立）：
 *   主角恒带；作者点名（explicit）优先；名字或别名在本章方向里逐字出现（3 分）、在上一章正文里出现（2 分）、
 *   账里记着上一章出场（2 分）。名字至少两个字才拿去找，防单字误中。
 * 超过 maxInScene 就按分数收窄（主角占名额），收窄掉的名字如实写进 summary，不静默截断。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readBible, type BibleView, type BookProjection } from "@actalk/story-core";

export const DEFAULT_MAX_IN_SCENE_CHARACTERS = 8;

export interface InSceneCandidate {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly protagonist: boolean;
}

export interface InSceneResult {
  /** 选中的人物名字（主角在前）。 */
  readonly selected: readonly string[];
  readonly reasons: Readonly<Record<string, readonly ("protagonist" | "explicit" | "chapter_goal" | "previous_chapter" | "previous_presence")[]>>;
  readonly prevChapterFound: boolean;
  readonly explicit: boolean;
  /** 收窄掉的名字（群像章超额时）。 */
  readonly cappedOutNames: readonly string[];
  readonly summary: string;
}

export interface DetectInSceneInput {
  readonly candidates: readonly InSceneCandidate[];
  readonly chapterGoal: string;
  readonly previousChapterText: string;
  readonly prevChapterFound: boolean;
  /** 账里记的上一章出场人物。 */
  readonly previousPresent: readonly string[];
  readonly explicit?: readonly string[];
  readonly maxInScene?: number;
}

/** 设定视图里的全部人物：人物卡在前，账里出场过、还没建卡的在后。 */
export function inSceneCandidates(bible: BibleView): InSceneCandidate[] {
  return [
    ...bible.characters.map((entry) => ({
      name: entry.card.name,
      aliases: [...entry.card.aliases, ...entry.ledgerAliases],
      protagonist: entry.card.protagonist === true,
    })),
    ...bible.uncarded.filter((entry) => entry.character).map((entry) => ({ name: entry.name, aliases: entry.aliases, protagonist: false })),
  ];
}

const termsOf = (candidate: InSceneCandidate): string[] =>
  [candidate.name, ...candidate.aliases].map((term) => term.trim()).filter((term) => Array.from(term).length >= 2);

export function detectInSceneCharacters(input: DetectInSceneInput): InSceneResult {
  const candidates = input.candidates;
  const reasons = new Map<string, Set<InSceneResult["reasons"][string][number]>>();
  const add = (name: string, reason: InSceneResult["reasons"][string][number]): void => {
    const set = reasons.get(name) ?? new Set();
    set.add(reason);
    reasons.set(name, set);
  };
  const byName = (ref: string): InSceneCandidate | undefined => {
    const trimmed = ref.trim();
    return candidates.find((candidate) => candidate.name === trimmed || candidate.aliases.includes(trimmed));
  };
  const explicit = (input.explicit ?? []).map(byName).filter((candidate): candidate is InSceneCandidate => candidate !== undefined);
  for (const candidate of candidates) if (candidate.protagonist) add(candidate.name, "protagonist");
  if (explicit.length > 0) {
    for (const candidate of explicit) add(candidate.name, "explicit");
  } else {
    const present = new Set(input.previousPresent);
    for (const candidate of candidates) {
      const terms = termsOf(candidate);
      if (terms.some((term) => input.chapterGoal.includes(term))) add(candidate.name, "chapter_goal");
      if (terms.some((term) => input.previousChapterText.includes(term))) add(candidate.name, "previous_chapter");
      if (present.has(candidate.name) || candidate.aliases.some((alias) => present.has(alias))) add(candidate.name, "previous_presence");
    }
  }
  const order = new Map(candidates.map((candidate, index) => [candidate.name, index]));
  const score = (name: string): number => {
    const set = reasons.get(name) ?? new Set();
    return (set.has("protagonist") ? 100 : 0) + (set.has("explicit") ? 50 : 0) + (set.has("chapter_goal") ? 3 : 0)
      + (set.has("previous_chapter") ? 2 : 0) + (set.has("previous_presence") ? 2 : 0);
  };
  const ranked = [...reasons.keys()].sort((a, b) => score(b) - score(a) || (order.get(a) ?? 0) - (order.get(b) ?? 0));
  const cap = input.maxInScene ?? DEFAULT_MAX_IN_SCENE_CHARACTERS;
  const selected = ranked.slice(0, cap);
  const cappedOutNames = ranked.slice(cap);
  const reasonRecord = Object.fromEntries(selected.map((name) => [name, [...(reasons.get(name) ?? [])]]));
  const summary = selected.length === 0
    ? candidates.length === 0
      ? "本章相关人物：还没有人物卡，账里也没记过出场的人。"
      : "本章相关人物：本章方向和上一章里都没点到谁。"
    : `本章相关人物：${selected.join("、")}${cappedOutNames.length > 0 ? `（按在场相关性收窄到 ${cap} 人，没带：${cappedOutNames.join("、")}）` : ""}`;
  return { selected, reasons: reasonRecord, prevChapterFound: input.prevChapterFound, explicit: explicit.length > 0, cappedOutNames, summary };
}

export interface ResolveInSceneInput {
  readonly projectDir: string;
  readonly chapter: number;
  readonly chapterGoal: string;
  readonly explicit?: readonly string[];
  readonly maxInScene?: number;
  /** 已经读好的设定视图和投影（调用方有就传，省一次读盘）。 */
  readonly bible?: { readonly projection: BookProjection; readonly bible: BibleView };
}

export async function resolveInSceneCharacters(input: ResolveInSceneInput): Promise<InSceneResult> {
  const [read, previous] = await Promise.all([
    input.bible ? Promise.resolve(input.bible) : readBible(input.projectDir),
    readPreviousChapterText(input.projectDir, input.chapter),
  ]);
  const previousChapter = read.projection.chapters.filter((item) => item.chapter < input.chapter).at(-1);
  return detectInSceneCharacters({
    candidates: inSceneCandidates(read.bible),
    chapterGoal: input.chapterGoal,
    previousChapterText: previous.text,
    prevChapterFound: previous.found,
    previousPresent: previousChapter?.chapter === input.chapter - 1 ? previousChapter.present : [],
    ...(input.explicit ? { explicit: input.explicit } : {}),
    ...(input.maxInScene !== undefined ? { maxInScene: input.maxInScene } : {}),
  });
}

async function readPreviousChapterText(projectDir: string, chapter: number): Promise<{ readonly text: string; readonly found: boolean }> {
  if (chapter <= 1) return { text: "", found: false };
  const previous = String(chapter - 1).padStart(4, "0");
  for (const file of [join(projectDir, "chapters", `${previous}.md`), join(projectDir, "drafts", "fast", `chapter-${previous}.md`)]) {
    const text = await readFile(file, "utf-8").catch(() => undefined);
    if (text !== undefined && text.trim().length > 0) return { text, found: true };
  }
  return { text: "", found: false };
}
