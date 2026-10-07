/**
 * 选区改写前把选区对齐到整句：只选了半句（「…三十岁的人，骑」）去润色，模型会把句子补完整，
 * 应用时只替换了选中的半句，后半句就重复了一遍（2026-10-07 浏览器走查实锤）。
 * 纯函数：在一段文字里把 [start, end) 往外扩到句子边界（句号/问号/叹号/省略号，连同紧跟的引号括号）。
 */
const TERMINATOR = /[。！？!?…]/u;
const CLOSER = /[”」』）)"'’]/u;

/** 位置 i 之前（不含 i）是不是一句话的结尾。 */
function endsSentenceBefore(text: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && CLOSER.test(text[j]!)) j -= 1;
  return j >= 0 && TERMINATOR.test(text[j]!);
}

export function sentenceSpan(text: string, start: number, end: number): { readonly start: number; readonly end: number } {
  let s = Math.max(0, Math.min(start, text.length));
  let e = Math.max(s, Math.min(end, text.length));
  // 起点往前退到上一句的结尾之后（或段首）。
  while (s > 0 && !endsSentenceBefore(text, s) && text[s - 1] !== "\n") s -= 1;
  while (s < e && /\s/u.test(text[s]!)) s += 1;
  // 终点：已经停在句末就不动；否则往后走到这句结束（含紧跟的引号括号），或段尾。
  if (!endsSentenceBefore(text, e)) {
    while (e < text.length && !TERMINATOR.test(text[e]!) && text[e] !== "\n") e += 1;
    if (e < text.length && TERMINATOR.test(text[e]!)) {
      e += 1;
      while (e < text.length && (TERMINATOR.test(text[e]!) || CLOSER.test(text[e]!))) e += 1;
    }
  }
  return { start: s, end: e };
}
