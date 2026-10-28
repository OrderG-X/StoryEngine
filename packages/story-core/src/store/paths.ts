/**
 * 书目录里核心认的路径（全部相对书目录）。
 *
 * 正文沿用老书的 `chapters/NNNN.md`；核心新增的东西都在 `ledger/` 下，老书没有这个目录就是「还没导入」。
 */
import { isAbsolute, normalize, sep } from "node:path";

export const LEDGER_DIR = "ledger";
export const HEAD_PATH = "ledger/head.json";
export const DECISIONS_PATH = "ledger/decisions.json";
/** 设定卡（作者裁定的一部分）。不在 = 还没建（老书还没迁）。 */
export const CARDS_PATH = "ledger/cards.json";
/**
 * 书的写入代次（写作版本 P1a）：每次写真相都换一个新的随机号，撤销 / 恢复也换。
 * 不进存档点（撤销不能把它翻回去）：A→B→撤销回 A 之后，按 A 算的旧预览和现在的书摘要一样，靠它认出中间换过代。
 */
export const REVISION_PATH = "store-control/revision.json";
export const TX_DIR = ".story-core-tx";
/** 收拾不了的坏事务挪到这里留证（作者确认后挪，不删）。 */
export const KEPT_TX_DIR = ".story-core-kept";

const pad = (chapter: number): string => String(chapter).padStart(4, "0");

export function chapterTextPath(chapter: number): string {
  return `chapters/${pad(chapter)}.md`;
}

export function chapterLedgerPath(chapter: number): string {
  return `ledger/chapters/${pad(chapter)}.json`;
}

export const CHAPTER_LEDGER_DIR = "ledger/chapters";

/** 工作稿（还没定稿的正文），沿用老书路径。 */
export function draftPath(chapter: number): string {
  return `drafts/fast/chapter-${pad(chapter)}.md`;
}

export function receiptPath(keyHash: string): string {
  return `ledger/receipts/${keyHash}.json`;
}

/** 文件名 → 章号（`0012.json` / `0012.md` → 12）；不是这个格式返回 undefined。 */
export function chapterFromFileName(name: string): number | undefined {
  const match = /^(\d{4,})\.(json|md)$/u.exec(name);
  if (!match) return undefined;
  const chapter = Number(match[1]);
  return Number.isInteger(chapter) && chapter >= 1 ? chapter : undefined;
}

/** 相对路径必须留在书目录里：不许绝对路径、不许 `..` 出去。 */
export function assertInsideBook(relativePath: string): string {
  const cleaned = normalize(relativePath);
  if (isAbsolute(cleaned) || cleaned === ".." || cleaned.startsWith(`..${sep}`) || cleaned.length === 0) {
    throw new Error(`路径不在书目录里：${relativePath}`);
  }
  return cleaned;
}
