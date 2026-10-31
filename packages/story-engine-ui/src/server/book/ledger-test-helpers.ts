/**
 * 单测用：按章真走核心定稿命令给书记账（写作版本 P2b 删了镜像以后，读者的材料都从账算，测试也得从账种）。
 * 条目没写原句的配一句「第 N 章第 i 句。」拼进正文；测的是读者怎么用账，不是原句。生产代码不引。
 * 线索编号由核心发（t<章>-<序>）：新开时 `thread` 写个测试里好认的名字，后面推进、收口、裁定照名字写，这里换成真编号。
 */
import { randomUUID } from "node:crypto";
import { chapterCommit, decisionRecord, readChapterLedger, runCommand, threadOf, type EntryInput } from "@actalk/story-core";

const threadIds = new Map<string, Map<string, string>>();

/** 测试里给线索起的名字 → 核心发的编号（没种过的原样返回）。 */
export function seededThreadId(projectDir: string, name: string): string {
  return threadIds.get(projectDir)?.get(name) ?? name;
}

type Loose<E> = E extends EntryInput
  ? E extends { readonly kind: "time" | "day" } ? Omit<E, "review"> & { readonly review?: E["review"] } : Omit<E, "review" | "quote"> & { readonly review?: E["review"]; readonly quote?: string }
  : never;
export type SeedEntry = Loose<EntryInput>;

export interface SeedChapter {
  readonly chapter: number;
  /** 正文第一行的章名；不给就是「第N章」。 */
  readonly title?: string;
  readonly entries: readonly SeedEntry[];
}

export async function seedChapters(projectDir: string, chapters: readonly SeedChapter[]): Promise<void> {
  const ids = threadIds.get(projectDir) ?? new Map<string, string>();
  threadIds.set(projectDir, ids);
  for (const seed of chapters) {
    const lines: string[] = [];
    const named: (string | undefined)[] = [];
    const say = (quote: string): void => {
      if (!lines.includes(quote)) lines.push(quote);
    };
    const entries = seed.entries.map((raw, index): EntryInput => {
      let entry = raw;
      // 作者定的天数不带原句；时间的原句在开头、换天、段里（没写开头原句的配一句）。
      if (entry.kind === "day") return { review: "author", ...entry } as EntryInput;
      if (entry.kind === "time") {
        const start = entry.start && entry.start !== "unknown" ? { ...entry.start, quote: entry.start.quote || `第${seed.chapter}章第${index + 1}句。` } : entry.start;
        if (start && start !== "unknown") say(start.quote);
        for (const change of entry.dayChanges ?? []) if (change.quote) say(change.quote);
        for (const segment of entry.segments ?? []) [segment.firstQuote, segment.lastQuote].forEach(say);
        return { review: "auto", ...entry, ...(start ? { start } : {}) } as EntryInput;
      }
      named.push(entry.kind === "thread" && entry.op === "open" ? entry.thread : undefined);
      if (entry.kind === "thread") {
        const { thread, ...rest } = entry;
        entry = entry.op === "open" ? rest : { ...rest, thread: thread === undefined ? undefined : seededThreadId(projectDir, thread) };
      }
      const quote = (entry as { readonly quote?: string }).quote ?? `第${seed.chapter}章第${index + 1}句。`;
      say(quote);
      return { review: "auto", ...entry, quote } as EntryInput;
    });
    const body = lines.length > 0 ? lines.join("\n\n") : `第${seed.chapter}章正文。`;
    const outcome = await runCommand(projectDir, chapterCommit, { chapter: seed.chapter, text: `# ${seed.title ?? `第${seed.chapter}章`}\n\n${body}`, entries }, { caller: "author", idempotencyKey: `seed-${seed.chapter}-${randomUUID()}` });
    if (!outcome.ok) throw new Error(`第 ${seed.chapter} 章没记上：${outcome.message}`);
    if (outcome.result.rejected.length > 0) throw new Error(`第 ${seed.chapter} 章有条目没记上：${JSON.stringify(outcome.result.rejected)}`);
    // 时间以外一条声明存一条（时间存成好几条，不数）。
    const stored = (await readChapterLedger(projectDir, seed.chapter))?.entries.filter((entry) => entry.kind !== "time") ?? [];
    named.forEach((name, index) => {
      const entry = stored[index];
      if (name !== undefined && entry?.kind === "thread") ids.set(name, threadOf(entry));
    });
  }
}

