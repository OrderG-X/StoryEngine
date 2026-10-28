/**
 * 模型写出来的标点换成中文的：英文直引号 → 中文弯引号，夹在汉字后面的半角逗号、问号等 → 全角。
 *
 * 引号：写手偶尔整章用英文直引号（长篇连写 2026-10-24：30 章里第 13 章整章、第 16、18 章一半），书里两种引号混着，
 * 改稿时模型再按弯引号改一句，就叠成「许微说，"“昨天……”"」。每段里的直引号按出现顺序一开一合；
 * 一段只有一个的（跨段引语，下一段开头再开）当开引号。
 * 逗号这些：写手偶尔半章用半角逗号（桌面包走查 2026-10-25：一章 93 个「,」）。只换紧跟在汉字或中文标点后面的，
 * 「3,000」「10:30」「OK,」这类前面是数字、字母的不动。
 * 题材中立、纯确定性。前后端共用：出稿落盘、改稿落盘换一遍；流式出稿时稿纸上的显示也换一遍。
 */
export function chinesePunctuation(content: string): string {
  return fullWidthAfterHan(curlyStraightQuotes(content));
}

/**
 * 改稿、接着写换进来的那段（新写一章时是上一章）：作者自己那部分本来就用直引号（一个弯引号都没有）、半角逗号（一个全角逗号都没有），就跟着作者，不换。
 * 弯引号、直角引号也跟着原文（见 quotesLike）。
 */
export function chinesePunctuationLike(context: string, content: string): string {
  const quotes = context.includes("\"") && !context.includes("“") ? content : curlyStraightQuotes(content);
  const punctuated = context.includes(",") && !context.includes("，") ? quotes : fullWidthAfterHan(quotes);
  return quotesLike(context, punctuated);
}

// 不猜白名单开始：自家格式
const CORNER_TO_CURLY: Readonly<Record<string, string>> = { "「": "“", "」": "”", "『": "‘", "』": "’" };
const CURLY_TO_CORNER: Readonly<Record<string, string>> = { "“": "「", "”": "」", "‘": "『", "’": "』" };
// 不猜白名单结束

/**
 * 弯引号「“”」和直角引号「「」」跟着原文：原文对话用的那种多，换进来的那段一个都没用、全用了另一种，就换成原文那种。
 * 换题材长篇实跑第 23 章：作者在对话里用「」引了句台词，写手整章 38 处对话都跟着用了「」，前 22 章全是“”。
 * 两种都用了的不动（可能是作者有意的）。
 */
function quotesLike(context: string, content: string): string {
  const count = (text: string, mark: string) => text.split(mark).length - 1;
  const curly = count(context, "“");
  const corner = count(context, "「");
  if (curly > corner && count(content, "“") === 0 && count(content, "「") > 0) return swap(content, CORNER_TO_CURLY);
  if (corner > curly && count(content, "「") === 0 && count(content, "“") > 0) return swap(content, CURLY_TO_CORNER);
  return content;
}

function swap(content: string, table: Readonly<Record<string, string>>): string {
  let out = "";
  for (const char of content) out += table[char] ?? char;
  return out;
}

function curlyStraightQuotes(content: string): string {
  if (!content.includes("\"")) return content;
  return content.split("\n").map((line) => {
    let open = true;
    let out = "";
    for (const char of line) {
      if (char === "\"") {
        out += open ? "“" : "”";
        open = !open;
      } else {
        out += char;
      }
    }
    return out;
  }).join("\n");
}

// 不猜白名单开始：自家格式
const FULL_WIDTH: Readonly<Record<string, string>> = { ",": "，", "?": "？", "!": "！", ":": "：", ";": "；" };
/** 中文标点：它后面跟的半角逗号也换（「”,」「？!」）。 */
const CJK_PUNCTUATION = new Set(["，", "。", "！", "？", "；", "：", "、", "”", "’", "」", "』", "）", "》", "…", "—"]);
// 不猜白名单结束

function isHan(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0x20000 && code <= 0x2ffff);
}

function fullWidthAfterHan(content: string): string {
  if (!/[,?!:;]/u.test(content)) return content;
  let out = "";
  let previous = "";
  for (const char of content) {
    const wide = FULL_WIDTH[char];
    const next = wide !== undefined && (isHan(previous) || CJK_PUNCTUATION.has(previous)) ? wide : char;
    out += next;
    previous = next;
  }
  return out;
}
