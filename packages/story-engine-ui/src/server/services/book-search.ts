/**
 * 全书搜正文（2026-10-22 对标走查：⌘K 只搜章名、设定、命令，「铜钱」在几十章里出现也搜不到）。
 *
 * 按字面找作者输入的那几个字，不猜意思。每章搜稿纸上显示的那份：有工作稿搜工作稿，没有搜定稿。
 * 每章给第一处的上下文（不跨段，点了能在稿纸上找到这句）和出现几次。读路径不写盘、不拿锁。
 */
import { readChapterPaper } from "@actalk/story-core";
import { readUiChapterFileStates } from "../lib/project-io.js";

export interface BookTextHit {
  readonly chapter: number;
  readonly title?: string;
  /** 这章出现几次。 */
  readonly count: number;
  /** 第一处的上下文，截断处带「…」。 */
  readonly snippet: string;
  /** 第一处所在的原文片段（不带省略号），稿纸上回原句用。 */
  readonly quote: string;
}

export interface BookTextSearch {
  readonly hits: readonly BookTextHit[];
  /** 有几章出现（可能比 hits 多：hits 只给前 limit 章）。 */
  readonly chapters: number;
  readonly occurrences: number;
}

const BEFORE = 14;
const AFTER = 24;
export const BOOK_SEARCH_LIMIT = 40;

/** 英文字母不分大小写；转小写改了长度（极少数字符）就按原样比，免得位置对不上。 */
function comparable(text: string, query: string): { readonly text: string; readonly query: string } {
  const lowText = text.toLowerCase();
  const lowQuery = query.toLowerCase();
  return lowText.length === text.length && lowQuery.length === query.length ? { text: lowText, query: lowQuery } : { text, query };
}

/** 一章正文里找 query：几次、第一处的上下文。没有返回 undefined。 */
export function findInBody(body: string, rawQuery: string): Pick<BookTextHit, "count" | "snippet" | "quote"> | undefined {
  const query = rawQuery.trim();
  if (!query) return undefined;
  const { text, query: needle } = comparable(body, query);
  const first = text.indexOf(needle);
  if (first < 0) return undefined;
  let count = 0;
  for (let at = first; at >= 0; at = text.indexOf(needle, at + needle.length)) count += 1;
  const lineStart = body.lastIndexOf("\n", first) + 1;
  const lineBreak = body.indexOf("\n", first + needle.length);
  const lineEnd = lineBreak < 0 ? body.length : lineBreak;
  const start = Math.max(lineStart, first - BEFORE);
  const end = Math.min(lineEnd, first + needle.length + AFTER);
  const quote = body.slice(start, end).trim();
  const snippet = `${start > lineStart ? "…" : ""}${quote}${end < lineEnd ? "…" : ""}`;
  return { count, snippet, quote };
}

export async function searchBookText(projectDir: string, rawQuery: string, limit = BOOK_SEARCH_LIMIT): Promise<BookTextSearch> {
  const query = rawQuery.trim();
  if (!query) return { hits: [], chapters: 0, occurrences: 0 };
  const states = await readUiChapterFileStates(projectDir);
  const hits: BookTextHit[] = [];
  let chapters = 0;
  let occurrences = 0;
  for (const state of [...states].sort((a, b) => a.chapter - b.chapter)) {
    const paper = await readChapterPaper(projectDir, state.chapter);
    const source = state.hasDraftFile && paper.draft ? paper.draft : paper.committed;
    if (!source) continue;
    const found = findInBody(source.body, query);
    if (!found) continue;
    chapters += 1;
    occurrences += found.count;
    if (hits.length < limit) hits.push({ chapter: state.chapter, ...(source.title ? { title: source.title } : {}), ...found });
  }
  return { hits, chapters, occurrences };
}
