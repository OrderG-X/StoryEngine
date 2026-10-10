/**
 * 核账「不是问题」记录（2026-10-10 第 2 期）：作者在核账卡上点过「不是问题」的条目，下次核同一章不再报。
 *
 * 存 .story-engine-ui/continuity-dismissals.json（界面旁路，和伏笔大小覆盖表同处）——它是作者对查错结果的批注，
 * 不是故事资料，不进账本、不进快照。认条目：同一章 + 本章那句对得上 + 前文那句对得上（模型抄句常差一两个字，
 * 用两字片段重合判）。前文那句换了一句，就当是另一处对不上，照报。
 */
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runExclusive, writeFileAtomic } from "../../lib/project-io.js";

export interface ContinuityDismissal {
  readonly chapter: number;
  readonly quote: string;
  readonly earlierQuote: string;
  readonly reason?: string;
  readonly at: string;
}

interface DismissalFile {
  readonly version: "v0";
  readonly items: readonly ContinuityDismissal[];
}

const MAX_ITEMS = 2000;

export const dismissalsPath = (projectDir: string): string => join(projectDir, ".story-engine-ui", "continuity-dismissals.json");

export async function readDismissals(projectDir: string): Promise<readonly ContinuityDismissal[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(dismissalsPath(projectDir), "utf-8"));
    const items = parsed && typeof parsed === "object" && Array.isArray((parsed as { items?: unknown }).items)
      ? (parsed as { items: unknown[] }).items
      : [];
    return items.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const record = item as Record<string, unknown>;
      const chapter = Number(record.chapter);
      const quote = typeof record.quote === "string" ? record.quote : "";
      const earlierQuote = typeof record.earlierQuote === "string" ? record.earlierQuote : "";
      if (!Number.isInteger(chapter) || chapter <= 0 || !quote.trim() || !earlierQuote.trim()) return [];
      return [{
        chapter,
        quote,
        earlierQuote,
        ...(typeof record.reason === "string" && record.reason.trim() ? { reason: record.reason } : {}),
        at: typeof record.at === "string" ? record.at : "",
      }];
    });
  } catch {
    // 没标过 / 文件坏了 → 当没有（这是批注，不是资料；坏了最多是再报一次）
    return [];
  }
}

const normalize = (text: string): string => text.replace(/[\s「」『』“”"'…—，。！？；：、,.!?;:（）()]/gu, "");

function bigrams(text: string): Set<string> {
  const chars = Array.from(text);
  const out = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i += 1) out.add(chars[i] + chars[i + 1]);
  return out;
}

/** 两句是不是同一句：互相包含，或两字片段八成重合。 */
export function sameSentence(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (na.length < 2 || nb.length < 2) return false;
  if (na.includes(nb) || nb.includes(na)) return true;
  const ga = bigrams(na);
  const gb = bigrams(nb);
  let shared = 0;
  for (const gram of ga) if (gb.has(gram)) shared += 1;
  return shared / Math.min(ga.size, gb.size) >= 0.8;
}

export function isDismissed(
  chapter: number,
  issue: { readonly quote: string; readonly earlierQuote: string },
  dismissals: readonly ContinuityDismissal[],
): boolean {
  return dismissals.some((item) => item.chapter === chapter && sameSentence(item.quote, issue.quote) && sameSentence(item.earlierQuote, issue.earlierQuote));
}

async function writeDismissals(projectDir: string, items: readonly ContinuityDismissal[]): Promise<void> {
  const file: DismissalFile = { version: "v0", items: items.slice(-MAX_ITEMS) };
  await stat(projectDir); // 书已删就别再写（免得建出幽灵目录）
  await mkdir(dirname(dismissalsPath(projectDir)), { recursive: true });
  await writeFileAtomic(dismissalsPath(projectDir), `${JSON.stringify(file, null, 2)}\n`);
}

/** 记一条「不是问题」；已记过的不重复记。返回记完后的条数。 */
export function addDismissal(projectDir: string, item: Omit<ContinuityDismissal, "at">): Promise<number> {
  return runExclusive(dismissalsPath(projectDir), async () => {
    const current = await readDismissals(projectDir);
    if (isDismissed(item.chapter, item, current)) return current.length;
    const next = [...current, { ...item, at: new Date().toISOString() }];
    await writeDismissals(projectDir, next);
    return next.length;
  });
}

/** 撤回「不是问题」：删掉和这条对得上的记录。返回删了几条。 */
export function removeDismissal(projectDir: string, item: Pick<ContinuityDismissal, "chapter" | "quote" | "earlierQuote">): Promise<number> {
  return runExclusive(dismissalsPath(projectDir), async () => {
    const current = await readDismissals(projectDir);
    const next = current.filter((existing) => !isDismissed(item.chapter, existing, [{ ...item, at: "" }]));
    if (next.length !== current.length) await writeDismissals(projectDir, next);
    return current.length - next.length;
  });
}
