/**
 * `store-control/` 下的代次（都不进存档点，撤销 / 恢复不会把它们翻回去）：
 *  - 写入代次 revision.json（写作版本 P1a）：每次写真相都换新的；依据（basis.ts）靠它认出「中间写过」。
 *  - 工作稿代次 drafts.json（写作版本 P1b 第 3 轮复核）：一个纪元 + 每章一个号。工作稿每写一次，那一章换一个新号；
 *    撤销 / 恢复 / 从备份、回收站搬回来，换一个新纪元（各章的号清空）。工作稿版本号 = 纪元 + 这章的号 + 全文的哈希
 *    （draft/draft.ts），所以「R → 作者存 A → AI 换 B → 撤销回 R」之后，照 R 发的旧存稿对不上，不会把撤销的结果盖回去。
 *    文件不在 / 纪元为空且这章没号 = 老书，版本号就是全文的哈希（升级前打开的稿纸照样能存）。
 * 只放格式和读，不碰锁：写由 runner 放进同一个事务，恢复类的直接在书锁里换。
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BOOK_EPOCH_PATH, DRAFT_GENS_PATH, REVISION_PATH } from "./paths.js";
import type { TxFileWrite } from "./transaction.js";

export function revisionWrite(now: Date): TxFileWrite {
  return { path: REVISION_PATH, content: `${JSON.stringify({ schema: "store-revision/1", id: randomUUID(), at: now.toISOString() }, null, 2)}\n` };
}

export const DRAFT_GENS_SCHEMA = "draft-gens/1" as const;

export interface DraftGens {
  /** 空串 = 还没换过纪元（老书）。 */
  readonly epoch: string;
  /** 章号 → 这一章工作稿最后一次写的号。 */
  readonly chapters: Readonly<Record<string, string>>;
}

/** 一章工作稿此刻的代次（算版本号用）。 */
export interface DraftStamp {
  readonly epoch: string;
  readonly gen?: string;
}

const LEGACY: DraftGens = { epoch: "", chapters: {} };

function parseGens(raw: string): DraftGens {
  try {
    const value = JSON.parse(raw) as { schema?: unknown; epoch?: unknown; chapters?: unknown };
    if (value.schema === DRAFT_GENS_SCHEMA && typeof value.epoch === "string" && value.chapters && typeof value.chapters === "object" && !Array.isArray(value.chapters)) {
      const chapters = Object.fromEntries(Object.entries(value.chapters as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
      return { epoch: value.epoch, chapters };
    }
  } catch {
    // 落到下面。
  }
  // 文件坏了：拿它的哈希当纪元。各章版本号都和坏之前对不上（存稿撞版本、留恢复稿，不会盖错），下一次写换成好的。
  return { epoch: `invalid-${createHash("sha256").update(raw, "utf-8").digest("hex").slice(0, 16)}`, chapters: {} };
}

export async function readDraftGens(bookDir: string): Promise<DraftGens> {
  let raw: string;
  try {
    raw = await readFile(join(bookDir, DRAFT_GENS_PATH), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return LEGACY;
    throw error;
  }
  return parseGens(raw);
}

export function draftStampOf(gens: DraftGens, chapter: number): DraftStamp {
  const gen = gens.chapters[String(chapter)];
  return gen === undefined ? { epoch: gens.epoch } : { epoch: gens.epoch, gen };
}

function gensWrite(gens: DraftGens): TxFileWrite {
  const chapters = Object.fromEntries(Object.entries(gens.chapters).sort(([a], [b]) => Number(a) - Number(b)));
  return { path: DRAFT_GENS_PATH, content: `${JSON.stringify({ schema: DRAFT_GENS_SCHEMA, epoch: gens.epoch, chapters }, null, 2)}\n` };
}

/** 这几章的工作稿这次写了：各换成 gen。 */
export function draftGensWrite(gens: DraftGens, chapters: readonly number[], gen: string): TxFileWrite {
  return gensWrite({ epoch: gens.epoch, chapters: { ...gens.chapters, ...Object.fromEntries(chapters.map((chapter) => [String(chapter), gen])) } });
}

/** 撤销 / 恢复后：换新纪元，各章的号清空（每一章的版本号都和恢复前对不上）。 */
export function freshDraftGensWrite(): TxFileWrite {
  return gensWrite({ epoch: randomUUID(), chapters: {} });
}

export const BOOK_EPOCH_SCHEMA = "book-epoch/1" as const;

/**
 * 书的纪元（paths.ts 的 BOOK_EPOCH_PATH）。文件不在 = 还没换过（空串）；坏了拿内容的哈希当纪元
 * （和坏之前对不上：旧操作一律不能再写，比放过去安全），下一次换纪元换成好的。
 */
export async function readBookEpoch(bookDir: string): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(join(bookDir, BOOK_EPOCH_PATH), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
  try {
    const value = JSON.parse(raw) as { schema?: unknown; epoch?: unknown };
    if (value.schema === BOOK_EPOCH_SCHEMA && typeof value.epoch === "string" && value.epoch.length > 0) return value.epoch;
  } catch {
    // 落到下面。
  }
  return `invalid-${createHash("sha256").update(raw, "utf-8").digest("hex").slice(0, 16)}`;
}

/**
 * 一次操作自己换出的纪元（整本恢复那次操作）：由操作号定，这次操作认得出是自己换的、照常收尾；别的操作照样对不上。
 */
export const opBookEpoch = (opId: string): string => `op:${opId}`;

/** 换一个新纪元（整本恢复、搬回备份时和别的写放进同一个事务）。给了 epoch 就用它（opBookEpoch），不给随机一个。 */
export function bookEpochWrite(now: Date, epoch: string = randomUUID()): TxFileWrite {
  return { path: BOOK_EPOCH_PATH, content: `${JSON.stringify({ schema: BOOK_EPOCH_SCHEMA, epoch, at: now.toISOString() }, null, 2)}\n` };
}
