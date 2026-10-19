/**
 * 导出一本书（P10）：按范围收章，整理成 `ExportBook`，再交给 formats 出文件。
 *
 * 收哪些章：默认只收定稿章（`chapters/NNNN.md`）；勾了「带上工作稿」就把还没定稿的工作稿也收进来，
 * 同一章两份都有时用工作稿（作者最新改的那版）。段落按行切：每个非空行一段，去掉行首的全角 / 半角空格（排版时统一加）。
 */
import { readChapterPaper } from "@actalk/story-core";
import { readBookMeta } from "../../lib/book-info.js";
import { extractDraftTitle, readUiChapterFileStates } from "../../lib/project-io.js";
import { EXPORT_MIME, toDocx, toEpub, toTxt, type ExportBook, type ExportChapter, type ExportFormat } from "./formats.js";

export interface ExportOptions {
  readonly format: ExportFormat;
  readonly from?: number;
  readonly to?: number;
  readonly includeDrafts?: boolean;
}

export interface ExportResult {
  readonly data: Buffer;
  readonly filename: string;
  readonly mime: string;
  readonly chapters: number;
}

const EXT: Readonly<Record<ExportFormat, string>> = { txt: "txt", docx: "docx", epub: "epub" };

export function splitParagraphs(body: string): string[] {
  return body
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.trim()) // \s 含全角空格
    .filter((line) => line.length > 0);
}

export async function collectExportBook(projectDir: string, options: Omit<ExportOptions, "format">): Promise<ExportBook> {
  const meta = await readBookMeta(projectDir);
  const states = await readUiChapterFileStates(projectDir);
  const from = options.from ?? 1;
  const to = options.to ?? Number.MAX_SAFE_INTEGER;
  const wanted = states
    .filter((state) => state.chapter >= from && state.chapter <= to)
    .filter((state) => state.hasCommittedChapter || (options.includeDrafts === true && state.hasDraftFile))
    .map((state) => state.chapter)
    .sort((a, b) => a - b);
  const chapters: ExportChapter[] = [];
  for (const chapter of wanted) {
    const paper = await readChapterPaper(projectDir, chapter);
    const source = options.includeDrafts === true && paper.draft ? paper.draft : paper.committed;
    if (!source) continue;
    // 章名去掉「第 N 章 ·」前缀，排版时统一加回。
    const title = source.title ? extractDraftTitle(`# ${source.title}`) : null;
    chapters.push({ number: chapter, ...(title ? { title } : {}), paragraphs: splitParagraphs(source.body) });
  }
  return {
    title: meta.title,
    ...(meta.info.author ? { author: meta.info.author } : {}),
    ...(meta.info.synopsis ? { synopsis: meta.info.synopsis } : {}),
    chapters,
  };
}

/** 文件名里不许的字符换掉。 */
export function safeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "_").trim() || "未命名";
}

export async function exportBook(projectDir: string, options: ExportOptions): Promise<ExportResult> {
  const book = await collectExportBook(projectDir, options);
  if (book.chapters.length === 0) {
    throw new Error(options.includeDrafts ? "这个范围里一章都没有。" : "这个范围里没有定稿的章（要带上工作稿可以勾上）。");
  }
  const data = options.format === "docx" ? toDocx(book) : options.format === "epub" ? toEpub(book) : toTxt(book);
  const first = book.chapters[0]!.number;
  const last = book.chapters.at(-1)!.number;
  const ranged = options.from !== undefined || options.to !== undefined;
  const suffix = ranged ? (first === last ? `-第${first}章` : `-第${first}-${last}章`) : "";
  return { data, filename: `${safeFileName(book.title)}${suffix}.${EXT[options.format]}`, mime: EXPORT_MIME[options.format], chapters: book.chapters.length };
}