/** 一条线索 / 打算 / 目标的一生：开在哪章、最后碰在哪章（之后那章记一笔推进）、收在哪章。 */
export interface SeedThread {
  /** 测试里好认的名字（真编号用 seededThreadId 换）。 */
  readonly name: string;
  readonly type: "question" | "intent" | "goal";
  readonly title: string;
  readonly openedAt: number;
  readonly touchedAt?: number;
  readonly closedAt?: number;
  /** 开的那句原句；推进、收口那句按「第 N 章第 i 句。」配。 */
  readonly quote?: string;
  /** 收口时记的话（核账、写手读作「这章揭开的事」）。 */
  readonly closeNote?: string;
  readonly weight?: "major" | "minor";
}

/** 按章把线索的开 / 推进 / 收和别的条目（extra，排在前面）并成每章一次定稿记进账；标了轻重的再记一次作者裁定。 */
export async function seedThreads(projectDir: string, threads: readonly SeedThread[], extra: readonly SeedChapter[] = []): Promise<void> {
  const byChapter = new Map<number, { title?: string; entries: SeedEntry[] }>();
  const at = (chapter: number) => {
    const slot = byChapter.get(chapter) ?? { entries: [] };
    byChapter.set(chapter, slot);
    return slot;
  };
  for (const seed of extra) {
    const slot = at(seed.chapter);
    if (seed.title !== undefined) slot.title = seed.title;
    slot.entries.push(...seed.entries);
  }
  for (const thread of threads) {
    at(thread.openedAt).entries.push({ kind: "thread", thread: thread.name, op: "open", type: thread.type, title: thread.title, note: thread.title, ...(thread.quote ? { quote: thread.quote } : {}) });
    if (thread.touchedAt !== undefined && thread.touchedAt > thread.openedAt) at(thread.touchedAt).entries.push({ kind: "thread", thread: thread.name, op: "advance", note: `${thread.title}有进展` });
    if (thread.closedAt !== undefined) at(thread.closedAt).entries.push({ kind: "thread", thread: thread.name, op: "close", note: thread.closeNote ?? `${thread.title}有了结果` });
  }
  await seedChapters(projectDir, [...byChapter.entries()].sort(([a], [b]) => a - b).map(([chapter, slot]) => ({ chapter, ...(slot.title !== undefined ? { title: slot.title } : {}), entries: slot.entries })));
  const weighted = threads.filter((thread) => thread.weight !== undefined);
  if (weighted.length > 0) await seedDecisions(projectDir, weighted.map((thread) => ({ type: "thread.weight", thread: thread.name, weight: thread.weight })));
}

/** 作者裁定（标轻重、定天数、作废事实……），形状同核心 decision.record。 */
export async function seedDecisions(projectDir: string, decisions: readonly Record<string, unknown>[]): Promise<void> {
  const resolved = decisions.map((decision) => ({
    ...decision,
    ...(typeof decision.thread === "string" ? { thread: seededThreadId(projectDir, decision.thread) } : {}),
    ...(typeof decision.into === "string" ? { into: seededThreadId(projectDir, decision.into) } : {}),
    ...(Array.isArray(decision.from) ? { from: decision.from.map((name: unknown) => (typeof name === "string" ? seededThreadId(projectDir, name) : name)) } : {}),
  }));
  const outcome = await runCommand(projectDir, decisionRecord, { decisions: resolved }, { caller: "author", idempotencyKey: `seed-decisions-${randomUUID()}` });
  if (!outcome.ok) throw new Error(`裁定没记上：${outcome.message}`);
}
