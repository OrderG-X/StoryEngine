/** 色号（token `--cover-0`…`--cover-6`）：书架封面、设定本头像共用。 */
export const TONES = 7;

/** 字 → 稳定的色号（同一个书名 / 名字永远同色）。 */
export function toneOf(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h % TONES;
}
