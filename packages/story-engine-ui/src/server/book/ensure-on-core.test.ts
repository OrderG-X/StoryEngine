// @vitest-environment node
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cardsImport, listChapterLedgers, readBible, readCards, runCommand } from "@actalk/story-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { ensureBookOnCore } from "./ensure-on-core.js";
import { createStoryProject } from "./project-store.js";
import { readStoryViews } from "./story-views.js";

const CH1 = "# 第1章 · 钟停\n\n周二傍晚，钟停在三点十五分。沈青禾推开钟楼的门，老周没有拦她。\n\n她在钟箱里摸到一把铜钥匙，揣进了包里。";
const author = (key: string) => ({ caller: "author" as const, idempotencyKey: key });

describe("开书时收老定稿链的事务残留（重构 P7：读路径不再收）", () => {
  let book: string;
  beforeEach(async () => {
    book = await makeHomeTempDir("legacy-tx-open-");
  });
  afterEach(async () => {
    await rm(book, { recursive: true, force: true });
  });

  it("老版本崩溃留下的 staged 事务：开书那步还原备份、标 recovered", async () => {
    const target = join(book, "story", "hooks.json");
    await mkdir(join(book, "story"), { recursive: true });
    await writeFile(target, "崩溃写了一半", "utf-8");
    const txDir = join(book, ".story-engine-tx", "commit-chapter-0001");
    await mkdir(join(txDir, "backups", "story"), { recursive: true });
    const original = "{\"hooks\":[]}\n";
    await writeFile(join(txDir, "backups", "story", "hooks.json"), original, "utf-8");
    await writeFile(join(txDir, "manifest.json"), JSON.stringify({
      version: 2,
      chapter: 1,
      createdAt: "2026-07-13T00:00:00.000Z",
      files: ["story/hooks.json"],
      backups: [{
        relativePath: "story/hooks.json",
        existed: true,
        backupPath: "backups/story/hooks.json",
        sha256: createHash("sha256").update(original, "utf-8").digest("hex"),
      }],
      status: "staged",
    }), "utf-8");

    expect(await ensureBookOnCore(book)).toMatchObject({ ok: true });

    expect(await readFile(target, "utf-8")).toBe(original);
    expect(JSON.parse(await readFile(join(txDir, "manifest.json"), "utf-8")).status).toBe("recovered");
  });
});

