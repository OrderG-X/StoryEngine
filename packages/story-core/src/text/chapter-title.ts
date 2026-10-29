/**
 * 章名开头的章号（写作版本 P1 第 17 轮复核 AE1）：认章名行、剥章号、判「只写了章号没起名」都用这一条规则，
 * 不各写一份（两份不一致，模型写「# 第1章：」就被当成起了名、把作者的章名换掉）。
 */

// 不猜白名单开始：章节标题
/** 章号里的数字：阿拉伯、全角、汉字（含〇、零、两）。 */
export const CHAPTER_NUMERAL = "[0-9０-９零〇一二两三四五六七八九十百千万]+";
const SEPARATORS = "\\s·・：:、，,.．\\-—–~～|｜";
/**
 * 「第一章」「第 12 章」「第〇一章」连同后面的分隔符；连着出现几次（「第1章 · 第1章 · 雨夜」）一起算。
 * 章号后面直接接字的（「第三章的秘密」）不算章号前缀。
 */
const CHAPTER_NUMBER_PREFIX = new RegExp(`^(?:第\\s*${CHAPTER_NUMERAL}\\s*章(?=$|[${SEPARATORS}])[${SEPARATORS}]*)+`, "u");
// 不猜白名单结束

/** 开头是不是章号。 */
export function hasChapterNumberPrefix(title: string): boolean {
  return CHAPTER_NUMBER_PREFIX.test(title.trim());
}

/** 去掉开头的章号剩下的名字；只写了章号是空串。 */
export function bareChapterName(title: string): string {
  return title.trim().replace(CHAPTER_NUMBER_PREFIX, "").trim();
}
