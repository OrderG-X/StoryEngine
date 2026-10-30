/**
 * 读一本书的真相：正文、章节账单、作者裁定、版本号。
 *
 * 读的路径不写盘、不拿锁。正在写的事务可能让读到一半：`readBookSnapshot` 前后各读一次版本号，
 * 对不上或有没收尾的事务就重读，几次都不稳就如实标 `unsettled`，不假装读到了一致的数据。
 * 文件不存在 = 空（老书还没导入很正常）；文件坏了 = 抛错并说清是哪个文件，绝不拿空值顶上。
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { AuthorDecisionsFile, AUTHOR_DECISIONS_SCHEMA, type AuthorDecision } from "../schema/decisions.js";
import { SettingCardsFile, type SettingCardsFile as SettingCardsFileType } from "../schema/cards.js";
import { BookHead, BOOK_HEAD_SCHEMA, type BookHead as BookHeadType } from "../schema/book.js";
import { ChapterLedger } from "../schema/ledger.js";
import { isLedgerV1 } from "../ledger/migrate-v1.js";
import {
  CHAPTER_LEDGER_DIR,
  chapterFromFileName,
  chapterLedgerPath,
  chapterTextPath,
  CARDS_PATH,
  DECISIONS_PATH,
  HEAD_PATH,
  REVISION_PATH,
} from "./paths.js";
import { hasPendingTransactions } from "./transaction.js";
import { rawHash, truthBasisOf, type TruthBasis } from "./basis.js";

/** 真相文件坏了（不是不存在）。 */
export class BookFileError extends Error {
  readonly code = "BOOK_FILE_INVALID";
  constructor(readonly file: string, readonly reason: string) {
    super(`${file} 读不了：${reason}`);
    this.name = "BookFileError";
  }
}

