/**
 * 工作稿：作者在稿纸上写、AI 起草或改稿的那一份（还没定稿的正文）。
 *
 * 一章一份文件 `drafts/fast/chapter-NNNN.md`（沿用老书路径），第一行「# 章名」可有可无。
 * 版本号 = 文件全文的哈希：谁改了文件（作者存稿、AI 改稿、撤销把文件换回去），版本号自然就变，
 * 不用另记一份计数，也不怕撤销把计数和正文拆开。
 *
 * 存稿要带「我是在哪个版本上改的」（baseVersion）：和盘上对不上就不存、把盘上那份如实交回去，
 * 由编辑器决定换上还是留作者自己那版——不会悄悄互相覆盖。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readChapterText, sha256 } from "../store/book.js";
import { draftPath } from "../store/paths.js";

export interface Draft {
  readonly chapter: number;
  /** 文件第一行「# 章名」里的章名；没有就是 undefined。 */
  readonly title?: string;
  /** 去掉章名行后的正文。 */
  readonly body: string;
  /** 文件全文的哈希（前 16 位）。 */
  readonly version: string;
}

const HEADING = /^#{1,6}\s+(.*)$/u;

export function draftVersionOf(fileText: string): string {
  return sha256(fileText).slice(0, 16);
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

/** 读一章的工作稿；没有文件就是 undefined。 */
export async function readDraft(bookDir: string, chapter: number): Promise<Draft | undefined> {
  let text: string;
  try {
    text = await readFile(join(bookDir, draftPath(chapter)), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return { chapter, ...parseDraftFile(text), version: draftVersionOf(text) };
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
