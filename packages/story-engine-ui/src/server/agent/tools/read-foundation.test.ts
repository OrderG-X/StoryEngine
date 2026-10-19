// @vitest-environment node
//
// read_foundation（重构 P9 改读设定视图）：不带名字给全书一览；带名字 / 别名 / 「主角」读那一张卡
// （卡上写的、关系、账里定下的和现状、出场）；账里出场过、还没建卡的人也读得到；找不到如实 found=false。
// 输出只有名字，绝不出现 k- / r- / e- 编号。读类工具不写盘。
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cardWrite, chapterCommit, runCommand, type CardOp, type EntryInput } from "@actalk/story-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createStoryProject } from "../../book/project-store.js";
import { makeHomeTempDir } from "../../lib/home-test-tmp.js";
import { readFoundationLogic } from "./read-foundation.js";

const RAW_ID = /[kre]-\d/u;

let rootDir: string;
let book: string;
beforeEach(async () => {
  rootDir = await makeHomeTempDir("read-foundation-");
  ({ projectDir: book } = await createStoryProject({ rootDir, title: "海州账册", genre: "都市", logline: "审计员林远追查账册篡改。", protagonistName: "林远" }));
});
afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

async function authorWrite(ops: CardOp[]): Promise<void> {
  const outcome = await runCommand(book, cardWrite, { ops }, { caller: "author", idempotencyKey: `t-${randomUUID()}` });
  if (!outcome.ok) throw new Error(outcome.message);
}

const CH1 = "# 第1章\n\n远哥把蓝色账册锁进抽屉。老周在门口抽烟，没有拦他。";

async function commitChapter1(): Promise<void> {
  const entries: EntryInput[] = [
    { kind: "presence", review: "auto", name: "林远", nameUsed: "远哥", viewpoint: true, quote: "远哥把蓝色账册锁进抽屉" },
    { kind: "presence", review: "auto", name: "周守义", nameUsed: "老周", quote: "老周在门口抽烟" },
    { kind: "fact", review: "auto", nature: "state", subject: "周守义", attribute: "在哪", value: "门口", text: "老周在门口", quote: "老周在门口抽烟" },
  ];
  const outcome = await runCommand(book, chapterCommit, { chapter: 1, text: CH1, entries }, { caller: "author", idempotencyKey: "c1" });
  if (!outcome.ok) throw new Error(outcome.message);
}

async function seedCards(): Promise<void> {
  await authorWrite([
    { op: "field.set", card: "林远", label: "身份", value: "审计员" },
    { op: "card.create", kind: "character", name: "苏晴", aliases: ["阿晴"], fields: [{ label: "身份", value: "报社记者" }] },
    { op: "card.create", kind: "place", name: "市档案馆" },
    { op: "card.create", kind: "item", name: "蓝色账册", fields: [{ label: "样子", value: "硬皮，第三页被撕" }] },
    { op: "card.create", kind: "lore", name: "审计规矩" },
    { op: "relation.set", a: "林远", b: "苏晴", label: "大学同学" },
    { op: "rules.set", field: "targetWords", value: 2400 },
    { op: "exemplar.add", text: "雾从海上漫进来的时候，邮局的钟停了。" },
  ]);
}

describe("read_foundation：全书一览", () => {
  it("不带名字：故事设定、写作规则全给，各类卡只列名字，主角标出来", async () => {
    await seedCards();
    const out = await readFoundationLogic({ projectDir: book });
    expect(out.found).toBe(true);
    expect(out.text).toContain("故事设定：");
    expect(out.text).toContain("- 题材：都市");
    expect(out.text).toContain("- 一句话：审计员林远追查账册篡改。");
    expect(out.text).toContain("- 每章目标字数：2400");
    expect(out.text).toContain("文风样本 1 段");
    expect(out.text).toContain("人物卡（2）：林远（主角）、苏晴");
    expect(out.text).toContain("地点卡（1）：市档案馆");
    expect(out.text).toContain("物品卡（1）：蓝色账册");
    expect(out.text).toContain("设定卡（1）：审计规矩");
    expect(out.summary).toBe("设定本：5 张卡。");
    expect(`${out.text}${out.summary}`).not.toMatch(RAW_ID);
  });

  it("空白名字当没带", async () => {
    const out = await readFoundationLogic({ projectDir: book, name: "  " });
    expect(out.found).toBe(true);
    expect(out.text).toContain("人物卡（1）：林远（主角）");
  });
});