async function readOptional(bookDir: string, relativePath: string): Promise<string | undefined> {
  try {
    return await readFile(join(bookDir, relativePath), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function parseJson<T>(relativePath: string, raw: string, schema: z.ZodType<T>): T {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new BookFileError(relativePath, "不是合法的 JSON");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new BookFileError(relativePath, `${first?.path.join(".") || "根"}：${first?.message ?? "格式不对"}`);
  }
  return parsed.data;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

export async function readHead(bookDir: string): Promise<BookHeadType> {
  const raw = await readOptional(bookDir, HEAD_PATH);
  if (raw === undefined) return { schema: BOOK_HEAD_SCHEMA, version: 0, updatedAt: "" };
  return parseJson(HEAD_PATH, raw, BookHead);
}

export async function readChapterText(bookDir: string, chapter: number): Promise<string | undefined> {
  return readOptional(bookDir, chapterTextPath(chapter));
}

/**
 * 账单还是旧格式（v1）：这本书还没升级。运行期不顺手升、不当空账，如实失败；开书时升（`ledger.migrate`）。
 */
export class LedgerNeedsUpgradeError extends BookFileError {
  readonly needsUpgrade = true;
  constructor(file: string) {
    super(file, "这本书的账本格式要升级，重新打开一次这本书");
    this.name = "LedgerNeedsUpgradeError";
  }
}

function parseChapterLedger(chapter: number, raw: string): ChapterLedger {
  const path = chapterLedgerPath(chapter);
  if (isLedgerV1(raw)) throw new LedgerNeedsUpgradeError(path);
  const ledger = parseJson(path, raw, ChapterLedger);
  if (ledger.chapter !== chapter) throw new BookFileError(path, `里面写的是第 ${ledger.chapter} 章`);
  return ledger;
}

export async function readChapterLedger(bookDir: string, chapter: number): Promise<ChapterLedger | undefined> {
  const raw = await readOptional(bookDir, chapterLedgerPath(chapter));
  return raw === undefined ? undefined : parseChapterLedger(chapter, raw);
}

/** 有账单的章号，按章号排好（只列目录，不读内容）。 */
export async function listChapterLedgers(bookDir: string): Promise<readonly number[]> {
  let names: string[];
  try {
    names = await readdir(join(bookDir, CHAPTER_LEDGER_DIR));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .map(chapterFromFileName)
    .filter((chapter): chapter is number => chapter !== undefined)
    .sort((a, b) => a - b);
}

/** 全部章节账单，按章号排好。 */
export async function readAllLedgers(bookDir: string): Promise<readonly ChapterLedger[]> {
  const chapters = await listChapterLedgers(bookDir);
  const ledgers: ChapterLedger[] = [];
  for (const chapter of chapters) {
    const ledger = await readChapterLedger(bookDir, chapter);
    if (ledger) ledgers.push(ledger);
  }
  return ledgers;
}

export async function readDecisions(bookDir: string): Promise<readonly AuthorDecision[]> {
  const raw = await readOptional(bookDir, DECISIONS_PATH);
  if (raw === undefined) return [];
  return parseJson(DECISIONS_PATH, raw, AuthorDecisionsFile).decisions;
}

export function decisionsFileText(decisions: readonly AuthorDecision[]): string {
  return `${JSON.stringify({ schema: AUTHOR_DECISIONS_SCHEMA, decisions }, null, 2)}\n`;
}

/** 设定卡；文件不在 = undefined（新书还没建、老书还没迁）。 */
export async function readCards(bookDir: string): Promise<SettingCardsFileType | undefined> {
  const raw = await readOptional(bookDir, CARDS_PATH);
  if (raw === undefined) return undefined;
  return parseJson(CARDS_PATH, raw, SettingCardsFile);
}

export function cardsFileText(file: SettingCardsFileType): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** 已定稿的章号（有正文文件的）。 */
export async function listChapterTexts(bookDir: string): Promise<readonly number[]> {
  let names: string[];
  try {
    names = await readdir(join(bookDir, "chapters"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names
    .filter((name) => name.endsWith(".md"))
    .map(chapterFromFileName)
    .filter((chapter): chapter is number => chapter !== undefined)
    .sort((a, b) => a - b);
}

export interface BookSnapshot {
  readonly version: number;
  readonly ledgers: readonly ChapterLedger[];
  readonly decisions: readonly AuthorDecision[];
  /** 设定卡（不在 = undefined）。 */
  readonly cards: SettingCardsFileType | undefined;
  /** 每章正文现在的 sha256（和账单里的比，就知道定稿后改没改过）。 */
  readonly textHashes: ReadonlyMap<number, string>;
  /** 这份快照读到的四样真相的原样哈希（写作版本 P1a）：按它算出来的预览，确认时拿它核书变没变。 */
  readonly basis: TruthBasis;
  /** 读的时候正好在写、重试几次都没读稳：数据可能是新旧混着的，调用方要如实说。 */
  readonly unsettled: boolean;
}

interface RawTruth {
  readonly revision: string | undefined;
  readonly ledgers: readonly { readonly chapter: number; readonly raw: string }[];
  readonly decisions: string | undefined;
  readonly cards: string | undefined;
  readonly texts: ReadonlyMap<number, string>;
}

/** 四样真相按原样读出来（不解析）：快照和确认时核依据都从这里读，两边算的哈希同一个口径。 */
async function readRawTruth(bookDir: string): Promise<RawTruth> {
  // 代次先读：读真相的中途有写，记下的是旧代次，确认时对不上（见 basis.ts）。
  const revision = await readOptional(bookDir, REVISION_PATH);
  const [ledgerChapters, decisions, cards, textChapters] = await Promise.all([
    listChapterLedgers(bookDir),
    readOptional(bookDir, DECISIONS_PATH),
    readOptional(bookDir, CARDS_PATH),
    listChapterTexts(bookDir),
  ]);
  const ledgers: { chapter: number; raw: string }[] = [];
  for (const chapter of ledgerChapters) {
    const raw = await readOptional(bookDir, chapterLedgerPath(chapter));
    if (raw !== undefined) ledgers.push({ chapter, raw });
  }
  const texts = new Map<number, string>();
  for (const chapter of textChapters) {
    const text = await readChapterText(bookDir, chapter);
    if (text !== undefined) texts.set(chapter, sha256(text));
  }
  return { revision, ledgers, decisions, cards, texts };
}

function basisOfRaw(raw: RawTruth): TruthBasis {
  return truthBasisOf({
    revision: rawHash(raw.revision),
    texts: raw.texts,
    ledgers: new Map(raw.ledgers.map((item) => [item.chapter, sha256(item.raw)])),
    decisions: rawHash(raw.decisions),
    cards: rawHash(raw.cards),
  });
}

/** 书现在的真相依据（不写盘、不拿锁；要和写互斥的调用方自己在书锁里调）。 */
export async function readTruthBasis(bookDir: string): Promise<TruthBasis> {
  return basisOfRaw(await readRawTruth(bookDir));
}

async function readOnce(bookDir: string): Promise<Omit<BookSnapshot, "unsettled">> {
  const head = await readHead(bookDir);
  const raw = await readRawTruth(bookDir);
  const ledgers = raw.ledgers.map((item) => parseChapterLedger(item.chapter, item.raw));
  const decisions = raw.decisions === undefined ? [] : parseJson(DECISIONS_PATH, raw.decisions, AuthorDecisionsFile).decisions;
  const cards = raw.cards === undefined ? undefined : parseJson(CARDS_PATH, raw.cards, SettingCardsFile);
  return { version: head.version, ledgers, decisions, cards, textHashes: raw.texts, basis: basisOfRaw(raw) };
}

/** 读一份前后一致的真相快照（不写盘、不拿锁）。 */
export async function readBookSnapshot(bookDir: string, attempts = 3): Promise<BookSnapshot> {
  let last: Omit<BookSnapshot, "unsettled"> | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const before = (await readHead(bookDir)).version;
    last = await readOnce(bookDir);
    const after = (await readHead(bookDir)).version;
    if (before === after && last.version === after && !(await hasPendingTransactions(bookDir))) {
      return { ...last, unsettled: false };
    }
    await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
  }
  return { ...(last as Omit<BookSnapshot, "unsettled">), unsettled: true };
}
