// @vitest-environment node
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import {
  assembleReaderWindow,
  buildColdReaderWindow,
  COLD_RECENT_CHAPTERS,
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
    const out = await ensureReaderWindow({ projectDir: dir, role: ROLE, upTo: 3, callModel, onProgress: (chapter) => { progress.push(chapter); } });
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
    expect(out).toMatchObject({ messages: [{ role: "system", content: "你是测试专员。" }], built: 0, reused: 0, missing: 0, volumesBuilt: 0, foldedChapters: 0, readThrough: 0 });
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
    expect(out).toMatchObject({ messages: [], built: 0, reused: 0, missing: 5, volumesBuilt: 0, foldedChapters: 0, readThrough: 0 });
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

describe("专员窗口：等读回调（R5.2 必做 1）", () => {
  it("当场补笔记时 onCatchUpBegin / onProgress / onCatchUpEnd 按序带对参数；笔记齐了就一个都不调", async () => {
    const dir = await makeBook(3);
    const events: string[] = [];
    const callModel = fakeModel().callModel;
    await ensureReaderWindow({
      projectDir: dir, role: ROLE, upTo: 3, callModel,
      onCatchUpBegin: (done, total) => { events.push(`begin ${done}/${total}`); },
      onProgress: (chapter) => { events.push(`note ${chapter}`); },
      onCatchUpEnd: (done, total) => { events.push(`end ${done}/${total}`); },
    });
    expect(events).toEqual(["begin 0/3", "note 1", "note 2", "note 3", "end 3/3"]);
    // 笔记齐了再来一次：不等、不标。
    const quiet: string[] = [];
    await ensureReaderWindow({
      projectDir: dir, role: ROLE, upTo: 3, callModel,
      onCatchUpBegin: () => { quiet.push("begin"); },
      onProgress: () => { quiet.push("note"); },
      onCatchUpEnd: () => { quiet.push("end"); },
    });
    expect(quiet).toEqual([]);
  });

  it("补到一半失败：onCatchUpEnd 照样收尾，done 停在落下的那章", async () => {
    const dir = await makeBook(4);
    const events: string[] = [];
    let chapter = 0;
    const broken: BrainCallModel = async () => {
      chapter += 1;
      if (chapter >= 3) throw new Error("第 3 章笔记没写成");
      return "笔记";
    };
    await expect(ensureReaderWindow({
      projectDir: dir, role: ROLE, upTo: 4, callModel: broken,
      onCatchUpBegin: (done) => { events.push(`begin ${done}`); },
      onProgress: (c) => { events.push(`note ${c}`); },
      onCatchUpEnd: (done) => { events.push(`end ${done}`); },
    })).rejects.toThrow("第 3 章笔记没写成");
    expect(events).toEqual(["begin 0", "note 1", "note 2", "end 2"]);
  });

  it("超额走冷窗口（tooMany）不等，回调一个不调", async () => {
    const dir = await makeBook(5);
    const events: string[] = [];
    const out = await ensureReaderWindow({
      projectDir: dir, role: ROLE, upTo: 5, callModel: fakeModel().callModel, maxCatchUp: 3,
      onCatchUpBegin: () => { events.push("begin"); },
      onProgress: () => { events.push("note"); },
      onCatchUpEnd: () => { events.push("end"); },
    });
    expect(out.missing).toBe(5);
    expect(events).toEqual([]);
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

describe("专员窗口：卷笔记（T5 长书）", () => {
  const VOLUME_ROLE: ReaderRole = { ...ROLE, volumeTask: "缩写成一份卷笔记。" };
  /** 长正文 + 长笔记的书：让折叠和卷笔记都真的触发（预算 12000 时折光 25 章笔记仍超，非卷不可）。 */
  const longBook = (chapters: number) =>
    makeBook(chapters, (chapter) => `第${chapter}章的正文。${"内容".repeat(400)}`);
  const VOLUME_BUDGET = 12_000;
  /** 假模型：笔记回 600 字；卷笔记（消息里带卷笔记要求）回 900 字。笔记里带个标签，改标签就能让笔记内容真的变。 */
  function volumeFakeModel(noteChars = 600, volumeChars = 900, tag = "") {
    const calls: { readonly messages: readonly BrainMessage[]; readonly json: boolean }[] = [];
    const callModel: BrainCallModel = async (messages, options) => {
      calls.push({ messages: [...messages], json: options.json });
      const last = messages.at(-1)!.content;
      if (last.includes("缩写成一份卷笔记")) return `${tag}${"卷".repeat(volumeChars - 1)}。`;
      return `${tag}${"笔".repeat(noteChars - 2)}第${/第 (\d+) 章/u.exec(last)?.[1]}章。`;
    };
    return { callModel, calls };
  }
  const volumesOf = async (dir: string) =>
    (await readdir(join(dir, "agents", VOLUME_ROLE.id, "volumes")).catch(() => [] as string[])).sort();

  it("折掉原文还超预算：把整块的十份笔记缩写成一份卷笔记，窗口里一条卷笔记代替十章、总字数 ≤ 预算", async () => {
    const dir = await longBook(25);
    const { callModel, calls } = volumeFakeModel();
    const out = await ensureReaderWindow({ projectDir: dir, role: VOLUME_ROLE, upTo: 25, callModel, maxChars: VOLUME_BUDGET });
    // 卷笔记真的生成了、存了盘（带十章笔记的哈希）
    expect(out.volumesBuilt).toBeGreaterThan(0);
    expect(await volumesOf(dir)).toContain("1-10.json");
    const stored = JSON.parse(await readFile(join(dir, "agents", VOLUME_ROLE.id, "volumes", "1-10.json"), "utf-8"));
    expect(stored).toMatchObject({ from: 1, to: 10 });
    expect(stored.note).toContain("卷");
    expect(stored.textHash).toMatch(/^[0-9a-f]{16}$/u);
    // 窗口：第 1～10 章只剩一条 user 卷笔记标 + 一条 assistant 卷笔记；11 章起照旧
    expect(out.messages[1]).toEqual({ role: "user", content: "【第 1～10 章（只留卷笔记）】" });
    expect(out.messages[2]).toEqual({ role: "assistant", content: stored.note });
    expect(out.messages[3]!.content).toContain("【第 11 章");
    // 预算：任何消息加起来不超
    expect(out.messages.reduce((sum, message) => sum + message.content.length, 0)).toBeLessThanOrEqual(VOLUME_BUDGET);
    // 生成卷笔记的调用：材料是那十章的笔记（带章标），不是正文
    const volumeCall = calls.find((call) => call.messages.at(-1)!.content.includes("缩写成一份卷笔记"))!;
    expect(volumeCall.messages.at(-1)!.content).toContain("【1 章的读书笔记】");
    expect(volumeCall.messages.at(-1)!.content).toContain("【10 章的读书笔记】");
    expect(volumeCall.messages.at(-1)!.content).not.toContain("第1章的正文");
  });

  it("卷笔记里的笔记变了（某章正文改了）→ 哈希对不上，卷笔记作废重写", async () => {
    const dir = await longBook(25);
    const first = volumeFakeModel();
    await ensureReaderWindow({ projectDir: dir, role: VOLUME_ROLE, upTo: 25, callModel: first.callModel, maxChars: VOLUME_BUDGET });
    // 改第 3 章正文 → 3 及以后的笔记重写（内容也真的不一样）→ 盖着它们的卷笔记（1-10）哈希对不上、重生成
    await writeChapter(dir, 3, "第3章的正文，改过了。");
    const second = volumeFakeModel(600, 900, "改");
    const out = await ensureReaderWindow({ projectDir: dir, role: VOLUME_ROLE, upTo: 25, callModel: second.callModel, maxChars: VOLUME_BUDGET });
    expect(out.built).toBe(23); // 3～25 章的笔记重写
    expect(out.volumesBuilt).toBeGreaterThan(0);
    const volumeCalls = second.calls.filter((call) => call.messages.at(-1)!.content.includes("缩写成一份卷笔记"));
    expect(volumeCalls.length).toBeGreaterThan(0);
    expect(volumeCalls[0]!.messages.at(-1)!.content).toContain("改"); // 材料用的是重写后的笔记
  });

  it("卷笔记的提示词改了 → 卷笔记作废重写（笔记不作废）", async () => {
    const dir = await longBook(25);
    await ensureReaderWindow({ projectDir: dir, role: VOLUME_ROLE, upTo: 25, callModel: volumeFakeModel().callModel, maxChars: VOLUME_BUDGET });
    const second = volumeFakeModel();
    const out = await ensureReaderWindow({ projectDir: dir, role: { ...VOLUME_ROLE, volumeTask: "换一种缩写法。" }, upTo: 25, callModel: second.callModel, maxChars: VOLUME_BUDGET });
    expect(out.built).toBe(0); // 笔记全复用
    expect(out.volumesBuilt).toBeGreaterThan(0); // 卷笔记重写
  });

  it("全卷完还超预算：同层卷笔记再合成更高级的卷笔记，窗口照样 ≤ 预算（任何章数都不超）", async () => {
    const dir = await longBook(115); // 11 个整块 + 5 章散章
    const { callModel } = volumeFakeModel(600, 900);
    const out = await ensureReaderWindow({ projectDir: dir, role: VOLUME_ROLE, upTo: 115, callModel, maxChars: 6_000 });
    expect(out.messages.reduce((sum, message) => sum + message.content.length, 0)).toBeLessThanOrEqual(6_000);
    // 逐级合成过：盘上有盖超过 10 章的卷笔记（十条一卷合成的）
    const names = await volumesOf(dir);
    const spans = names.map((name) => name.replace(/\.json$/u, "").split("-").map(Number));
    expect(spans.some(([from, to]) => to - from + 1 > 10)).toBe(true);
    // 窗口开头是最高级那条
    expect(out.messages[1]!.content).toMatch(/^【第 1～\d+ 章（只留卷笔记）】$/u);
  });

  it("卷笔记盖住的章记进 foldedChapters；写每一章笔记用的窗口也 ≤ 预算（发给模型的从不超）", async () => {
    const dir = await longBook(25);
    const { callModel, calls } = volumeFakeModel();
    const out = await ensureReaderWindow({ projectDir: dir, role: VOLUME_ROLE, upTo: 25, callModel, maxChars: VOLUME_BUDGET });
    expect(out.foldedChapters).toBe(25); // 25 章原文全折掉（卷笔记 + 折叠）
    for (const call of calls) {
      const size = call.messages.reduce((sum, message) => sum + message.content.length, 0);
      expect(size).toBeLessThanOrEqual(VOLUME_BUDGET + 3_000); // 写下一章那条 user 消息（正文 + 要求）在预算外
    }
  });

  it("第二次调用：卷笔记全复用，不调模型", async () => {
    const dir = await longBook(25);
    await ensureReaderWindow({ projectDir: dir, role: VOLUME_ROLE, upTo: 25, callModel: volumeFakeModel().callModel, maxChars: VOLUME_BUDGET });
    const second = volumeFakeModel();
    const out = await ensureReaderWindow({ projectDir: dir, role: VOLUME_ROLE, upTo: 25, callModel: second.callModel, maxChars: VOLUME_BUDGET });
    expect(second.calls).toHaveLength(0);
    expect(out).toMatchObject({ built: 0, reused: 25, volumesBuilt: 0 });
  });
});

describe("冷窗口（R4.4：没读完也先干活）", () => {
  it("一章笔记都没有：只剩 [system] + 最近 K 章原文一条消息；coverage 说清范围；不调模型、不落盘", async () => {
    const dir = await makeBook(12);
    const cold = await buildColdReaderWindow({ projectDir: dir, role: ROLE, upTo: 12 });
    expect(cold.coverage).toEqual({ notedThrough: 0, rawFrom: 12 - COLD_RECENT_CHAPTERS + 1, rawTo: 12 });
    expect(cold.foldedChapters).toBe(12 - COLD_RECENT_CHAPTERS);
    expect(cold.messages).toHaveLength(2);
    expect(cold.messages[0]).toEqual({ role: "system", content: ROLE.system });
    const from = 12 - COLD_RECENT_CHAPTERS + 1;
    expect(cold.messages[1]!.content).toBe([
      `【第 ${from}～12 章 定稿原文（你还没读过这些章、也没写过笔记，这次直接给你原文）】`,
      `（第 1～${from - 1} 章这次没给你——既没笔记也没原文，那些章的细节这次对不到。）`,
      ...Array.from({ length: COLD_RECENT_CHAPTERS }, (_, index) => `【第 ${from + index} 章】\n正文${from + index}。`),
    ].join("\n\n"));
    expect(await notesOf(dir)).toEqual([]);
    expect(await readdir(join(dir, "agents")).catch(() => [])).toEqual([]);
  });

  it("已有笔记按折叠形态进前缀；原文从笔记断点之后起（中间没有空档就不写空档说明）", async () => {
    const dir = await makeBook(12);
    const { callModel } = fakeModel();
    await ensureReaderWindow({ projectDir: dir, role: ROLE, upTo: 3, callModel });
    const cold = await buildColdReaderWindow({ projectDir: dir, role: ROLE, upTo: 12 });
    expect(cold.coverage).toEqual({ notedThrough: 3, rawFrom: 5, rawTo: 12 });
    expect(cold.messages).toHaveLength(1 + 3 * 2 + 1);
    expect(cold.messages[1]).toEqual({ role: "user", content: "【第 1 章（原文已省略，见你当时的笔记）】" });
    expect(cold.messages[2]).toEqual({ role: "assistant", content: "第1章的笔记" });
    // 笔记到第 3 章、原文从第 5 章起：中间第 4 章这次没给，如实写进原文块的开头。
    expect(cold.messages[7]!.content).toContain("【第 5～12 章 定稿原文");
    expect(cold.messages[7]!.content).toContain("第 4～4 章这次没给你");
  });

  it("笔记只差几章：原文从断点起、到 upTo 止（不会把有笔记的章再塞一遍原文）", async () => {
    const dir = await makeBook(12);
    const { callModel } = fakeModel();
    await ensureReaderWindow({ projectDir: dir, role: ROLE, upTo: 10, callModel });
    const cold = await buildColdReaderWindow({ projectDir: dir, role: ROLE, upTo: 12 });
    expect(cold.coverage).toEqual({ notedThrough: 10, rawFrom: 11, rawTo: 12 });
    expect(cold.messages[1 + 10 * 2]!.content).toContain("【第 11～12 章 定稿原文");
    expect(cold.messages[1 + 10 * 2]!.content).not.toContain("这次没给你");
  });

  it("K 和字数上限：最近原文最多 maxRecentChapters 章、这部分超了 maxRecentChars 从最老的一章起让位（至少留一章）", async () => {
    const dir = await makeBook(12, (chapter) => `第${chapter}章的正文，`.repeat(40));
    const byChapters = await buildColdReaderWindow({ projectDir: dir, role: ROLE, upTo: 12, maxRecentChapters: 3 });
    expect(byChapters.coverage).toEqual({ notedThrough: 0, rawFrom: 10, rawTo: 12 });
    // 每章 8 字 × 40 遍 = 320 字：700 字装得下 2 章（640）、装不下 3 章（960+）。
    const byChars = await buildColdReaderWindow({ projectDir: dir, role: ROLE, upTo: 12, maxRecentChars: 700 });
    expect(byChars.coverage).toEqual({ notedThrough: 0, rawFrom: 11, rawTo: 12 });
    const atLeastOne = await buildColdReaderWindow({ projectDir: dir, role: ROLE, upTo: 12, maxRecentChars: 10 });
    expect(atLeastOne.coverage).toEqual({ notedThrough: 0, rawFrom: 12, rawTo: 12 });
  });

  it("总预算超了：从最老的笔记起丢（最近的状态最要紧），原文保住；coverage 仍如实报盘上的笔记数", async () => {
    const dir = await makeBook(12, (chapter) => `第${chapter}章的正文，`.repeat(10));
    const { callModel } = fakeModel();
    await ensureReaderWindow({ projectDir: dir, role: ROLE, upTo: 8, callModel });
    const sizeOf = (messages: readonly BrainMessage[]): number => messages.reduce((sum, message) => sum + message.content.length, 0);
    const full = await buildColdReaderWindow({ projectDir: dir, role: ROLE, upTo: 12 });
    expect(full.messages).toHaveLength(1 + 8 * 2 + 1); // system + 8 对笔记 + 原文块
    // 预算恰好装得下「system + 最近 6 对笔记 + 原文块」（第 3～8 章的笔记）。
    const budget = sizeOf([full.messages[0]!, ...full.messages.slice(5, 17), full.messages[17]!]);
    const trimmed = await buildColdReaderWindow({ projectDir: dir, role: ROLE, upTo: 12, maxChars: budget });
    expect(trimmed.coverage).toEqual({ notedThrough: 8, rawFrom: 9, rawTo: 12 }); // 原文从笔记断点（第 9 章）起
    expect(trimmed.messages).toHaveLength(1 + 6 * 2 + 1);
    expect(trimmed.messages[1]!.content).toBe("【第 3 章（原文已省略，见你当时的笔记）】"); // 最老的两对被丢掉
    expect(sizeOf(trimmed.messages)).toBeLessThanOrEqual(budget);
  });
});
