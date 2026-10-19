// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readZip } from "../../lib/zip.js";
import { toDocx, toEpub, toTxt, xmlText, type ExportBook } from "./formats.js";

const BOOK: ExportBook = {
  title: "雾港来信",
  author: "某某",
  synopsis: "邮局夜班分拣员收到一封署名父亲的退信。\n她决定查下去。",
  chapters: [
    { number: 1, title: "死信", paragraphs: ["灯管闪了一下，又稳住。", "“这批是超期的。”孟叔说，<别嫌麻烦> & 规矩。"] },
    { number: 2, paragraphs: ["第二章没有章名。"] },
  ],
};

const text = (zip: Buffer, path: string) => readZip(zip).find((e) => e.path === path)!.data.toString("utf-8");

describe("导出格式", () => {
  it("txt：书名、作者、简介打头，章名「第 N 章 标题」，段首两个全角空格、段间空一行", () => {
    const out = toTxt(BOOK).toString("utf-8");
    expect(out.startsWith("雾港来信\n作者：某某\n\n　　邮局夜班")).toBe(true);
    expect(out).toContain("\n\n\n第1章 死信\n\n　　灯管闪了一下，又稳住。\n\n　　“这批是超期的。”");
    expect(out).toContain("第2章\n\n　　第二章没有章名。\n");
  });

  it("Word：每章另起一页、章名是标题 1，特殊字符转义，包里该有的部件都在", () => {
    const zip = toDocx(BOOK, new Date("2026-10-20T00:00:00Z"));
    const paths = readZip(zip).map((e) => e.path);
    expect(paths).toEqual(["[Content_Types].xml", "_rels/.rels", "word/_rels/document.xml.rels", "word/document.xml", "word/styles.xml", "docProps/core.xml"]);
    const doc = text(zip, "word/document.xml");
    expect(doc).toContain('<w:pStyle w:val="Heading1"/><w:pageBreakBefore/></w:pPr><w:r><w:t xml:space="preserve">第1章 死信</w:t>');
    expect(doc).toContain("&lt;别嫌麻烦&gt; &amp; 规矩");
    expect(doc.match(/<w:pageBreakBefore\/>/g)?.length).toBe(2);
    expect(text(zip, "docProps/core.xml")).toContain("<dc:title>雾港来信</dc:title><dc:creator>某某</dc:creator>");
  });

  it("epub：mimetype 打头不压缩，目录两份（nav + ncx），每章一个文件", () => {
    const zip = toEpub(BOOK, new Date("2026-10-20T00:00:00Z"), "fixed-id");
    const entries = readZip(zip);
    expect(entries[0]!.path).toBe("mimetype");
    expect(entries.map((e) => e.path)).toContain("OEBPS/chapter-0002.xhtml");
    const opf = text(zip, "OEBPS/content.opf");
    expect(opf).toContain("<dc:identifier id=\"bookid\">urn:uuid:fixed-id</dc:identifier>");
    expect(opf).toContain('<meta property="dcterms:modified">2026-10-20T00:00:00Z</meta>');
    expect(opf).toContain('<itemref idref="cover"/><itemref idref="c1"/><itemref idref="c2"/>');
    expect(text(zip, "OEBPS/nav.xhtml")).toContain('<a href="chapter-0001.xhtml">第1章 死信</a>');
    expect(text(zip, "OEBPS/toc.ncx")).toContain("<text>第2章</text>");
    expect(text(zip, "OEBPS/chapter-0001.xhtml")).toContain("<p>“这批是超期的。”孟叔说，&lt;别嫌麻烦&gt; &amp; 规矩。</p>");
  });

  it("XML 里不许的控制字符去掉", () => {
    expect(xmlText("a\u0001b\u000bc\td\ne")).toBe("abc\td\ne");
  });
});
