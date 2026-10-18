/**
 * 句级聚焦的纯逻辑：把段落纯文本切成句子区间、按 caret 定位当前句、算打字机居中滚动偏移。
 * 抽成纯函数便于单测——ProseMirror/真实滚动在 jsdom 下不稳，交真机验（沿用 draftEditorSync/findHighlight 惯例）。
 */

/** 句子区间：相对传入纯文本的字符 offset，前闭后开 [start, end)。 */
export interface SentenceRange {
  readonly start: number;
  readonly end: number;
}

// 中文/英文句末标点，连同紧随的右引号/右括号归入本句；或一段换行。
// 不猜白名单：切句
const BOUNDARY = /[。！？…!?]+[”’」』）)]*|\n+/gu;

/** 把纯文本切成句子区间。标点/换行归入其所结束的句；保证区间无缝覆盖全文、不丢字符。 */
export function splitSentences(text: string): SentenceRange[] {
  if (text.length === 0) return [];
  const ranges: SentenceRange[] = [];
  let start = 0;
  BOUNDARY.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BOUNDARY.exec(text)) !== null) {
    const end = m.index + m[0].length;
    ranges.push({ start, end });
    start = end;
  }
  if (start < text.length) ranges.push({ start, end: text.length });
  return ranges;
}

/** 给 caret offset，返回它所在的句子区间。边界(caret==end)归前一句；越界夹紧。 */
export function activeSentenceRange(text: string, caret: number): SentenceRange | null {
  const ranges = splitSentences(text);
  if (ranges.length === 0) return null;
  const c = Math.max(0, Math.min(caret, text.length));
  for (const r of ranges) {
    if (c > r.start && c <= r.end) return r;
  }
  // c==0 或落在首句 start 上
  return ranges[0];
}

/**
 * 打字机居中滚动：让 caret 的 y（相对滚动容器内容顶部）落在可视高度的 ratio 处（默认 0.45）。
 * 返回目标 scrollTop（>=0）。纯算术，组件把它喂给容器的 scrollTop / scrollTo。
 */
export function typewriterScrollTop(input: {
  readonly caretTop: number;
  readonly viewportHeight: number;
  readonly ratio?: number;
}): number {
  const ratio = input.ratio ?? 0.45;
  return Math.max(0, Math.round(input.caretTop - input.viewportHeight * ratio));
}
