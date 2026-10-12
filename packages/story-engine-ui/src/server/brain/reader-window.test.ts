// @vitest-environment node
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import {
  assembleReaderWindow,
  ensureReaderWindow,
  READER_WINDOW_MAX_CHARS,
  type BrainCallModel,
  type BrainMessage,
  type ReaderRole,
} from "./reader-window.js";

const ROLE: ReaderRole = { id: "tester", system: "你是测试专员。", noteTask: "写笔记。" };

async function makeBook(chapters: number, bodyOf: (chapter: number) => string = (chapter) => `正文${chapter}。`): Promise<string> {
  const dir = await makeHomeTempDir("reader-window-");
  await mkdir(join(dir, "chapters"), { recursive: true });
  for (let chapter = 1; chapter <= chapters; chapter += 1) await writeChapter(dir, chapter, bodyOf(chapter));
  return dir;
}

const writeChapter = (dir: string, chapter: number, body: string) =>
  writeFile(join(dir, "chapters", `${String(chapter).padStart(4, "0")}.md`), `# 第${chapter}章\n\n${body}\n`, "utf-8");

/** 假模型：每章回一句带章号的笔记（故意带首尾空白，验证 trim），记下每次收到的消息。 */
function fakeModel() {
  const calls: { readonly messages: readonly BrainMessage[]; readonly json: boolean }[] = [];
  const callModel: BrainCallModel = async (messages, options) => {
    calls.push({ messages: [...messages], json: options.json });
    return ` 第${/第 (\d+) 章/u.exec(messages.at(-1)!.content)?.[1]}章的笔记 `;
  };
  return { callModel, calls };
}

const notesOf = async (dir: string, root = dir) => (await readdir(join(root, "agents", ROLE.id, "notes")).catch(() => [] as string[])).filter((name) => name.endsWith(".json")).sort();

