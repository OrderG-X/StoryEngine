/**
 * 工作稿文件的样子（纯文本，不碰盘；前端稿纸和服务端用同一份，见 package.json 的 `./draft-format`）。
 *
 * 一份稿 = 章名 + 正文（写作版本 P1 第 13 轮复核）：比对、指纹、存稿回执都按整份算。
 * 文件第一行非空行是「# 章名」就是章名，其余是正文。章名有两个来处——单给的章名、正文开头自带的章名行——
 * 只认一个：**单给了章名（空串也算给了，= 没有章名）就以它为准**，正文开头的章名行去掉；没给才认正文开头那行。
 */

const HEADING = /^#{1,6}\s+(.*)$/u;

export interface DraftText {
  readonly title?: string;
  readonly body: string;
}

/** 正文开头的章名行：第几行、章名（行里只有「#」没有字的，章名是空）。没有就是 undefined。 */
export function leadingHeading(text: string): { readonly line: number; readonly title: string } | undefined {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  const first = lines.findIndex((line) => line.trim().length > 0);
  if (first < 0) return undefined;
  const heading = HEADING.exec(lines[first]!.trim());
  return heading ? { line: first, title: heading[1]!.trim() } : undefined;
}

/** 去掉正文开头的章名行（连同它前面的空行），其余原样。 */
function withoutHeading(text: string): string {
  const heading = leadingHeading(text);
  if (!heading) return text;
  return text.replace(/\r\n?/gu, "\n").split("\n").slice(heading.line + 1).join("\n");
}

/** 正文开头有章名行就把它换成这个章名（章名空就去掉那一行）；没有章名行原样返回。稿纸改章名时用：两个来处说的始终是同一个。 */
export function retitleText(text: string, title: string): string {
  const heading = leadingHeading(text);
  if (!heading) return text;
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  const name = title.trim();
  if (name) lines[heading.line] = `# ${name}`;
  else lines.splice(heading.line, lines[heading.line + 1]?.trim() === "" ? 2 : 1);
  return lines.join("\n");
}

/** 拆文件：第一行非空行是「# 章名」就当章名，其余是正文。 */
export function parseDraftFile(fileText: string): DraftText {
  const heading = leadingHeading(fileText);
  const body = withoutHeading(fileText).replace(/\r\n?/gu, "\n").trim();
  return heading?.title ? { title: heading.title, body } : { body };
}

/**
 * 一份稿的规范样子：title 给了（含空串）就以它为准、正文开头的章名行去掉；没给就认正文开头那行。
 * 正文去首尾空白；章名去首尾空白，空就是没有。
 */
export function normalizeDraft(input: { readonly title?: string; readonly body: string }): DraftText {
  if (input.title === undefined) return parseDraftFile(input.body);
  const title = input.title.trim();
  const body = withoutHeading(input.body).replace(/\r\n?/gu, "\n").trim();
  return title ? { title, body } : { body };
}

/** 拼文件（输入先按 normalizeDraft 规范）：有章名就写在第一行。 */
export function composeDraftFile(input: { readonly title?: string; readonly body: string }): string {
  const draft = normalizeDraft(input);
  if (!draft.title) return draft.body ? `${draft.body}\n` : "";
  return draft.body ? `# ${draft.title}\n\n${draft.body}\n` : `# ${draft.title}\n`;
}

/** 只差换行写法、行尾空白、多余空行的两份正文算同一份（稿纸重新载入会收掉多余空段落）。 */
export function sameDraftBody(a: string, b: string): boolean {
  const tidy = (text: string) => text.replace(/\r\n?/gu, "\n").split("\n").map((line) => line.trimEnd()).join("\n").replace(/\n{3,}/gu, "\n\n").trim();
  return tidy(a) === tidy(b);
}

/** 是不是同一份稿：各自规范之后，章名一样、正文按 sameDraftBody 一样。 */
export function sameDraft(a: { readonly title?: string; readonly body: string }, b: { readonly title?: string; readonly body: string }): boolean {
  const left = normalizeDraft(a);
  const right = normalizeDraft(b);
  return (left.title ?? "") === (right.title ?? "") && sameDraftBody(left.body, right.body);
}
