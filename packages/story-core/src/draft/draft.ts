/**
 * 工作稿：作者在稿纸上写、AI 起草或改稿的那一份（还没定稿的正文）。
 *
 * 一章一份文件 `drafts/fast/chapter-NNNN.md`（沿用老书路径），第一行「# 章名」可有可无。
 * 版本号 = 这一章的工作稿代次 + 文件全文的哈希（代次见 store/control.ts）：谁写了文件（作者存稿、AI 改稿）这章换新号，
 * 撤销 / 恢复换新纪元。只用全文哈希不够：R → 作者存 A → AI 换 B → 撤销回 R，照 R 发的旧存稿和撤销后的版本号一模一样，
 * 会把撤销的结果又盖成 A（写作版本 P1b 第 3 轮复核）。代次不进存档点，撤销翻不回去。
 *
 * 存稿要带「我是在哪个版本上改的」（baseVersion）：和盘上对不上就不存、把盘上那份如实交回去，
 * 由编辑器决定换上还是留作者自己那版——不会悄悄互相覆盖。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readChapterText, sha256 } from "../store/book.js";
import { draftStampOf, readDraftGens, type DraftStamp } from "../store/control.js";
import { draftPath } from "../store/paths.js";

export interface Draft {
  readonly chapter: number;
  /** 文件第一行「# 章名」里的章名；没有就是 undefined。 */
  readonly title?: string;
  /** 去掉章名行后的正文。 */
  readonly body: string;
  /** 代次 + 文件全文的哈希（前 16 位）。 */
  readonly version: string;
}

const HEADING = /^#{1,6}\s+(.*)$/u;

/** 老书（还没换过纪元、这章没号）就是全文的哈希，升级前打开的稿纸照样对得上。 */
export function draftVersionOf(fileText: string, stamp: DraftStamp): string {
  if (!stamp.epoch && stamp.gen === undefined) return sha256(fileText).slice(0, 16);
  return sha256(`${stamp.epoch}\u0000${stamp.gen ?? ""}\u0000${fileText}`).slice(0, 16);
}

/** 一章工作稿此刻的代次。 */
export async function readDraftStamp(bookDir: string, chapter: number): Promise<DraftStamp> {
  return draftStampOf(await readDraftGens(bookDir), chapter);
}

/** 拆文件：第一行非空行是「# 章名」就当章名，其余是正文。 */
export function parseDraftFile(fileText: string): { readonly title?: string; readonly body: string } {
  const lines = fileText.replace(/\r\n?/gu, "\n").split("\n");
  const first = lines.findIndex((line) => line.trim().length > 0);
  if (first < 0) return { body: "" };
  const heading = HEADING.exec(lines[first]!.trim());
  if (!heading) return { body: lines.slice(first).join("\n").trim() };
  const title = heading[1]!.trim();
  const body = lines.slice(first + 1).join("\n").trim();
  return { ...(title ? { title } : {}), body };
}

/** 拼文件：正文自己带「# 章名」就照写；否则有章名就补在第一行。 */
export function composeDraftFile(input: { readonly title?: string; readonly body: string }): string {
  const body = input.body.replace(/\r\n?/gu, "\n").trim();
  const firstLine = body.split("\n").find((line) => line.trim().length > 0) ?? "";
  if (HEADING.test(firstLine.trim())) return `${body}\n`;
  const title = input.title?.trim();
  if (!title) return body ? `${body}\n` : "";
  return body ? `# ${title}\n\n${body}\n` : `# ${title}\n`;
}

/** 只差换行写法、行尾空白、多余空行的两份正文算同一份（稿纸重新载入会收掉多余空段落）。 */
export function sameDraftBody(a: string, b: string): boolean {
  const tidy = (text: string) => text.replace(/\r\n?/gu, "\n").split("\n").map((line) => line.trimEnd()).join("\n").replace(/\n{3,}/gu, "\n\n").trim();
  return tidy(a) === tidy(b);
}

/**
 * 一章工作稿的原样全文和版本号（一起读，版本号就是这份全文的）；没有文件就是 undefined。
 * 代次先读、正文后读：正赶上写，算出的版本号谁都对不上（存稿撞版本，不会盖错）。
 */
export async function readDraftFile(bookDir: string, chapter: number): Promise<{ readonly text: string; readonly version: string } | undefined> {
  const stamp = await readDraftStamp(bookDir, chapter);
  let text: string;
  try {
    text = await readFile(join(bookDir, draftPath(chapter)), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return { text, version: draftVersionOf(text, stamp) };
}

/** 读一章的工作稿；没有文件就是 undefined。 */
export async function readDraft(bookDir: string, chapter: number): Promise<Draft | undefined> {
  const file = await readDraftFile(bookDir, chapter);
  return file && { chapter, ...parseDraftFile(file.text), version: file.version };
}

export interface ChapterPaper {
  readonly chapter: number;
  /** 工作稿；没有就是 null。 */
  readonly draft: Draft | null;
  /** 定稿正文；没定稿就是 null。 */
  readonly committed: { readonly title?: string; readonly body: string } | null;
  /** 定稿后工作稿又改过（两份都在且正文不一样）；没定稿或没工作稿就是 null。 */
  readonly editedSinceCommit: boolean | null;
}

/** 稿纸打开一章要的全部：工作稿、定稿、定稿后改过没有。 */
export async function readChapterPaper(bookDir: string, chapter: number): Promise<ChapterPaper> {
  const [draft, committedText] = await Promise.all([readDraft(bookDir, chapter), readChapterText(bookDir, chapter)]);
  const committed = committedText === undefined ? null : parseDraftFile(committedText);
  return {
    chapter,
    draft: draft ?? null,
    committed,
    editedSinceCommit: draft && committed ? !sameDraftBody(draft.body, committed.body) : null,
  };
}
