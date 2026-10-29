import { chinesePunctuation, chinesePunctuationLike } from "../lib/dialogue-quotes.js";
import { stripMarkdownEmphasis } from "../lib/markdown-emphasis.js";

/**
 * 流式出稿时稿纸上显示的正文：去掉模型开头那行「# 第一章 · 标题」。
 * 模型常把章名写成 Markdown 标题行，出稿完成后引擎会把它剥掉（标题另存）；但流式期间它会先在稿纸顶上露出来，
 * 写完又突然消失（2026-10-07 改版走查）。这里只改显示：标题行还没写完（没遇到换行）时先不显示，写完整行就整行去掉。
 * 只认 Markdown 标题行（# 开头）；正文里的普通句子不动。成对的粗体记号也去掉、英文直引号、半角逗号换成中文的（落盘时同样处理，见 lib/markdown-emphasis、lib/dialogue-quotes）。
 * 接着往下写时传本来写好的那段（base）：标点跟着它的写法，和落盘一样。
 */
export function streamingDraftDisplay(raw: string, base?: string): string {
  const body = stripMarkdownEmphasis(withoutHeadingLine(raw));
  return base ? chinesePunctuationLike(base, body) : chinesePunctuation(body);
}

function withoutHeadingLine(raw: string): string {
  const leading = raw.match(/^\s*/u)?.[0] ?? "";
  const rest = raw.slice(leading.length);
  if (!rest.startsWith("#")) return raw; // 章名行白名单：模型输出
  const newline = rest.indexOf("\n");
  if (newline < 0) return "";
  return rest.slice(newline + 1).replace(/^\s*\n/u, "").replace(/^\n+/u, "");
}