describe("开书接到新核心（ensureBookOnCore，重构 P9：先导账单、再搬设定卡）", () => {
  let book: string;
  beforeEach(async () => {
    book = await makeHomeTempDir("ensure-on-core-");
  });
  afterEach(async () => {
    await rm(book, { recursive: true, force: true });
  });

  const OLD_THREADS = {
    threads: [{ id: "lead-clock", type: "lead", title: "钟为什么停", status: "open", firstSeenChapter: 1, lastTouchedChapter: 1, evidence: ["钟停在三点十五分"] }],
  };

  /** 老书：有定稿正文、有老账（线索）、有老设定（人物册），没有账单也没有设定卡。 */
  async function writeOldBook(dir: string): Promise<void> {
    await mkdir(join(dir, "chapters"), { recursive: true });
    await mkdir(join(dir, "story"), { recursive: true });
    await writeFile(join(dir, "project.json"), JSON.stringify({ id: "old", title: "老书", createdAt: "", updatedAt: "" }));
    await writeFile(join(dir, "chapters", "0001.md"), CH1);
    await writeFile(join(dir, "story", "threads.json"), `${JSON.stringify(OLD_THREADS, null, 2)}\n`);
    await writeFile(join(dir, "story", "character-bible.json"), JSON.stringify({
      version: "v0",
      characters: [{ id: "shen", name: "沈青禾", role: "主角", identity: "钟表匠的孙女" }],
    }));
  }

  it("有定稿正文没账单的老书：先存撤销点导账单，再搬设定卡；老文件一个字节都不碰", async () => {
    await writeOldBook(book);
    const snapshots: string[] = [];

    // 假的存档点不回树：核心会再要一次只取树的（mode = "tree"），那次不算存档点。
    const result = await ensureBookOnCore(book, { snapshot: async (_label, command, mode) => { if (!mode) snapshots.push(command); } });

    expect(result).toMatchObject({ ok: true, imported: { counts: { chapters: 1 } }, cards: { imported: true } });
    expect(result).not.toHaveProperty("retired");
    // 顺序：先导账单、再搬设定（看有没有账单，不看版本号——搬设定也会涨版本号）。
    expect(snapshots).toEqual(["book.import", "cards.import"]);
    expect(await listChapterLedgers(book)).toEqual([1]);
    const cards = await readCards(book);
    expect(cards?.cards.map((card) => ({ name: card.name, protagonist: card.protagonist }))).toEqual([{ name: "沈青禾", protagonist: true }]);

    // 导进来的线索就是老线索；老线索文件没标记（不是我们生成的），原样留着。
    expect((await readStoryViews(book)).threads.threads.map((thread) => thread.title)).toEqual(["钟为什么停"]);
    expect(JSON.parse(await readFile(join(book, "story", "threads.json"), "utf-8"))).toEqual(OLD_THREADS);
    expect(JSON.parse(await readFile(join(book, "story", "character-bible.json"), "utf-8")).characters[0].name).toBe("沈青禾");

    // 再开一次：什么都不用做。
    snapshots.length = 0;
    expect(await ensureBookOnCore(book, { snapshot: async (_label, command) => { snapshots.push(command); } })).toEqual({ ok: true });
    expect(snapshots).toEqual([]);
  });

  it("有定稿正文、设定卡已经搬了、账单还没导（版本号已经不是 0）：开书时补导账单，老账原样留着", async () => {
    await writeOldBook(book);
    expect((await runCommand(book, cardsImport, {}, author("cards"))).ok).toBe(true);

    expect(await ensureBookOnCore(book)).toMatchObject({ ok: true, imported: { counts: { chapters: 1 } } });
    expect((await readStoryViews(book)).threads.threads.map((thread) => thread.title)).toEqual(["钟为什么停"]);
    expect(JSON.parse(await readFile(join(book, "story", "threads.json"), "utf-8"))).toEqual(OLD_THREADS);
  });

  it("以前生成过镜像的书（有标记）：镜像连标记挪进留证区，再开不再挪；没标记的老文件不碰", async () => {
    await writeOldBook(book);
    expect(await ensureBookOnCore(book)).toMatchObject({ ok: true, imported: { counts: { chapters: 1 } } });
    // 以前的版本在这本书上生成过镜像：线索、事件文件和标记。
    await writeFile(join(book, "story", "threads.json"), "{\"threads\":[]}\n");
    await mkdir(join(book, "timeline"), { recursive: true });
    await writeFile(join(book, "timeline", "events.json"), "[]\n");
    await writeFile(join(book, ".story-core-mirror.json"), "{\"schema\":\"legacy-mirror/2\",\"version\":3}\n");

    expect(await ensureBookOnCore(book)).toEqual({ ok: true, retired: ["story/threads.json", "timeline/events.json", ".story-core-mirror.json"] });

    const kept = join(book, ".story-core-kept", "mirror-retired");
    expect(await readFile(join(kept, "story", "threads.json"), "utf-8")).toBe("{\"threads\":[]}\n");
    expect(await readFile(join(kept, "timeline", "events.json"), "utf-8")).toBe("[]\n");
    await expect(access(join(book, "story", "threads.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(book, ".story-core-mirror.json"))).rejects.toMatchObject({ code: "ENOENT" });
    // 老设定文件不是镜像，不动；读者照旧从账算。
    expect(JSON.parse(await readFile(join(book, "story", "character-bible.json"), "utf-8")).characters[0].name).toBe("沈青禾");
    expect((await readStoryViews(book)).threads.threads.map((thread) => thread.title)).toEqual(["钟为什么停"]);

    expect(await ensureBookOnCore(book)).toEqual({ ok: true });
  });

  it("新书（只有设定卡、没定稿过）：什么都不导，也不建老格式文件", async () => {
    const { projectDir } = await createStoryProject({ rootDir: book, title: "新书", protagonistName: "林远" });
    const before = await readFile(join(projectDir, "ledger", "cards.json"), "utf-8");

    expect(await ensureBookOnCore(projectDir)).toEqual({ ok: true });

    for (const file of ["story/threads.json", "story/timeline.json", "timeline/events.json", "time/calendar.json"]) {
      await expect(access(join(projectDir, file))).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await readFile(join(projectDir, "ledger", "cards.json"), "utf-8")).toBe(before);
  });

  it("没设定卡、也没任何老设定的书：建一份空的设定卡（如实说没搬到东西）", async () => {
    await writeFile(join(book, "project.json"), JSON.stringify({ id: "bare", title: "空书", createdAt: "", updatedAt: "" }));

    expect(await ensureBookOnCore(book)).toEqual({ ok: true, cards: expect.objectContaining({ imported: false }) });

    expect(await readCards(book)).toMatchObject({ story: { fields: [] }, cards: [], relations: [] });
  });

  it("设定卡已经在了：不再从老文件搬（老文件后来多出来的人不会顶掉作者在设定本里改的）", async () => {
    const { projectDir } = await createStoryProject({ rootDir: book, title: "已经搬过", protagonistName: "林远" });
    await mkdir(join(projectDir, "story"), { recursive: true });
    await writeFile(join(projectDir, "story", "character-bible.json"), JSON.stringify({
      version: "v0",
      characters: [{ id: "su", name: "苏雨", role: "配角", identity: "医生" }],
    }));
    const before = await readFile(join(projectDir, "ledger", "cards.json"), "utf-8");

    const result = await ensureBookOnCore(projectDir);

    expect(result).toEqual({ ok: true });
    expect(await readFile(join(projectDir, "ledger", "cards.json"), "utf-8")).toBe(before);
    const { bible } = await readBible(projectDir);
    expect(bible.characters.map((entry) => entry.card.name)).toEqual(["林远"]);
  });

  /** P2b 以前定稿的书：账单还是 v1。 */
  const v1Ledger = (entries: unknown[]): string => `${JSON.stringify({
    schema: "chapter-ledger/1", chapter: 1, textSha256: createHash("sha256").update(CH1, "utf-8").digest("hex"), committedAt: "2026-10-01T00:00:00.000Z", origin: "commit", entries,
  }, null, 2)}\n`;

  it("旧格式账单（P2b 以前）：开书先存撤销点、一次升成新格式，读者照常读；再开不再升", async () => {
    const { projectDir } = await createStoryProject({ rootDir: book, title: "升级", protagonistName: "沈青禾" });
    await writeFile(join(projectDir, "chapters", "0001.md"), CH1);
    await mkdir(join(projectDir, "ledger", "chapters"), { recursive: true });
    await writeFile(join(projectDir, "ledger", "chapters", "0001.json"), v1Ledger([
      { id: "c1-1", kind: "thread", review: "auto", op: "open", type: "question", title: "钟为什么停", note: "停了", quote: "钟停在三点十五分", thread: "t1-1" },
    ]));
    await expect(readStoryViews(projectDir)).rejects.toMatchObject({ needsUpgrade: true });
    const snapshots: string[] = [];

    const result = await ensureBookOnCore(projectDir, { snapshot: async (_label, command, mode) => { if (!mode) snapshots.push(command); } });

    expect(result).toMatchObject({ ok: true, migrated: { chapters: 1, pending: 0, evidence: { located: 1 } } });
    expect(snapshots).toEqual(["ledger.migrate"]);
    expect(JSON.parse(await readFile(join(projectDir, "ledger", "chapters", "0001.json"), "utf-8")).schema).toBe("chapter-ledger/2");
    expect((await readStoryViews(projectDir)).threads.threads.map((thread) => thread.title)).toEqual(["钟为什么停"]);
    expect(await ensureBookOnCore(projectDir)).toEqual({ ok: true });
  });

  it("旧账有一章升不了：如实说没接上，一份不动", async () => {
    const { projectDir } = await createStoryProject({ rootDir: book, title: "坏账", protagonistName: "沈青禾" });
    await writeFile(join(projectDir, "chapters", "0001.md"), CH1);
    await mkdir(join(projectDir, "ledger", "chapters"), { recursive: true });
    // 定稿记的条目当年就必须带原句：这份当年就不成立。
    const broken = v1Ledger([{ id: "c1-1", kind: "summary", review: "auto", text: "梗概" }]);
    await writeFile(join(projectDir, "ledger", "chapters", "0001.json"), broken);

    const result = await ensureBookOnCore(projectDir);

    expect(result).toMatchObject({ ok: false, code: "ledger_unreadable", reason: expect.stringContaining("第 1 章") });
    expect(await readFile(join(projectDir, "ledger", "chapters", "0001.json"), "utf-8")).toBe(broken);
  });
});
