/**
 * 找原句（重构 P4）：模型转述「作者的话」时（如出稿的 chapterGoal），逐句核对它确实出自作者之口。
 *
 * 只做两件确定性的事：按标点和空白切句；去掉标点和空白后比子串。不判断意思、不认同义词——
 * 转述得再像，不是原话就不算。
 */
const PUNCTUATION_OR_SPACE = /[\s\p{P}\p{S}]+/gu;

function squash(text: string): string {
  return text.replace(PUNCTUATION_OR_SPACE, "");
}

export interface AuthorQuoteCheck {
  /** 在作者话里找得到的句子（原样，按出现顺序）。 */
  readonly quoted: readonly string[];
  /** 找不到的句子。 */
  readonly notFound: readonly string[];
}

/** text 逐句比对作者说过的话（任一条里能找到就算）。 */
export function checkAuthorQuote(text: string, authorWords: readonly string[]): AuthorQuoteCheck {
  const sources = authorWords.map(squash).filter((source) => source.length > 0);
  const quoted: string[] = [];
  const notFound: string[] = [];
  for (const clause of text.split(PUNCTUATION_OR_SPACE)) {
    const squashed = squash(clause);
    if (!squashed) continue;
    if (sources.some((source) => source.includes(squashed))) quoted.push(clause);
    else notFound.push(clause);
  }
  return { quoted, notFound };
}
