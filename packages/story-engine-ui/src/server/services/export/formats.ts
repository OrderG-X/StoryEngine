/**
 * 导出的三种格式（P10）：txt、Word（.docx）、epub。纯函数：吃一份整理好的书，吐文件内容。
 * Word 和 epub 都是 zip，走 `lib/zip.ts`，不引第三方包。
 *
 * 排版口径（中文小说常见）：段首空两格；每章另起一页（Word）/ 一个文件（epub）；章名「第 N 章 标题」。
 */
import { randomUUID } from "node:crypto";
import { createZip } from "../../lib/zip.js";

export interface ExportChapter {
  readonly number: number;
  readonly title?: string;
  readonly paragraphs: readonly string[];
}

export interface ExportBook {
  readonly title: string;
  readonly author?: string;
  readonly synopsis?: string;
  readonly chapters: readonly ExportChapter[];
}

export type ExportFormat = "txt" | "docx" | "epub";

export const EXPORT_MIME: Readonly<Record<ExportFormat, string>> = {
  txt: "text/plain; charset=utf-8",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  epub: "application/epub+zip",
};

export function chapterHeading(chapter: ExportChapter): string {
  return chapter.title ? `第${chapter.number}章 ${chapter.title}` : `第${chapter.number}章`;
}

const INDENT = "　　";

/** txt：书名、作者、简介打头；段首两个全角空格，段间空一行。 */
export function toTxt(book: ExportBook): Buffer {
  const lines: string[] = [book.title];
  if (book.author) lines.push(`作者：${book.author}`);
  if (book.synopsis) lines.push("", ...book.synopsis.split("\n").map((line) => `${INDENT}${line.trim()}`));
  for (const chapter of book.chapters) {
    lines.push("", "", chapterHeading(chapter), "");
    lines.push(chapter.paragraphs.map((p) => `${INDENT}${p}`).join("\n\n"));
  }
  return Buffer.from(`${lines.join("\n")}\n`, "utf-8");
}

/** XML 里不许出现的控制字符去掉，再转义。 */
export function xmlText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

function docxParagraph(text: string, style?: string, extraPPr = ""): string {
  const pPr = style || extraPPr ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${extraPPr}</w:pPr>` : "";
  return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${xmlText(text)}</w:t></w:r></w:p>`;
}