describe("read_foundation：读一张卡", () => {
  it("按名字、别名、「主角」都找得到那张卡：卡上写的、关系全给", async () => {
    await seedCards();
    const byName = await readFoundationLogic({ projectDir: book, name: "苏晴" });
    expect(byName).toMatchObject({ found: true, summary: "读了「苏晴」。" });
    expect(byName.text).toContain("【人物】苏晴（也叫：阿晴）");
    expect(byName.text).toContain("- 身份：报社记者");
    expect(byName.text).toContain("- 和林远：大学同学");

    const byAlias = await readFoundationLogic({ projectDir: book, name: "阿晴" });
    expect(byAlias.text).toBe(byName.text);

    const protagonist = await readFoundationLogic({ projectDir: book, name: "主角" });
    expect(protagonist).toMatchObject({ found: true, summary: "读了「林远」。" });
    expect(protagonist.text).toContain("【人物】林远（主角）");
    expect(protagonist.text).toContain("- 身份：审计员");

    const item = await readFoundationLogic({ projectDir: book, name: "蓝色账册" });
    expect(item.text).toContain("【物品】蓝色账册");
    expect(item.text).toContain("- 样子：硬皮，第三页被撕");
    for (const out of [byName, protagonist, item]) expect(`${out.text}${out.summary}`).not.toMatch(RAW_ID);
  });

  it("卡对上账：正文里用过的称呼也认；带出场章、视角章", async () => {
    await commitChapter1();
    const out = await readFoundationLogic({ projectDir: book, name: "远哥" });
    expect(out).toMatchObject({ found: true, summary: "读了「林远」。" });
    expect(out.text).toContain("（也叫：远哥）");
    expect(out.text).toContain("出场：第 1 章，共 1 章，其中 1 章是这个人的视角");
  });

  it("账里出场过、还没建卡的人：按名字或正文里的称呼读到账里记的", async () => {
    await commitChapter1();
    const out = await readFoundationLogic({ projectDir: book, name: "老周" });
    expect(out).toMatchObject({ found: true, summary: "「周守义」还没建卡，下面是账里记的。" });
    expect(out.text).toContain("【还没建卡】周守义（出场人物）（也叫：老周）");
    expect(out.text).toContain("- 在哪：门口（第 1 章）");
    expect(out.text).toContain("出场：第 1 章，共 1 章");

    const overview = await readFoundationLogic({ projectDir: book });
    expect(overview.text).toContain("账里有、还没建卡（1）：周守义");
    expect(overview.summary).toBe("设定本：1 张卡，账里还有 1 个没建卡。");
  });

  it("设定本里没有、账里也没记 → found=false，如实说，附上全书一览", async () => {
    const out = await readFoundationLogic({ projectDir: book, name: "张三" });
    expect(out.found).toBe(false);
    expect(out.summary).toBe("设定本里没有「张三」，账里也没记过。下面是全书一览。");
    expect(out.text).toContain("人物卡（1）：林远（主角）");
  });
});

describe("read_foundation：只读", () => {
  it("读不写盘：设定卡一个字节不变", async () => {
    await seedCards();
    const before = await readFile(join(book, "ledger", "cards.json"), "utf-8");
    await readFoundationLogic({ projectDir: book });
    await readFoundationLogic({ projectDir: book, name: "苏晴" });
    expect(await readFile(join(book, "ledger", "cards.json"), "utf-8")).toBe(before);
  });

  it("还没搬设定的老书：从老设定文件现拼着读，不替它建设定卡", async () => {
    const legacy = await makeHomeTempDir("read-foundation-legacy-");
    try {
      await mkdir(join(legacy, "story"), { recursive: true });
      await writeFile(join(legacy, "story", "character-bible.json"), JSON.stringify({
        version: "v0",
        characters: [{ id: "char-a", name: "许微", role: "主角", identity: "夜班分拣员" }],
      }), "utf-8");
      const out = await readFoundationLogic({ projectDir: legacy, name: "许微" });
      expect(out.found).toBe(true);
      expect(out.text).toContain("【人物】许微");
      expect(out.text).not.toContain("char-a");
      await expect(access(join(legacy, "ledger", "cards.json"))).rejects.toThrow();
    } finally {
      await rm(legacy, { recursive: true, force: true });
    }
  });
});
