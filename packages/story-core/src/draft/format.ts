/**
 * 工作稿文件的样子（纯文本，不碰盘；前端稿纸和服务端用同一份，见 package.json 的 `./draft-format`）。
 *
 * 一份稿 = 章名 + 正文（写作版本 P1 第 13、14 轮复核）：比对、指纹、存稿回执都按整份算。同一份稿只有三种样子，各有各的入口，
 * **拆过的不再拆**（第 14 轮：拆开的正文再当文件拆一次，开头的小节标题就被当章名吃掉了）：
 *
 * 1. **文件原文**（盘上 `drafts/…md`、`chapters/…md`）：第一行非空行是章名行就是章名，其余是正文。只有 `parseDraftFile` 拆它。
 * 2. **拆开的稿** `DraftText`（候选、恢复稿、AI 写好的、读出来的）：章名和正文各是各的，正文里的什么行都是正文，谁都不再拆。
 *    `composeDraftFile` 拼回文件，`sameDraft` 比两份。
 * 3. **稿纸上的字**（作者在编辑器里看到的）：开头可能是作者打的「# 章名」行，那一行就是章名（稿纸 store 让它和章名入口始终一致）。
 *    只有 `paperDraft` 把它变成拆开的稿。
 *
 * 章名行只认一级：`#` 后面跟空白再跟章名，或者只有 `#`（= 章名是空的）。`## 小节` 是正文。
 */

const TITLE_LINE = /^#(?:[ \t]+(.*))?$/u;

/** 拆开的稿：title 缺省或空串都是没有章名。 */
export interface DraftText {
  readonly title?: string;
  readonly body: string;
}

const unixLines = (text: string): string => text.replace(/\r\n?/gu, "\n");

/** 开头的章名行：第几行、章名（只有「#」的章名是空串）。第一行非空行不是章名行就是 undefined。 */
export function leadingHeading(text: string): { readonly line: number; readonly title: string } | undefined {
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

/** 稿纸上的字开头有章名行就把它换成这个章名（章名空就去掉那一行）；没有章名行原样返回。稿纸改章名时用：两个来处说的始终是同一个。 */
export function retitleText(text: string, title: string): string {
  const heading = leadingHeading(text);
  if (!heading) return text;
  const lines = unixLines(text).split("\n");
  const name = title.trim();
  if (name) lines[heading.line] = `# ${name}`;
  else lines.splice(heading.line, lines[heading.line + 1]?.trim() === "" ? 2 : 1);
  return lines.join("\n");
}

/** 拆文件原文（第 1 种样子）：第一行非空行是章名行就是章名，其余是正文。 */
export function parseDraftFile(fileText: string): DraftText {
  const heading = leadingHeading(fileText);
  const body = withoutHeading(fileText).trim();
  return heading?.title ? { title: heading.title, body } : { body };
}

/**
 * 稿纸上的字（第 3 种样子）→ 拆开的稿：开头的章名行属于章名，不留在正文里。
 * title 给了（空串也算给了）就以它为准；没给才认那一行（老页面存稿不带章名时），那一行也没有就是 undefined（存稿命令沿用盘上的）。
 */
export function paperDraft(text: string, title?: string): { readonly title?: string; readonly body: string } {
  const heading = leadingHeading(text);
  const body = withoutHeading(text).trim();
  const name = title !== undefined ? title.trim() : heading?.title;
  return name !== undefined ? { title: name, body } : { body };
}

/**
 * 拆开的稿（第 2 种样子）拼回文件：有章名就写在第一行。正文原样（只去首尾空白），一行都不拆。
 * 没章名、正文第一行非空行却是章名行的，前面垫一行空章名「#」：不然再读回来，那一行会被当成章名。
 */
export function composeDraftFile(draft: DraftText): string {
  const title = draft.title?.trim() ?? "";
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
