import { describe, expect, it } from "vitest";
import { readSerialHeading, serialChapterFile, serialFileStem, splitSerialText } from "./serial-split.js";

describe("认标题行", () => {
  it("第 N 章 / 回 / 节，中文数字、阿拉伯数字、全角数字都认，章名是后面那截", () => {
    expect(readSerialHeading("第一章 雨夜")).toEqual({ kind: "chapter", title: "雨夜", heading: "第一章 雨夜" });
    expect(readSerialHeading("　　第12章：钟停了　")).toMatchObject({ kind: "chapter", title: "钟停了" });
    expect(readSerialHeading("第１２３回")).toMatchObject({ kind: "chapter", title: "" });
    expect(readSerialHeading("第三百零二节 · 归来")).toMatchObject({ kind: "chapter", title: "归来" });
    expect(readSerialHeading("正文 第一章 开端")).toMatchObject({ kind: "chapter", title: "开端" });
    expect(readSerialHeading("## 第2章 外乡人")).toMatchObject({ kind: "chapter", title: "外乡人" });
    expect(readSerialHeading("Chapter 7 The Bell")).toMatchObject({ kind: "chapter", title: "The Bell" });
  });

  it("楔子、序章、尾声、番外整行当章名", () => {
    expect(readSerialHeading("楔子")).toMatchObject({ kind: "chapter", title: "楔子" });
    expect(readSerialHeading("序章：钟楼")).toMatchObject({ kind: "chapter", title: "序章：钟楼" });
    expect(readSerialHeading("番外篇 雪夜")).toMatchObject({ kind: "chapter", title: "番外篇 雪夜" });
  });

  it("分卷行单独认出来；正文里碰巧以「第几章」开头的句子不算标题", () => {
    expect(readSerialHeading("第一卷 潮起")).toEqual({ kind: "volume" });
    expect(readSerialHeading("第一节课他就睡着了。")).toBeUndefined();
    expect(readSerialHeading(`第一章${"长".repeat(60)}`)).toBeUndefined();
    expect(readSerialHeading("楔子打进木头里，纹丝不动")).toBeUndefined();
    expect(readSerialHeading("她翻到第三章")).toBeUndefined();
  });
});

describe("切章", () => {
  it("按标题切，段落一行一段、去掉缩进，第一个标题前的字单独交出", () => {
    const split = splitSerialText([{
      name: "钟楼.txt",
      text: "﻿作品简介：一个关于钟楼的故事。\r\n\r\n第一章 钟停\r\n　　钟停在三点十五分。\r\n　　沈青禾推开门。\r\n\r\n第二章 外乡人\r\n　　第二天上午，外乡人又来了。\r\n",
    }]);
    expect(split.parts).toEqual([
      { kind: "preamble", title: "", body: "作品简介：一个关于钟楼的故事。", chars: 13, file: "钟楼.txt" },
      { kind: "chapter", title: "钟停", heading: "第一章 钟停", body: "钟停在三点十五分。\n\n沈青禾推开门。", chars: 14, file: "钟楼.txt" },
      { kind: "chapter", title: "外乡人", heading: "第二章 外乡人", body: "第二天上午，外乡人又来了。", chars: 11, file: "钟楼.txt" },
    ]);
    expect(split).toMatchObject({ emptyDropped: 0, volumeLines: 0 });
  });

  it("分卷行去掉；只有标题没有正文的空章丢掉并计数（平台导出常把章名重复一遍）", () => {
    const split = splitSerialText([{ name: "a.txt", text: "第一卷 潮起\n第一章 雨夜\n第一章 雨夜\n雨下了一夜。\n第二章 天晴\n" }]);
    expect(split.parts.map((part) => [part.kind, part.title, part.body])).toEqual([["chapter", "雨夜", "雨下了一夜。"]]);
    expect(split).toMatchObject({ emptyDropped: 2, volumeLines: 1 });
  });

  it("几个文件按文件名排（数字按大小），没有标题的文件整篇一章、章名取文件名", () => {
    const split = splitSerialText([
      { name: "10 尾声.txt", text: "大家都走了。" },
      { name: "2 钟停.txt", text: "钟停了。" },
      { name: "1 楔子.md", text: "# 楔子\n很多年前。" },
    ]);
    expect(split.parts.map((part) => [part.title, part.body])).toEqual([["楔子", "很多年前。"], ["2 钟停", "钟停了。"], ["10 尾声", "大家都走了。"]]);
  });

  it("文件名当书名：去掉扩展名和书名号", () => {
    expect(serialFileStem("/tmp/《钟楼》.txt")).toBe("钟楼");
    expect(serialFileStem("雾港来信.md")).toBe("雾港来信");
  });

  it("导进书里的正文文件：第一行「# 第N章 · 章名」，没章名只写章号", () => {
    expect(serialChapterFile(3, "钟停", "钟停了。\n\n她来了。")).toBe("# 第3章 · 钟停\n\n钟停了。\n\n她来了。\n");
    expect(serialChapterFile(4, " ", "正文")).toBe("# 第4章\n\n正文\n");
  });
});
