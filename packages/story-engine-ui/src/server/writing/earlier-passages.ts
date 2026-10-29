/**
 * 按章纲翻旧章原文（2026-10-08 写作主链重设计·阶段 2「翻资料」）。
 *
 * 为什么：事实账本是模型抽出来的一句话摘要，会漏、会走样（十章验收：登记表上的地址前后 4 个版本，铁皮盒里的
 * 东西 4 套说法）。正文才是真值源——章纲点名了「登记表」「南门菜场」，就把旧章里写到它们的原文段落翻出来，
 * 让写手照着原文保持一致，而不是凭印象重写。
 *
 * 纯确定性、题材中立、不调模型：按词面在已定稿章节里找段落，近章优先，每个词最多取几段、总量封顶。
 */
import { parseDraftFile } from "@actalk/story-core";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface EarlierPassage {
  readonly chapter: number;
  /** 命中的检索词（物件/地点/人物名）。 */
  readonly term: string;
  /** 原文片段（以命中词为中心截取）。 */
  readonly text: string;
}

export interface FindEarlierPassagesInput {
  readonly projectDir: string;
  /** 正在写的章号：只翻它之前的已定稿章节。 */
  readonly chapter: number;
  readonly terms: readonly string[];
  /** 不翻的章（上一章已经整章给了）。 */
  readonly excludeChapters?: readonly number[];
  readonly maxPerTerm?: number;
  readonly maxTotal?: number;
  readonly windowChars?: number;
}

const DEFAULT_MAX_PER_TERM = 2;
const DEFAULT_MAX_TOTAL = 10;
const DEFAULT_WINDOW = 240;

/** 读已定稿章节（chapters/NNNN.md），按章号倒序（近章在前）。目录不存在 → 空。 */
async function readCommittedChapters(projectDir: string, beforeChapter: number): Promise<readonly { readonly chapter: number; readonly body: string }[]> {
  let files: string[];
  try {
    files = await readdir(join(projectDir, "chapters"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const chapters = files
    .map((file) => /^(\d{4})\.md$/u.exec(file))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map((match) => Number(match[1]))
    .filter((chapter) => chapter < beforeChapter)
    .sort((a, b) => b - a);
  const out: { chapter: number; body: string }[] = [];
  for (const chapter of chapters) {
    const content = await readFile(join(projectDir, "chapters", `${String(chapter).padStart(4, "0")}.md`), "utf-8");
    out.push({ chapter, body: parseDraftFile(content).body });
  }
  return out;
}

/** 以命中位置为中心截一段，尽量对齐到句读。 */
function excerptAround(paragraph: string, index: number, termLength: number, window: number): string {
  if (paragraph.length <= window) return paragraph.trim();
  const half = Math.floor((window - termLength) / 2);
  let start = Math.max(0, index - half);
  let end = Math.min(paragraph.length, index + termLength + half);
  // 不猜白名单开始：切句
  const sentenceStart = paragraph.slice(0, start).search(/[。！？…][^。！？…]*$/u);
  if (sentenceStart >= 0 && start - sentenceStart < 60) start = sentenceStart + 1;
  const tail = paragraph.slice(end).search(/[。！？…]/u);
  // 不猜白名单结束
  if (tail >= 0 && tail < 60) end += tail + 1;
  return `${start > 0 ? "…" : ""}${paragraph.slice(start, end).trim()}${end < paragraph.length ? "…" : ""}`;
}

export async function findEarlierPassages(input: FindEarlierPassagesInput): Promise<readonly EarlierPassage[]> {
  const terms = [...new Set(input.terms.map((term) => term.trim()).filter((term) => term.length >= 2))];
  if (terms.length === 0) return [];
  const exclude = new Set(input.excludeChapters ?? []);
  const maxPerTerm = input.maxPerTerm ?? DEFAULT_MAX_PER_TERM;
  const maxTotal = input.maxTotal ?? DEFAULT_MAX_TOTAL;
  const window = input.windowChars ?? DEFAULT_WINDOW;
  const chapters = (await readCommittedChapters(input.projectDir, input.chapter)).filter((item) => !exclude.has(item.chapter));

  // 每个词：先取最近一次写到它的那段，再取第一次写到它的那段（它是怎么被介绍的——2026-10-10 引擎升级第 4 期：
  // 原来只取最近两处，长篇里第 1 章介绍某物的原句再也回不来），名额还有再按近章补。同一章只取它第一次出现的那段。
  // 再轮流取「各词第 1 段 → 各词第 2 段」，让总量封顶时每个词都先分到一段。最后按章号正序给写手读。
  const byTerm = terms.map((term) => {
    const hits: EarlierPassage[] = [];
    for (const { chapter, body } of chapters) {
      const paragraph = body.split(/\n+/u).map((item) => item.trim()).find((item) => item.includes(term));
      if (!paragraph) continue;
      hits.push({ chapter, term, text: excerptAround(paragraph, paragraph.indexOf(term), term.length, window) });
    }
    if (hits.length <= maxPerTerm) return hits;
    const picked = [hits[0]!, hits.at(-1)!];
    for (const hit of hits.slice(1, -1)) {
      if (picked.length >= maxPerTerm) break;
      picked.push(hit);
    }
    return picked.slice(0, Math.max(1, maxPerTerm));
  });
  const seenText = new Set<string>();
  const out: EarlierPassage[] = [];
  for (let round = 0; round < maxPerTerm && out.length < maxTotal; round += 1) {
    for (const found of byTerm) {
      const passage = found[round];
      if (!passage || seenText.has(passage.text)) continue;
      seenText.add(passage.text);
      out.push(passage);
      if (out.length >= maxTotal) break;
    }
  }
  return out.sort((a, b) => a.chapter - b.chapter);
}