/** Word：书名一页（作者、简介），每章另起一页、章名用「标题 1」（Word 导航窗格能跳）。 */
export function toDocx(book: ExportBook, now = new Date()): Buffer {
  const body: string[] = [docxParagraph(book.title, "Title")];
  if (book.author) body.push(docxParagraph(book.author, "Subtitle"));
  if (book.synopsis) for (const line of book.synopsis.split("\n")) if (line.trim()) body.push(docxParagraph(line.trim()));
  for (const chapter of book.chapters) {
    body.push(docxParagraph(chapterHeading(chapter), "Heading1", "<w:pageBreakBefore/>"));
    for (const paragraph of chapter.paragraphs) body.push(docxParagraph(paragraph));
  }
  const document = `${XML_HEAD}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join("")}`
    + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>'
    + "</w:body></w:document>";
  const styles = `${XML_HEAD}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`
    + '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体" w:cs="Times New Roman"/><w:sz w:val="24"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault>'
    + '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="400" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:firstLineChars="200" w:firstLine="480"/><w:jc w:val="both"/></w:pPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="2400" w:after="480"/><w:ind w:firstLineChars="0" w:firstLine="0"/><w:jc w:val="center"/></w:pPr><w:rPr><w:rFonts w:eastAsia="黑体"/><w:b/><w:sz w:val="52"/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="960"/><w:ind w:firstLineChars="0" w:firstLine="0"/><w:jc w:val="center"/></w:pPr><w:rPr><w:sz w:val="28"/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="480" w:after="480"/><w:ind w:firstLineChars="0" w:firstLine="0"/><w:jc w:val="center"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:rFonts w:eastAsia="黑体"/><w:b/><w:sz w:val="32"/></w:rPr></w:style>'
    + "</w:styles>";
  const iso = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const core = `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`
    + `<dc:title>${xmlText(book.title)}</dc:title>${book.author ? `<dc:creator>${xmlText(book.author)}</dc:creator>` : ""}`
    + `<dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified></cp:coreProperties>`;
  return createZip([
    { path: "[Content_Types].xml", data: `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>` },
    { path: "_rels/.rels", data: `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>` },
    { path: "word/_rels/document.xml.rels", data: `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { path: "word/document.xml", data: document },
    { path: "word/styles.xml", data: styles },
    { path: "docProps/core.xml", data: core },
  ]);
}

function xhtmlPage(title: string, body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN" lang="zh-CN"><head><meta charset="UTF-8"/><title>${xmlText(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body>${body}</body></html>`;
}

const EPUB_CSS = "body{margin:0 5%;line-height:1.8;}h1{text-align:center;font-size:1.4em;margin:2em 0 1.5em;}p{text-indent:2em;margin:0 0 .6em;text-align:justify;}"
  + ".cover{text-align:center;margin-top:30%;}.cover h1{font-size:2em;}.cover .author{text-indent:0;text-align:center;margin-top:2em;}.synopsis{margin-top:3em;}";

/** epub 3（带 toc.ncx 兼容老阅读器）：封面页一页，每章一个文件，目录能跳。 */
export function toEpub(book: ExportBook, now = new Date(), id: string = randomUUID()): Buffer {
  const files = book.chapters.map((chapter) => ({ chapter, href: `chapter-${String(chapter.number).padStart(4, "0")}.xhtml`, id: `c${chapter.number}` }));
  const modified = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const coverBody = `<div class="cover"><h1>${xmlText(book.title)}</h1>${book.author ? `<p class="author">${xmlText(book.author)}</p>` : ""}</div>`
    + (book.synopsis ? `<div class="synopsis">${book.synopsis.split("\n").filter((l) => l.trim()).map((l) => `<p>${xmlText(l.trim())}</p>`).join("")}</div>` : "");
  const opf = `<?xml version="1.0" encoding="UTF-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="zh-CN">`
    + `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">urn:uuid:${id}</dc:identifier><dc:title>${xmlText(book.title)}</dc:title><dc:language>zh-CN</dc:language>`
    + `${book.author ? `<dc:creator>${xmlText(book.author)}</dc:creator>` : ""}${book.synopsis ? `<dc:description>${xmlText(book.synopsis)}</dc:description>` : ""}<meta property="dcterms:modified">${modified}</meta></metadata>`
    + '<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="css" href="style.css" media-type="text/css"/><item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>'
    + files.map((f) => `<item id="${f.id}" href="${f.href}" media-type="application/xhtml+xml"/>`).join("")
    + '</manifest><spine toc="ncx"><itemref idref="cover"/>' + files.map((f) => `<itemref idref="${f.id}"/>`).join("") + "</spine></package>";
  const nav = xhtmlPage("目录", `<nav epub:type="toc" id="toc"><h1>目录</h1><ol>${files.map((f) => `<li><a href="${f.href}">${xmlText(chapterHeading(f.chapter))}</a></li>`).join("")}</ol></nav>`);
  const ncx = `<?xml version="1.0" encoding="UTF-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="urn:uuid:${id}"/></head><docTitle><text>${xmlText(book.title)}</text></docTitle><navMap>`
    + files.map((f, i) => `<navPoint id="n${f.id}" playOrder="${i + 1}"><navLabel><text>${xmlText(chapterHeading(f.chapter))}</text></navLabel><content src="${f.href}"/></navPoint>`).join("")
    + "</navMap></ncx>";
  return createZip([
    { path: "mimetype", data: "application/epub+zip", store: true },
    { path: "META-INF/container.xml", data: '<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>' },
    { path: "OEBPS/content.opf", data: opf },
    { path: "OEBPS/nav.xhtml", data: nav },
    { path: "OEBPS/toc.ncx", data: ncx },
    { path: "OEBPS/style.css", data: EPUB_CSS },
    { path: "OEBPS/cover.xhtml", data: xhtmlPage(book.title, coverBody) },
    ...files.map((f) => ({
      path: `OEBPS/${f.href}`,
      data: xhtmlPage(chapterHeading(f.chapter), `<h1>${xmlText(chapterHeading(f.chapter))}</h1>${f.chapter.paragraphs.map((p) => `<p>${xmlText(p)}</p>`).join("")}`),
    })),
  ]);
}
