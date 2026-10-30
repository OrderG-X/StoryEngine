/**
 * 原句核对：模型声明的每一条都附正文原句，代码确认它真在正文里。这是核心里唯一碰中文文本的地方，
 * 只做两件确定性的事——归一（去空白、统一全半角、去引号）和找子串。不判断意思。
 */

/** 比对时忽略的引号和书名号：模型常把正文的「」写成“”，或者干脆省掉。 */
const IGNORED = new Set(["“", "”", "‘", "’", "「", "」", "『", "』", "\"", "'"]);

/** 归一：NFKC（全角转半角、兼容字统一）后去掉所有空白和引号。 */
export function normalizeForQuote(text: string): string {
  let out = "";
  for (const char of text.normalize("NFKC")) {
    if (IGNORED.has(char) || char.trim() === "") continue;
    out += char;
  }
  return out;
}

/** 原句最短多少字（归一后）才算数：太短的片段几乎处处能命中，等于没核。 */
export const MIN_QUOTE_LENGTH = 4;

/**
 * 原句在不在正文里。模型引长句时常用省略号截掉中间：按「…」或「...」切段，每段都得按顺序出现在正文里。
 * 每段至少 2 个字，整句（去掉省略号）至少 MIN_QUOTE_LENGTH 个字。
 */
export function quoteInText(quote: string, text: string): boolean {
  const haystack = normalizeForQuote(text);
  const segments = normalizeForQuote(quote)
    .split("...")
    .filter((segment) => segment.length > 0);
  const total = segments.reduce((sum, segment) => sum + segment.length, 0);
  if (segments.length === 0 || total < MIN_QUOTE_LENGTH) return false;
  let from = 0;
  for (const segment of segments) {
    if (segment.length < 2) return false;
    const at = haystack.indexOf(segment, from);
    if (at < 0) return false;
    from = at + segment.length;
  }
  return true;
}

/**
 * 原句照正文原样取回：模型抄的原句核得上（quoteInText），但常多个空格、少个引号、全半角不同——记进账、给作者看的
 * 用正文里那一段原字。按核对时一样的归一找到位置，取正文从第一个字到最后一个字的那段（跨段的去掉段间换行）；几截的用「……」接上。核不上给 undefined。
 */
export function quoteFromText(quote: string, text: string): string | undefined {
  if (!quoteInText(quote, text)) return undefined;
  const { haystack, origin } = normalizedWithOrigin(text);
  const segments = quoteSegments(quote);
  const pieces: string[] = [];
  let from = 0;
  for (const segment of segments) {
    const at = haystack.indexOf(segment, from);
    const last = origin[at + segment.length - 1]!;
    // 跨段摘的不带段落间的换行：清单、设定本里一行显示。
    pieces.push(text.slice(origin[at]!, last + String.fromCodePoint(text.codePointAt(last)!).length).replace(/\s*\n\s*/gu, ""));
    from = at + segment.length;
  }
  return pieces.join("……");
}

/** 归一后的正文，和每个归一后的字在原文里的位置（原句定位用）。 */
export function normalizedWithOrigin(text: string): { readonly haystack: string; readonly origin: readonly number[] } {
  let haystack = "";
  const origin: number[] = [];
  for (let index = 0; index < text.length; ) {
    const char = String.fromCodePoint(text.codePointAt(index)!);
    for (const part of normalizeForQuote(char)) {
      haystack += part;
      origin.push(index);
    }
    index += char.length;
  }
  return { haystack, origin };
}

/** 原句按省略号切成的几截（归一后）。 */
export const quoteSegments = (quote: string): string[] => normalizeForQuote(quote).split("...").filter((segment) => segment.length > 0);

/**
 * 名字、主体、属性的比对键：同一个写法的不同排版算同一个（去空白、引号、全半角、大小写）。
 * 只认写法完全一样；「钥匙」和「钟箱钥匙」是两样东西，要归一起得靠记账员声明，不靠代码猜。
 */
export function nameKey(name: string): string {
  return normalizeForQuote(name).toLowerCase();
}
