/**
 * 工作稿文件的样子（纯文本，不碰盘；前端稿纸和服务端用同一份，见 package.json 的 `./draft-format`）。
 *
 * 一份稿 = 章名 + 正文（写作版本 P1 第 13、14 轮复核）：比对、指纹、存稿回执都按整份算。同一份稿只有两种样子，
 * **拆过的不再拆**（第 14、15 轮：拆开的正文再当文件拆一次，开头的小节标题就被当章名吃掉了）：
 *
 * 1. **文件原文**（盘上 `drafts/…md`、`chapters/…md`）：第一行非空行是章名行就是章名，其余是正文。只有 `parseDraftFile` 拆它，
 *    只有 `composeDraftFile` 拼它。
 * 2. **拆开的稿** `DraftText`：盘上读出来以后的一切——稿纸（正文在编辑器里，章名在章名入口）、存稿请求、候选、恢复稿、
 *    AI 写好的。章名和正文各是各的，正文里的什么行都是正文，谁都不再拆。`sameDraft` 比两份。
 *
 * 章名行只认一级：`#` 后面跟空白再跟章名，或者只有 `#`（= 章名是空的）。`## 小节` 是正文。
 * 作者在稿纸开头打的「# 某某」也是正文（第 15 轮：稿纸上的字不再认章名行，章名只从章名入口改）。
 */

const TITLE_LINE = /^#(?:[ \t]+(.*))?$/u; // 章名行白名单：文件原文

/** 拆开的稿：title 缺省或空串都是没有章名。 */
export interface DraftText {
  readonly title?: string;
  readonly body: string;
}

const unixLines = (text: string): string => text.replace(/\r\n?/gu, "\n");

/** 开头的章名行：第几行、章名（只有「#」的章名是空串）。第一行非空行不是章名行就是 undefined。 */
function leadingHeading(text: string): { readonly line: number; readonly title: string } | undefined {
  const lines = unixLines(text).split("\n");
  const first = lines.findIndex((line) => line.trim().length > 0);
  if (first < 0) return undefined;
  const heading = TITLE_LINE.exec(lines[first]!.trim());
  return heading ? { line: first, title: (heading[1] ?? "").trim() } : undefined;
}

/** 去掉开头的章名行（连同它前面的空行），其余原样。 */
function withoutHeading(text: string): string {
  const heading = leadingHeading(text);
  if (!heading) return unixLines(text);
  return unixLines(text).split("\n").slice(heading.line + 1).join("\n");
}

/** 拆文件原文（第 1 种样子）：第一行非空行是章名行就是章名，其余是正文。 */
export function parseDraftFile(fileText: string): DraftText {
  const heading = leadingHeading(fileText);
  const body = withoutHeading(fileText).trim();
  return heading?.title ? { title: heading.title, body } : { body };
}

/**
 * 拆开的稿（第 2 种样子）拼回文件：有章名就写在第一行。正文原样（只去首尾空白），一行都不拆。
 * 没章名、正文第一行非空行却是章名行的，前面垫一行空章名「#」：不然再读回来，那一行会被当成章名。
 * 拆开的稿拼回文件、再读回来，还是同一份（`sameDraft`）。
 */
export function composeDraftFile(draft: DraftText): string {
  // 章名只占一行：带进来的换行收成空格，不然再读回来，章名后半截成了正文。
  const title = draft.title?.replace(/\s*\n\s*/gu, " ").trim() ?? "";
  const body = unixLines(draft.body).trim();
  if (!title) {
    if (!body) return "";
    return leadingHeading(body) ? `#\n\n${body}\n` : `${body}\n`;
  }
  return body ? `# ${title}\n\n${body}\n` : `# ${title}\n`;
}

/** 只差换行写法、行尾空白、多余空行的两份正文算同一份（稿纸重新载入会收掉多余空段落）。 */
export function sameDraftBody(a: string, b: string): boolean {
  const tidy = (text: string) => unixLines(text).split("\n").map((line) => line.trimEnd()).join("\n").replace(/\n{3,}/gu, "\n\n").trim();
  return tidy(a) === tidy(b);
}

/** 两份拆开的稿是不是同一份：章名一样（缺省 = 空）、正文按 sameDraftBody 一样。不拆任何一边。 */
export function sameDraft(a: DraftText, b: DraftText): boolean {
  return (a.title?.trim() ?? "") === (b.title?.trim() ?? "") && sameDraftBody(a.body, b.body);
}
