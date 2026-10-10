/**
 * 事实账本的读写（2026-10-10 引擎升级·账本 v2）：从界面服务端搬进引擎，和定稿走同一个事务。
 *
 * 以前事实是定稿事务之后才单独追加的（不在事务里、失败不吭声），重定稿同一章旧事实还留着；
 * 现在定稿时把「本章的事实变更」交给引擎，和章节、线索、时间线一起写盘：
 *  - 先撤掉本章上次自动记的事实，恢复被本章上次作废的旧事实（重定稿不重复、不越积越多）；
 *  - 再写本章的新事实（带原句出处、可选的三元组）、作废本章明写变化了的旧事实。
 * 作者手记的事实（source=manual）不动。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FactEntry, FactLedger } from "./types.js";
import { absolutizeRelativeDaysInText, timelineEntryFor, type StoryTimeline } from "./story-timeline.js";

export const FACT_LEDGER_RELATIVE_PATH = join("story", "fact-ledger.json");

/** 账本文件存在但不是合法 JSON：绝不当空表覆盖（会丢数据）。 */
export class CorruptFactLedgerError extends Error {
  readonly code = "FACT_LEDGER_CORRUPT";
  constructor() {
    super("story/fact-ledger.json 内容损坏（不是合法 JSON）。已停止操作以免覆盖丢数据，请先修复或删除该文件再试。");
    this.name = "CorruptFactLedgerError";
  }
}

/** 读账本：没有文件 = 空账本；坏了抛 CorruptFactLedgerError；单条坏的丢掉（不连坐）。 */
export async function readFactLedgerStrict(projectDir: string): Promise<FactLedger> {
  let raw: string;
  try {
    raw = await readFile(join(projectDir, FACT_LEDGER_RELATIVE_PATH), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: "v0", facts: [] };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CorruptFactLedgerError();
  }
  const facts = Array.isArray((parsed as { facts?: unknown })?.facts) ? (parsed as { facts: unknown[] }).facts : [];
  return {
    version: "v0",
    facts: facts.filter((fact): fact is FactEntry => Boolean(fact)
      && typeof (fact as FactEntry).id === "string"
      && typeof (fact as FactEntry).text === "string"
      && Number.isInteger((fact as FactEntry).chapter)),
  };
}

export function factLedgerText(facts: readonly FactEntry[]): string {
  return `${JSON.stringify({ version: "v0", facts }, null, 2)}\n`;
}

/** 本章下一个事实序号：已有最大序号 + 1。 */
export function nextFactSeq(facts: readonly FactEntry[], chapter: number): number {
  const prefix = `fact-${chapter}-`;
  let max = -1;
  for (const fact of facts) {
    if (!fact.id.startsWith(prefix)) continue;
    const seq = Number(fact.id.slice(prefix.length));
    if (Number.isInteger(seq) && seq > max) max = seq;
  }
  return Math.max(max + 1, facts.filter((fact) => fact.chapter === chapter).length);
}

export interface ChapterFactAdd {
  readonly text: string;
  readonly quote?: string;
  readonly subject?: string;
  readonly attribute?: string;
  readonly value?: string;
  readonly kind?: "hard" | "state" | "event";
}

export interface ChapterFactChange {
  /** 被本章明写的变化作废的旧事实。 */
  readonly factId: string;
  /** 变化后的新说法。 */
  readonly newText: string;
  readonly quote?: string;
  readonly subject?: string;
  readonly attribute?: string;
  readonly value?: string;
  readonly kind?: "hard" | "state" | "event";
}

/** 定稿时交给引擎的「本章事实变更」（作者在清单上勾掉的已经去掉了）。 */
export interface ChapterFactUpdate {
  readonly adds: readonly ChapterFactAdd[];
  readonly changes: readonly ChapterFactChange[];
}

export interface ChapterFactUpdateResult {
  readonly facts: readonly FactEntry[];
  readonly added: number;
  /** 被作废的旧事实原文（给作者看的回执）。 */
  readonly superseded: readonly string[];
}

const normalize = (text: string): string => text.replace(/\s+/gu, "");

/**
 * 纯函数：把本章的事实变更落到账本上（重定稿先撤旧）。日子按时间线换算（本章那天 = today）。
 */
export function applyChapterFactUpdate(
  current: readonly FactEntry[],
  chapter: number,
  update: ChapterFactUpdate,
  timeline?: StoryTimeline,
): ChapterFactUpdateResult {
  // 1. 撤掉本章上次自动记的；恢复被本章上次作废的（作者手记的不动）。
  const restored = current
    .filter((fact) => !(fact.chapter === chapter && fact.source !== "manual"))
    .map((fact) => {
      if (fact.supersededByChapter !== chapter) return fact;
      const { supersededByChapter: _chapter, supersededByFactId: _by, ...rest } = fact;
      return rest as FactEntry;
    });
  const today = timeline ? timelineEntryFor(timeline, chapter)?.day : undefined;
  const dated = (text: string): string => (timeline && today !== undefined ? absolutizeRelativeDaysInText(text, today, timeline) : text);
  const seen = new Set(restored.map((fact) => normalize(fact.text)));
  let seq = nextFactSeq(restored, chapter);
  const added: FactEntry[] = [];
  const push = (item: ChapterFactAdd): string | undefined => {
    const text = dated(item.text.trim());
    if (!text || seen.has(normalize(text))) return undefined;
    seen.add(normalize(text));
    const id = `fact-${chapter}-${seq++}`;
    added.push({
      id,
      chapter,
      text,
      source: "auto",
      ...(item.quote ? { quote: item.quote } : {}),
      ...(item.subject ? { subject: item.subject } : {}),
      ...(item.attribute ? { attribute: item.attribute } : {}),
      ...(item.value ? { value: dated(item.value) } : {}),
      ...(item.kind ? { kind: item.kind } : {}),
    });
    return id;
  };
  for (const item of update.adds) push(item);
  // 2. 变化：新说法入账，旧条从本章起作废（只作废仍有效的；原文保留、可撤销）。
  const supersede = new Map<string, string | undefined>();
  for (const change of update.changes) {
    const target = restored.find((fact) => fact.id === change.factId);
    const id = push({ ...change, text: change.newText });
    // 旧条找不到或早已作废：新说法照记（是本章确立的事实），只是不作废什么。
    if (target && target.supersededByChapter === undefined) supersede.set(change.factId, id);
  }
  const superseded: string[] = [];
  const facts = [
    ...restored.map((fact) => {
      if (!supersede.has(fact.id)) return fact;
      superseded.push(fact.text);
      const by = supersede.get(fact.id);
      return { ...fact, supersededByChapter: chapter, ...(by ? { supersededByFactId: by } : {}) };
    }),
    ...added,
  ];
  return { facts, added: added.length, superseded };
}
