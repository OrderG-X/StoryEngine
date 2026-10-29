/**
 * 切章：把作者导进来的整本书（一个或几个 txt / md 文件）按章节标题行切成一章一章。纯函数，不碰盘。
 *
 * 只认格式，不猜意思：
 *  - 标题行 = 去掉开头的 `#` 后不超过 40 个字、不以句末标点收尾，并且是下面几种之一：
 *    「第 N 章 / 回 / 节」（前面可以带「正文」两个字）、「楔子 / 序章 / 序幕 / 引子 / 尾声 / 终章 / 后记 / 番外…」、「Chapter N」。
 *  - 「第 N 卷 / 部 / 集」是分卷行：不进正文，也不开新章。
 *  - 第一个标题前面的字单独交出来（简介、作者的话、也可能是正文），导不导由作者勾。
 *  - 一个标题都没认出来的文件整篇当一章，章名取文件名。没有正文的空章丢掉，如实计数。
 *  - 段落：每个非空行一段，去掉行首尾的空白（含全角空格），段与段之间空一行。
 * 几个文件按文件名排（里面的数字按大小比），再依次切。
 */
import { CHAPTER_NUMERAL } from "./chapter-title.js";

export interface SerialFile {
  readonly name: string;
  readonly text: string;
}

export interface SerialPart {
  /** preamble = 文件里第一个标题前面的字；chapter = 一章。 */
  readonly kind: "preamble" | "chapter";
  /** 章名（「第 N 章」后面那截；楔子、番外这种就是整行；整篇当一章的是文件名）。前言是空串。 */
  readonly title: string;
  /** 原来的标题行（整篇当一章、前言没有）。 */
  readonly heading?: string;
  /** 正文：段与段之间空一行。 */
  readonly body: string;
  /** 正文字数（只数汉字，和书架同口径）。 */
  readonly chars: number;
  /** 出自哪个文件。 */
  readonly file: string;
}

export interface SerialSplit {
  readonly parts: readonly SerialPart[];
  /** 丢掉的空章（只有标题没有正文）。 */
  readonly emptyDropped: number;
  /** 认出、去掉的分卷行。 */
  readonly volumeLines: number;
}

/** 标题行最长多少字：再长就是正文里碰巧以「第三章」开头的句子。 */
export const SERIAL_HEADING_MAX_CHARS = 40;

// 不猜白名单开始：章节标题
const NUMERAL = CHAPTER_NUMERAL;
const CHAPTER_HEADING = new RegExp(`^(?:正文\\s*)?第\\s*${NUMERAL}\\s*[章回节]`, "u");
const VOLUME_HEADING = new RegExp(`^(?:正文\\s*)?第\\s*${NUMERAL}\\s*[卷部集]`, "u");
const SPECIAL_HEADING = /^(?:(?:楔子|序章|序幕|引子|尾声|终章|后记)(?=$|[\s:：·.．、,，\-—_（(【[])|番外|外传)/u;
const SENTENCE_END = /[。！？!?…”」』]$/u;
const TITLE_LEAD = /^[\s:：·.．、,，\-—_]+/u;
// 不猜白名单结束
const ENGLISH_HEADING = /^chapter\s*\d+/iu;
const MARKDOWN_HASHES = /^#{1,6}\s*/u; // 章名行白名单：导入切章

type HeadingLine =
  | { readonly kind: "chapter"; readonly title: string; readonly heading: string }
  | { readonly kind: "volume" };

/** 这一行是不是标题行（是就给章名）。 */
export function readSerialHeading(rawLine: string): HeadingLine | undefined {
  const line = cleanLine(rawLine).replace(MARKDOWN_HASHES, "").trim();
  if (line.length === 0 || line.length > SERIAL_HEADING_MAX_CHARS || SENTENCE_END.test(line)) return undefined;
  if (VOLUME_HEADING.test(line) && !CHAPTER_HEADING.test(line)) return { kind: "volume" };
  const numbered = CHAPTER_HEADING.exec(line) ?? ENGLISH_HEADING.exec(line);
  if (numbered) return { kind: "chapter", title: line.slice(numbered[0].length).replace(TITLE_LEAD, "").trim(), heading: line };
  if (SPECIAL_HEADING.test(line)) return { kind: "chapter", title: line, heading: line };
  return undefined;
}

/** 去掉行首尾的空白（含全角空格、不换行空格）和 BOM。 */
function cleanLine(line: string): string {
  return line.replace(/^[\s\u3000\u00a0\ufeff]+|[\s\u3000\u00a0\ufeff]+$/gu, "");
}

/** 字数和书架、稿纸同一个口径：只数汉字（标点、空白、西文不计）。 */
function countHanChars(text: string): number {
  return (text.match(/[\u3400-\u9fff]/gu) ?? []).length;
}

/** 文件名去掉扩展名和书名号，当章名 / 书名用。 */
export function serialFileStem(name: string): string {
  const base = name.split(/[\\/]/u).pop() ?? name;
  const stem = base.replace(/\.[^.]+$/u, "").trim();
  // 不猜白名单：章节标题
  return stem.replace(/^《(.+)》$/u, "$1").trim() || stem;
}

/** 文件名排序：里面的数字按大小比（第 2 章排在第 10 章前面）。 */
function byFileName(a: SerialFile, b: SerialFile): number {
  return a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true });
}

export function splitSerialText(files: readonly SerialFile[]): SerialSplit {
  const parts: SerialPart[] = [];
  let emptyDropped = 0;
  let volumeLines = 0;
  for (const file of [...files].sort(byFileName)) {
    const lines = file.text.replace(/\r\n?/gu, "\n").split("\n");
    let current: { kind: SerialPart["kind"]; title: string; heading?: string; paragraphs: string[] } = { kind: "preamble", title: "", paragraphs: [] };
    let sawHeading = false;
    const close = () => {
      const body = current.paragraphs.join("\n\n");
      if (body.length === 0) {
        if (current.kind === "chapter") emptyDropped += 1;
        return;
      }
      parts.push({
        kind: current.kind,
        title: current.title,
        ...(current.heading ? { heading: current.heading } : {}),
        body,
        chars: countHanChars(body),
        file: file.name,
      });
    };
    for (const raw of lines) {
      const heading = readSerialHeading(raw);
      if (heading?.kind === "volume") {
        volumeLines += 1;
        continue;
      }
      if (heading) {
        close();
        sawHeading = true;
        current = { kind: "chapter", title: heading.title, heading: heading.heading, paragraphs: [] };
        continue;
      }
      const line = cleanLine(raw);
      if (line.length > 0) current.paragraphs.push(line);
    }
    // 一个标题都没有：整篇当一章，章名取文件名。
    if (!sawHeading) current = { ...current, kind: "chapter", title: serialFileStem(file.name) };
    close();
  }
  return { parts, emptyDropped, volumeLines };
}

/** 导进书里的一章正文文件：第一行「# 第N章 · 章名」（没章名就只写章号），空一行接正文。 */
export function serialChapterFile(chapter: number, title: string, body: string): string {
  const name = title.trim();
  return `# 第${chapter}章${name ? ` · ${name}` : ""}\n\n${body.trim()}\n`;
}
