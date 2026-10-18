/**
 * 近几章反复出现的说法（2026-10-08 写作主链重设计·十章验收第二轮）。
 *
 * 验收：「一屋子的钟在黑暗里响着，各走各的」「暗铜色」「台灯下那几张纸」这类收尾意象和描写一章接一章地用，
 * 读者第三遍就腻。写手每章只看得到上一章，自己察觉不到跨章复用。这里确定性地从最近几章里找出跨章复现的
 * 4–10 字片段，交给拟章纲 / 写手「本章别再用」。
 *
 * 纯确定性、题材中立、不调模型。人名、地名、物件名这类专有名词反复出现是正常的——含已知名字的片段不算。
 */

export interface RecurringPhrase {
  readonly phrase: string;
  /** 出现过的章号（升序）。 */
  readonly chapters: readonly number[];
}

export interface FindRecurringPhrasesInput {
  /** 最近几章正文（不含标题），章号任意顺序。 */
  readonly chapters: readonly { readonly chapter: number; readonly body: string }[];
  /** 专有名词（人名/地名/物件名）：含这些的片段不算复用。 */
  readonly knownNames?: readonly string[];
  /**
   * 剧情用语参照（如事实账本全文）：在这里出现过的片段是故事本身的名物/事项（「工商变更登记」「亲属关系证明」），
   * 复现是剧情需要，不算描写复用。
   */
  readonly domainText?: string;
  /** 至少出现在几章里才算（默认 3）。章末段落里的意象只要 2 章就算。 */
  readonly minChapters?: number;
  readonly limit?: number;
}

const MIN_LEN = 4;
/** 报出来的片段至少这么长：四字的「看了一眼」「搁在桌上」是日常用语，不算复用。 */
const MIN_REPORT_LEN = 5;
const MAX_LEN = 10;
const ENDING_CHARS = 240;
/** 这些字开头/结尾的片段多半是被切在词中间的残片，不要。 */
// 不猜白名单：切句
const EDGE_NOISE = /^[的了着过和与在是也都就而又把被让给对从向往]|[的了着过和与在是也都就而又把被让给对从向往]$/u;

function cjkRuns(text: string): readonly string[] {
  // 不猜白名单：切句
  return text.match(/[㐀-鿿]+/gu) ?? [];
}

function ngramsOf(text: string): Set<string> {
  const grams = new Set<string>();
  for (const run of cjkRuns(text)) {
    const chars = Array.from(run);
    for (let length = MIN_LEN; length <= MAX_LEN; length += 1) {
      for (let start = 0; start + length <= chars.length; start += 1) {
        grams.add(chars.slice(start, start + length).join(""));
      }
    }
  }
  return grams;
}

export function findRecurringPhrases(input: FindRecurringPhrasesInput): readonly RecurringPhrase[] {
  const minChapters = input.minChapters ?? 3;
  const limit = input.limit ?? 12;
  const names = (input.knownNames ?? []).map((name) => name.trim()).filter((name) => name.length >= 2);
  const presence = new Map<string, Set<number>>();
  const endingPresence = new Map<string, Set<number>>();
  // 专有名词先抹成断句符：跨在名字上的片段（「舟去了回记铜」）整个不产生，比事后按包含关系过滤干净。
  const sortedNames = [...names].sort((a, b) => b.length - a.length);
  const mask = (text: string) => sortedNames.reduce((acc, name) => acc.split(name).join("｜"), text);
  for (const { chapter, body: rawBody } of input.chapters) {
    const body = mask(rawBody);
    for (const gram of ngramsOf(body)) {
      const set = presence.get(gram) ?? new Set<number>();
      set.add(chapter);
      presence.set(gram, set);
    }
    for (const gram of ngramsOf(body.trim().slice(-ENDING_CHARS))) {
      const set = endingPresence.get(gram) ?? new Set<number>();
      set.add(chapter);
      endingPresence.set(gram, set);
    }
  }
  const candidates: RecurringPhrase[] = [];
  const domain = input.domainText ?? "";
  const consider = (gram: string, chapters: Set<number>) => {
    if (EDGE_NOISE.test(gram)) return;
    if (domain && domain.includes(gram)) return;
    if (names.some((name) => gram.includes(name) || name.includes(gram))) return;
    candidates.push({ phrase: gram, chapters: [...chapters].sort((a, b) => a - b) });
  };
  for (const [gram, chapters] of presence) {
    if (chapters.size >= minChapters) consider(gram, chapters);
  }
  for (const [gram, chapters] of endingPresence) {
    if (chapters.size >= 2 && (presence.get(gram)?.size ?? 0) < minChapters) consider(gram, chapters);
  }
  // 长的优先、复现章数多的优先；被已选的更长片段包含的不重复列。
  candidates.sort((a, b) => b.chapters.length - a.chapters.length || b.phrase.length - a.phrase.length);
  const picked: { phrase: string; chapters: readonly number[] }[] = [];
  for (const candidate of candidates.sort((a, b) => b.phrase.length - a.phrase.length || b.chapters.length - a.chapters.length)) {
    if (picked.some((item) => item.phrase.includes(candidate.phrase))) continue;
    // 同一句话被切成好几段重叠的 n 元组（「一屋子的钟在黑暗里响」「屋子的钟在黑暗里响着」）：首尾相接就拼回一句。
    const joined = picked.find((item) => sameChapters(item.chapters, candidate.chapters) && overlapJoin(item.phrase, candidate.phrase));
    if (joined) {
      joined.phrase = overlapJoin(joined.phrase, candidate.phrase)!;
      continue;
    }
    picked.push({ phrase: candidate.phrase, chapters: candidate.chapters });
  }
  return picked
    .filter((item) => Array.from(item.phrase).length >= MIN_REPORT_LEN)
    .sort((a, b) => b.chapters.length - a.chapters.length || b.phrase.length - a.phrase.length)
    .slice(0, limit);
}

function sameChapters(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** a 的结尾与 b 的开头（或反过来）重叠 ≥ MIN_LEN 字 → 拼成一句；否则 undefined。 */
function overlapJoin(a: string, b: string): string | undefined {
  for (let k = Math.min(a.length, b.length) - 1; k >= MIN_LEN; k -= 1) {
    if (a.endsWith(b.slice(0, k))) return a + b.slice(k);
    if (b.endsWith(a.slice(0, k))) return b + a.slice(k);
  }
  return undefined;
}

