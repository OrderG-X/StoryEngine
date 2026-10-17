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
 * 名字、主体、属性的比对键：同一个写法的不同排版算同一个（去空白、引号、全半角、大小写）。
 * 只认写法完全一样；「钥匙」和「钟箱钥匙」是两样东西，要归一起得靠记账员声明，不靠代码猜。
 */
export function nameKey(name: string): string {
  return normalizeForQuote(name).toLowerCase();
}