describe("专员窗口：补笔记", () => {
  it("首次全写：按顺序一章一条，窗口是 [system] + 每章（原文 + 记笔记要求 → 笔记），笔记 trim 后存盘", async () => {
    const dir = await makeBook(3);
    const { callModel, calls } = fakeModel();
    const progress: number[] = [];
    const out = await ensureReaderWindow({ projectDir: dir, role: ROLE, upTo: 3, callModel, onProgress: (chapter) => progress.push(chapter) });
    expect(out).toMatchObject({ built: 3, reused: 0, missing: 0 });
    expect(progress).toEqual([1, 2, 3]);
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => !call.json)).toBe(true);
    expect(out.messages).toHaveLength(7);
    expect(out.messages[0]).toEqual({ role: "system", content: "你是测试专员。" });
    expect(out.messages[1]).toEqual({ role: "user", content: "【第 1 章 定稿原文】\n正文1。\n\n写笔记。" });
    expect(out.messages[2]).toEqual({ role: "assistant", content: "第1章的笔记" });
    // 写第 2 章笔记发出去的消息 = 第 1 章的窗口 + 第 2 章原文
    expect(calls[1]!.messages).toEqual([...out.messages.slice(0, 3), out.messages[3]]);
    const file = JSON.parse(await readFile(join(dir, "agents", "tester", "notes", "0002.json"), "utf-8"));
    expect(file).toMatchObject({ chapter: 2, note: "第2章的笔记" });
    expect(file.textHash).toMatch(/^[0-9a-f]{16}$/u);
    expect(typeof file.createdAt).toBe("string");
    expect((await readdir(join(dir, "agents", "tester", "notes"))).every((name) => name.endsWith(".json"))).toBe(true);
  });

  it("第一章的窗口只有 system；不写任何笔记", async () => {
    const dir = await makeBook(2);
    const { callModel, calls } = fakeModel();
    const out = await ensureReaderWindow({ projectDir: dir, role: ROLE, upTo: 0, callModel });
    expect(out).toEqual({ messages: [{ role: "system", content: "你是测试专员。" }], built: 0, reused: 0, missing: 0 });
    expect(calls).toHaveLength(0);
  });

  it("第二次全复用，不调模型，窗口和第一次逐字一样", async () => {
    const dir = await makeBook(3);
    const first = fakeModel();
    const a = await ensureReaderWindow({ projectDir: dir, role: ROLE, upTo: 3, callModel: first.callModel });
    const second = fakeModel();
    const b = await ensureReaderWindow({ projectDir: dir, role: ROLE, upTo: 3, callModel: second.callModel });
    expect(second.calls).toHaveLength(0);
    expect(b).toMatchObject({ built: 0, reused: 3, missing: 0 });
    expect(b.messages).toEqual(a.messages);
  });

  it("改第 3 章正文：3 及以后重写、1～2 复用；超出这次要读的章号的旧笔记也一并作废", async () => {
    const dir = await makeBook(5);
    await ensureReaderWindow({ projectDir: dir, role: ROLE, upTo: 5, callModel: fakeModel().callModel });
    await writeChapter(dir, 3, "正文3，改过了。");
    const second = fakeModel();
    const out = await ensureReaderWindow({ projectDir: dir, role: ROLE, upTo: 4, callModel: second.callModel });
    expect(out).toMatchObject({ built: 2, reused: 2, missing: 0 });
    expect(second.calls.map((call) => call.messages.at(-1)!.content.match(/第 (\d+) 章/u)![1])).toEqual(["3", "4"]);
    expect(second.calls[0]!.messages.at(-1)!.content).toContain("改过了");
    // 第 5 章的笔记是在旧窗口上写的：已作废，下次读到 5 要重写
    expect(await notesOf(dir)).toEqual(["0001.json", "0002.json", "0003.json", "0004.json"]);
    const third = fakeModel();
    await ensureReaderWindow({ projectDir: dir, role: ROLE, upTo: 5, callModel: third.callModel });
    expect(third.calls).toHaveLength(1);
  });

  it("提示词（角色说明 / 记笔记要求）改了，旧笔记不再算数", async () => {
    const dir = await makeBook(2);
    await ensureReaderWindow({ projectDir: dir, role: ROLE, upTo: 2, callModel: fakeModel().callModel });
    const { callModel, calls } = fakeModel();
    const out = await ensureReaderWindow({ projectDir: dir, role: { ...ROLE, noteTask: "换一种写法记笔记。" }, upTo: 2, callModel });
    expect(out).toMatchObject({ built: 2, reused: 0 });
    expect(calls).toHaveLength(2);
  });

  it("笔记文件坏了当没有，从那一章接着重写", async () => {
    const dir = await makeBook(3);
    await ensureReaderWindow({ projectDir: dir, role: ROLE, upTo: 3, callModel: fakeModel().callModel });
    await writeFile(join(dir, "agents", "tester", "notes", "0002.json"), "{坏的", "utf-8");
    const out = await ensureReaderWindow({ projectDir: dir, role: ROLE, upTo: 3, callModel: fakeModel().callModel });
    expect(out).toMatchObject({ built: 2, reused: 1 });
  });

  it("某章定稿读不到：停在前一章，不报错", async () => {
    const dir = await makeBook(4);
    await rm(join(dir, "chapters", "0003.md"));
    const { callModel, calls } = fakeModel();
    const out = await ensureReaderWindow({ projectDir: dir, role: ROLE, upTo: 4, callModel });
    expect(out).toMatchObject({ built: 2, reused: 0, missing: 0 });
    expect(calls).toHaveLength(2);
    expect(out.messages).toHaveLength(5);
  });

  it("模型调用失败：照实抛出，已写下的笔记留着，下次只补剩下的", async () => {
    const dir = await makeBook(3);
    let count = 0;
    const flaky: BrainCallModel = async () => {
      count += 1;
      if (count === 2) throw new Error("断流了");
      return "笔记";
    };
    await expect(ensureReaderWindow({ projectDir: dir, role: ROLE, upTo: 3, callModel: flaky })).rejects.toThrow("断流了");
    expect(await notesOf(dir)).toEqual(["0001.json"]);
    const { callModel, calls } = fakeModel();
    const out = await ensureReaderWindow({ projectDir: dir, role: ROLE, upTo: 3, callModel });
    expect(out).toMatchObject({ built: 2, reused: 1 });
    expect(calls).toHaveLength(2);
  });

  it("模型回了空笔记：抛错，不存空笔记", async () => {
    const dir = await makeBook(2);
    await expect(ensureReaderWindow({ projectDir: dir, role: ROLE, upTo: 2, callModel: async () => "   " })).rejects.toThrow("第 1 章");
    expect(await notesOf(dir)).toEqual([]);
  });

  it("笔记根目录可以换（评测用）：笔记写在 notesRoot 下，不动书目录", async () => {
    const dir = await makeBook(2);
    const root = await makeHomeTempDir("reader-notes-");
    const { callModel } = fakeModel();
    await ensureReaderWindow({ projectDir: dir, role: ROLE, upTo: 2, callModel, notesRoot: root });
    expect(await notesOf(dir, root)).toEqual(["0001.json", "0002.json"]);
    expect(await readdir(dir)).toEqual(["chapters"]);
  });
});

describe("专员窗口：maxCatchUp", () => {
  it("要新写的笔记超过上限：不写、不调模型，missing > 0、messages 为空", async () => {
    const dir = await makeBook(5);
    const { callModel, calls } = fakeModel();
    const out = await ensureReaderWindow({ projectDir: dir, role: ROLE, upTo: 5, callModel, maxCatchUp: 3 });
    expect(out).toEqual({ messages: [], built: 0, reused: 0, missing: 5 });
    expect(calls).toHaveLength(0);
    expect(await notesOf(dir)).toEqual([]);
  });

  it("没超（含正好等于上限）就照常补；笔记已有的部分不算要补", async () => {
    const dir = await makeBook(5);
    await ensureReaderWindow({ projectDir: dir, role: ROLE, upTo: 2, callModel: fakeModel().callModel });
    const tooMany = await ensureReaderWindow({ projectDir: dir, role: ROLE, upTo: 5, callModel: fakeModel().callModel, maxCatchUp: 2 });
    expect(tooMany).toMatchObject({ messages: [], reused: 2, missing: 3 });
    expect(await notesOf(dir)).toEqual(["0001.json", "0002.json"]);
    const enough = await ensureReaderWindow({ projectDir: dir, role: ROLE, upTo: 5, callModel: fakeModel().callModel, maxCatchUp: 3 });
    expect(enough).toMatchObject({ built: 3, reused: 2, missing: 0 });
  });

  it("后台正在补一长串笔记时，maxCatchUp 的调用不排队干等，马上说没准备好", async () => {
    const dir = await makeBook(6);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow: BrainCallModel = async () => { await gate; return "笔记"; };
    const background = ensureReaderWindow({ projectDir: dir, role: ROLE, upTo: 6, callModel: slow });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const quick = await ensureReaderWindow({ projectDir: dir, role: ROLE, upTo: 6, callModel: slow, maxCatchUp: 2 });
    expect(quick.missing).toBe(6);
    release();
    expect((await background).built).toBe(6);
  });
});

describe("专员窗口：并发", () => {
  it("同一本书同一角色同时来两个调用：只补一遍，模型调用次数不翻倍", async () => {
    const dir = await makeBook(4);
    const calls: string[] = [];
    const slow: BrainCallModel = async (messages) => {
      calls.push(messages.at(-1)!.content.slice(0, 8));
      await new Promise((resolve) => setTimeout(resolve, 5));
      return "笔记";
    };
    const [a, b] = await Promise.all([
      ensureReaderWindow({ projectDir: dir, role: ROLE, upTo: 4, callModel: slow }),
      ensureReaderWindow({ projectDir: dir, role: ROLE, upTo: 4, callModel: slow }),
    ]);
    expect(calls).toHaveLength(4);
    expect(a.built + b.built).toBe(4);
    expect(a.messages).toEqual(b.messages);
  });

  it("前一个失败了，后一个照样排上来接着补", async () => {
    const dir = await makeBook(2);
    const broken: BrainCallModel = async () => { throw new Error("挂了"); };
    const { callModel, calls } = fakeModel();
    const [first, second] = await Promise.allSettled([
      ensureReaderWindow({ projectDir: dir, role: ROLE, upTo: 2, callModel: broken }),
      ensureReaderWindow({ projectDir: dir, role: ROLE, upTo: 2, callModel }),
    ]);
    expect(first.status).toBe("rejected");
    expect(second.status).toBe("fulfilled");
    expect(calls).toHaveLength(2);
  });
});

describe("专员窗口：折叠和缓存前缀", () => {
  const entries = (count: number) => Array.from({ length: count }, (_, index) => ({ chapter: index + 1, body: "甲乙丙丁戊己庚辛壬癸"[(index + 1) % 10]!.repeat(1000), note: "笔记笔记笔" }));

  it("没超预算就一章不折", () => {
    const window = assembleReaderWindow(ROLE, entries(12), READER_WINDOW_MAX_CHARS);
    expect(window).toHaveLength(25);
    expect(window.filter((message) => message.role === "user").every((message) => message.content.includes("定稿原文】"))).toBe(true);
  });

  it("超预算：从第 1 章起每 10 章一块折掉原文、只留笔记，折到不超为止", () => {
    const window = assembleReaderWindow(ROLE, entries(12), 5_000);
    expect(window[1]).toEqual({ role: "user", content: "【第 1 章（原文已省略，见你当时的笔记）】" });
    expect(window[2]).toEqual({ role: "assistant", content: "笔记笔记笔" });
    expect(window[19]!.content).toBe("【第 10 章（原文已省略，见你当时的笔记）】");
    expect(window[21]!.content).toContain("【第 11 章 定稿原文】");
    expect(window.reduce((sum, message) => sum + message.content.length, 0)).toBeLessThanOrEqual(5_000);
  });

  it("同一块里多一章，前面的消息逐字不变（缓存前缀稳定）；整块不够才多折一块", () => {
    let previous = assembleReaderWindow(ROLE, entries(11), 4_500);
    for (const count of [12, 13, 14]) {
      const next = assembleReaderWindow(ROLE, entries(count), 4_500);
      expect(next.slice(0, previous.length)).toEqual(previous);
      previous = next;
    }
    // 第 15 章进来，10 章一块折完还超：再一章一章折，第 11 章也折了
    const longer = assembleReaderWindow(ROLE, entries(15), 4_500);
    expect(longer[21]!.content).toBe("【第 11 章（原文已省略，见你当时的笔记）】");
    expect(longer[23]!.content).toContain("【第 12 章 定稿原文】");
  });

  it("每块都折完仍超预算：一章一章折到不超（或折光）", () => {
    const window = assembleReaderWindow(ROLE, entries(3), 1);
    expect(window.filter((message) => message.role === "user").every((message) => message.content.includes("原文已省略"))).toBe(true);
  });

  it("折叠档位不变的区间里，写笔记发出去的消息逐字等于之后窗口的前缀（服务商缓存才能命中）", async () => {
    const dir = await makeBook(13, (chapter) => "甲乙丙丁戊己庚辛壬癸"[chapter % 10]!.repeat(1000));
    const { callModel, calls } = fakeModel();
    // 预算压小：第 11 章起的窗口都折掉了前 10 章的原文
    const out = await ensureReaderWindow({ projectDir: dir, role: ROLE, upTo: 13, callModel, maxChars: 5_000 });
    expect(out.messages[19]!.content).toBe("【第 10 章（原文已省略，见你当时的笔记）】");
    expect(out.messages[21]!.content).toContain("【第 11 章 定稿原文】");
    for (const chapter of [11, 12, 13]) {
      const sent = calls[chapter - 1]!.messages;
      expect(sent.at(-1)!.content).toContain(`【第 ${chapter} 章 定稿原文】`);
      expect(out.messages.slice(0, sent.length - 1)).toEqual(sent.slice(0, -1));
    }
  });

  it("不折叠时，写笔记的消息整条等于窗口前缀", async () => {
    const dir = await makeBook(4);
    const { callModel, calls } = fakeModel();
    const out = await ensureReaderWindow({ projectDir: dir, role: ROLE, upTo: 4, callModel });
    for (let chapter = 1; chapter <= 4; chapter += 1) {
      const sent = calls[chapter - 1]!.messages;
      expect(out.messages.slice(0, sent.length)).toEqual(sent);
    }
  });
});
