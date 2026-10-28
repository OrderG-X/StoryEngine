// @vitest-environment node
//
// foundation_write（重构 P9：一批 ops 走核心 card.fill / card.write）：
// 边界先把模型常传的退化写法归一；AI 能直接做的写进去、标「AI 补的」；碰了作者写的一个字不改、
// 只出「确认改设定」按钮（按钮里原样带着那几步）；格式不对 / 指错卡的如实列进「没改成」；
// 一个字没改时 ok=false、summary 不报成功。真项目、真存档点，不调模型。
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { cardWrite, readCards, runCommand, type CardOp } from "@actalk/story-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createStoryProject } from "../../book/project-store.js";
import { makeHomeTempDir } from "../../lib/home-test-tmp.js";
import { listSnapshots } from "../../lib/snapshot.js";
import { applyFoundationDecision } from "../foundation-decisions.js";
import { buildProjectRequestContext } from "../request-context.js";
import { foundationWriteLogic, foundationWriteTool, normalizeRawOp } from "./foundation-write.js";
import { readFoundationLogic } from "./read-foundation.js";

/** 编号只给程序用，给人看的话里一个都不许出现。 */
const RAW_ID = /[kre]-\d/u;

let rootDir: string;
let book: string;
beforeEach(async () => {
  rootDir = await makeHomeTempDir("foundation-write-");
  ({ projectDir: book } = await createStoryProject({ rootDir, title: "海州账册", genre: "都市", logline: "审计员林远追查账册篡改。", protagonistName: "林远" }));
});
afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

async function authorWrite(ops: CardOp[]): Promise<void> {
  const outcome = await runCommand(book, cardWrite, { ops }, { caller: "author", idempotencyKey: `t-${randomUUID()}` });
  if (!outcome.ok) throw new Error(outcome.message);
}

async function cards() {
  const file = await readCards(book);
  if (!file) throw new Error("没有设定卡");
  return file;
}

const cardsText = (): Promise<string> => readFile(join(book, "ledger", "cards.json"), "utf-8");

describe("normalizeRawOp：边界归一模型常传的退化写法（只动句法，不猜意思）", () => {
  it("空串 / 空数组 / null 的可选键当没传；op 去空白；\"true\" 归成 true、false / \"False\" 去掉", () => {
    expect(normalizeRawOp({ op: " card.create ", kind: "character", name: "苏晴", aliases: "", fields: [], protagonist: "true", note: null })).toEqual({
      op: "card.create", kind: "character", name: "苏晴", protagonist: true,
    });
    expect(normalizeRawOp({ op: "card.create", kind: "character", name: "苏晴", protagonist: "False" })).not.toHaveProperty("protagonist");
    expect(normalizeRawOp({ op: "card.create", kind: "character", name: "苏晴", protagonist: false })).not.toHaveProperty("protagonist");
    // 别名给成一个字符串 → 包成数组
    expect(normalizeRawOp({ op: "card.aliases", card: "苏晴", add: "阿晴" })).toEqual({ op: "card.aliases", card: "苏晴", add: ["阿晴"] });
  });

  it("类别：界面上的中文名、老格式的英文名、大小写都认；认不出的原样交给校验去报", () => {
    expect(normalizeRawOp({ op: "card.create", kind: "人物", name: "a" }).kind).toBe("character");
    expect(normalizeRawOp({ op: "card.create", kind: "地点", name: "a" }).kind).toBe("place");
    expect(normalizeRawOp({ op: "card.create", kind: "物品", name: "a" }).kind).toBe("item");
    expect(normalizeRawOp({ op: "card.create", kind: "设定", name: "a" }).kind).toBe("lore");
    expect(normalizeRawOp({ op: "card.create", kind: "location", name: "a" }).kind).toBe("place");
    expect(normalizeRawOp({ op: "card.create", kind: "asset", name: "a" }).kind).toBe("item");
    expect(normalizeRawOp({ op: "card.create", kind: "world", name: "a" }).kind).toBe("lore");
    expect(normalizeRawOp({ op: "card.create", kind: " Character ", name: "a" }).kind).toBe("character");
    expect(normalizeRawOp({ op: "card.create", kind: "怪物", name: "a" }).kind).toBe("怪物");
  });

  it("写作规则栏名：中文名归成正式名；字数的数字串归成数字，空串归成 null（删），中文数字不猜", () => {
    expect(normalizeRawOp({ op: "rules.add", list: "一定不要写", text: "x" }).list).toBe("bans");
    expect(normalizeRawOp({ op: "rules.add", list: "文风", text: "x" }).list).toBe("style");
    expect(normalizeRawOp({ op: "rules.set", field: "视角", value: "第三人称" })).toEqual({ op: "rules.set", field: "perspective", value: "第三人称" });
    expect(normalizeRawOp({ op: "rules.set", field: "每章目标字数", value: " 2400 " })).toEqual({ op: "rules.set", field: "targetWords", value: 2400 });
    expect(normalizeRawOp({ op: "rules.set", field: "minWords", value: "" }).value).toBeNull();
    expect(normalizeRawOp({ op: "rules.set", field: "targetWords" }).value).toBeNull();
    expect(normalizeRawOp({ op: "rules.set", field: "targetWords", value: "两千" }).value).toBe("两千");
    // 字数写成了故事设定的一栏：栏名正好是写作规则的字数栏 → 搬回写作规则；别的栏照旧是故事设定
    expect(normalizeRawOp({ op: "story.set", label: "每章目标字数", value: "2000" })).toEqual({ op: "rules.set", field: "targetWords", value: 2000 });
    expect(normalizeRawOp({ op: "story.set", label: " 每章至少字数 ", value: 1800 })).toEqual({ op: "rules.set", field: "minWords", value: 1800 });
    expect(normalizeRawOp({ op: "story.set", label: "视角", value: "第三人称" })).toEqual({ op: "story.set", label: "视角", value: "第三人称" });
    expect(normalizeRawOp({ op: "story.set", label: "篇幅", value: "约 50 章" }).op).toBe("story.set");
    // 删故事设定里记错的那一栏：照旧删那一栏，不当成删写作规则（实跑里 AI 先 rules.set 再删这一栏，曾把刚写的规则删了）
    expect(normalizeRawOp({ op: "story.set", label: "每章目标字数", value: "" })).toEqual({ op: "story.set", label: "每章目标字数", value: "" });
    // field.set 的空串是「删这一栏」，不当没传
    expect(normalizeRawOp({ op: "field.set", card: "苏晴", label: "外貌", value: "" })).toEqual({ op: "field.set", card: "苏晴", label: "外貌", value: "" });
  });

  it("漏写 op（GLM 实测）：键只对得上一种就补上；对上几种、只对得上「认下」、键对不上都不补", () => {
    expect(normalizeRawOp({ kind: "character", name: "韩德胜", fields: [{ label: "身份", value: "退休仓管" }] }).op).toBe("card.create");
    expect(normalizeRawOp({ op: "", card: "许建平", label: "性格", value: "认死理" }).op).toBe("field.set");
    expect(normalizeRawOp({ a: "林远", b: "苏晴", label: "同学" }).op).toBe("relation.set");
    expect(normalizeRawOp({ label: "题材", value: "悬疑" }).op).toBe("story.set");
    expect(normalizeRawOp({ card: "苏晴", add: ["阿晴"] }).op).toBe("card.aliases");
    // 只有 card：别名 / 删卡 / 设主角都对得上 → 不补
    expect(normalizeRawOp({ card: "苏晴" }).op).toBeUndefined();
    // 加一条还是删一条分不出 → 不补
    expect(normalizeRawOp({ list: "bans", text: "x" }).op).toBeUndefined();
    // 只对得上「认下」→ 不补（认下是作者的事）
    expect(normalizeRawOp({ card: "苏晴", label: "外貌" }).op).toBeUndefined();
    // 多塞了别的键 → 不补
    expect(normalizeRawOp({ card: "苏晴", label: "外貌", value: "高", why: "x" }).op).toBeUndefined();
  });
});

describe("foundation_write：AI 能直接做的写进去，标 AI 补的", () => {
  it("建新卡、给作者的卡加新栏、记关系、写作规则（中文栏名）→ 真写盘、带存档点、记成 AI 写的；摘要只有名字", async () => {
    const before = (await listSnapshots(book)).length;
    const out = await foundationWriteLogic({
      projectDir: book,
      ops: [
        { op: "card.create", kind: "人物", name: "苏晴", aliases: "", fields: [{ label: "身份", value: "报社记者" }], protagonist: "false" },
        { op: "field.set", card: "林远", label: "外貌", value: "高个子，戴黑框眼镜" },
        { op: "relation.set", a: "林远", b: "苏晴", label: "大学同学" },
        { op: "rules.set", field: "每章目标字数", value: "2400" },
        { op: "rules.add", list: "一定不要写", text: "不写血腥场面" },
      ],
    });

    expect(out).toMatchObject({ ok: true, refreshScope: "foundation" });
    expect(out.needsConfirmation).toBeUndefined();
    expect(out.notDone).toBeUndefined();
    expect(out.applied).toEqual([
      "建了人物卡「苏晴」",
      "「林远」的「外貌」写上了",
      "「林远」和「苏晴」的关系写上了",
      "写作规则「每章目标字数」写上了",
      "写作规则「一定不要写」加了一条",
    ]);
    expect(out.snapshotId).toMatch(/^[0-9a-f]{40}$/u);
    expect((await listSnapshots(book)).length).toBeGreaterThan(before);
    expect(out.summary.startsWith("改好了：")).toBe(true);
    expect(out.summary).not.toMatch(RAW_ID);

    const file = await cards();
    const su = file.cards.find((card) => card.name === "苏晴")!;
    expect(su).toMatchObject({ kind: "character", by: "ai", fields: [{ label: "身份", value: "报社记者", by: "ai" }] });
    expect(su.protagonist).toBeUndefined();
    const lin = file.cards.find((card) => card.name === "林远")!;
    expect(lin).toMatchObject({ by: "author", protagonist: true });
    expect(lin.fields.find((field) => field.label === "外貌")).toMatchObject({ value: "高个子，戴黑框眼镜", by: "ai" });
    expect(file.relations).toEqual([expect.objectContaining({ label: "大学同学", by: "ai" })]);
    expect(file.rules.targetWords).toMatchObject({ value: 2400, by: "ai" });
    expect(file.rules.bans).toEqual([expect.objectContaining({ text: "不写血腥场面", by: "ai" })]);

    // 读出来标着「AI 补的」（AI 改它不用作者点头，改作者写的要）。
    const read = await readFoundationLogic({ projectDir: book, name: "林远" });
    expect(read.text).toContain("- 外貌：高个子，戴黑框眼镜（AI 补的）");
  });

  it("AI 改自己补的直接改，不用作者点头", async () => {
    await foundationWriteLogic({ projectDir: book, ops: [{ op: "card.create", kind: "item", name: "蓝色账册", fields: [{ label: "样子", value: "硬皮" }] }] });
    const out = await foundationWriteLogic({ projectDir: book, ops: [{ op: "field.set", card: "蓝色账册", label: "样子", value: "硬皮，第三页被撕" }] });
    expect(out).toMatchObject({ ok: true, applied: ["「蓝色账册」的「样子」改了"] });
    expect(out.needsConfirmation).toBeUndefined();
    expect((await cards()).cards.find((card) => card.name === "蓝色账册")!.fields[0]).toMatchObject({ value: "硬皮，第三页被撕", by: "ai" });
  });

  it("工具入口：模型把 ops 整个写成 JSON 字符串也接得住", async () => {
    const execute = foundationWriteTool.execute as unknown as (input: Record<string, unknown>, context: ToolExecutionContext) => Promise<{ ok: boolean; applied: string[] }>;
    const context = { requestContext: buildProjectRequestContext(book) } as unknown as ToolExecutionContext;
    const out = await execute({ ops: JSON.stringify([{ op: "card.create", kind: "地点", name: "市档案馆" }]) }, context);
    expect(out).toMatchObject({ ok: true, applied: ["建了地点卡「市档案馆」"] });
  });
});

describe("foundation_write：AI 刚写进去的给「认下」按钮（作者口述让 AI 记的，点了算作者写的）", () => {
  it("建卡、给作者的卡填栏、故事设定、写作规则 → 按钮带对应的认下；点了就都算作者写的", async () => {
    const out = await foundationWriteLogic({
      projectDir: book,
      ops: [
        { op: "card.create", kind: "人物", name: "苏晴", fields: [{ label: "身份", value: "报社记者" }] },
        { op: "field.set", card: "苏晴", label: "性格", value: "急" },
        { op: "field.set", card: "林远", label: "外貌", value: "高个子" },
        { op: "relation.set", a: "林远", b: "苏晴", label: "大学同学" },
        { op: "story.set", label: "基调", value: "冷" },
        { op: "rules.add", list: "一定不要写", text: "不写血腥场面" },
      ],
    });
    expect(out.needsConfirmation).toBeUndefined();
    expect(out.foundationAccept).toMatchObject({ label: "刚写的这几处" });
    expect(out.foundationAccept!.input).toEqual({
      ops: [
        { op: "field.accept", card: "苏晴" },
        { op: "field.accept", card: "林远", label: "外貌" },
        { op: "story.accept", label: "基调" },
        { op: "rules.accept" },
      ],
    });
    expect(out.summary).toContain("点「认下」就算你写的");

    const done = await applyFoundationDecision(book, out.foundationAccept!);
    expect(done.ok).toBe(true);
    const file = await cards();
    const su = file.cards.find((card) => card.name === "苏晴")!;
    expect(su.by).toBe("author");
    expect(su.fields.every((field) => field.by === "author")).toBe(true);
    expect(file.cards.find((card) => card.name === "林远")!.fields.find((field) => field.label === "外貌")!.by).toBe("author");
    expect(file.story.fields.find((field) => field.label === "基调")!.by).toBe("author");
    expect(file.rules.bans[0]!.by).toBe("author");
  });

  it("写作规则里本来就有作者没过目的 AI 补的：不带整体认下，免得一并认下", async () => {
    await foundationWriteLogic({ projectDir: book, ops: [{ op: "rules.add", list: "一定不要写", text: "不写血腥场面" }] });
    const out = await foundationWriteLogic({ projectDir: book, ops: [{ op: "rules.add", list: "文风", text: "短句" }] });
    expect(out.foundationAccept).toBeUndefined();
  });

  it("这一批里有要作者点头的：只出「确认改设定」，不再挂认下", async () => {
    await authorWrite([{ op: "field.set", card: "林远", label: "身份", value: "审计员" }]);
    const out = await foundationWriteLogic({
      projectDir: book,
      ops: [
        { op: "field.set", card: "林远", label: "身份", value: "记者" },
        { op: "card.create", kind: "item", name: "蓝色账册" },
      ],
    });
    expect(out.foundationConfirm).toBeDefined();
    expect(out.foundationAccept).toBeUndefined();
  });
});

describe("foundation_write：碰了作者写的不改，只出「确认改设定」按钮", () => {
  it("改作者写的栏：一个字不改；能直接做的照做；按钮里原样带着要作者点头的那几步", async () => {
    await authorWrite([{ op: "field.set", card: "林远", label: "身份", value: "审计员" }]);
    const out = await foundationWriteLogic({
      projectDir: book,
      ops: [
        { op: "field.set", card: "林远", label: "身份", value: "记者" },
        { op: "card.create", kind: "item", name: "蓝色账册" },
      ],
    });

    expect(out).toMatchObject({ ok: true, needsConfirmation: true, applied: ["建了物品卡「蓝色账册」"], pending: ["「林远」的「身份」改了"] });
    expect(out.foundationConfirm).toMatchObject({ label: "「林远」的「身份」改了" });
    expect(out.foundationConfirm!.key).toMatch(/^card-[0-9a-f]{24}$/u);
    expect(out.foundationConfirm!.input).toEqual({ ops: [{ op: "field.set", card: "林远", label: "身份", value: "记者" }] });
    expect(out.summary).toContain("要你点「确认改设定」才改");
    expect(out.summary).not.toMatch(RAW_ID);
    const lin = (await cards()).cards.find((card) => card.name === "林远")!;
    expect(lin.fields.find((field) => field.label === "身份")).toMatchObject({ value: "审计员", by: "author" });
  });

  it("按钮带提议时的依据：作者点之前设定又改过 → 不改、说清哪里变了；不带依据的旧按钮也不改；没变照改", async () => {
    await authorWrite([{ op: "field.set", card: "林远", label: "身份", value: "审计员" }]);
    const out = await foundationWriteLogic({ projectDir: book, ops: [{ op: "field.set", card: "林远", label: "身份", value: "记者" }] });
    const confirm = out.foundationConfirm!;
    expect(confirm.basis).toMatch(/^[0-9a-f]{64}$/u);
    expect(confirm.basisFrom).toBe(confirm.basis); // 这一批没有 AI 直接写的

    const { basis: _drop, ...legacy } = confirm;
    expect(await applyFoundationDecision(book, legacy)).toMatchObject({ ok: false, summary: expect.stringContaining("按钮是旧的") });

    await authorWrite([{ op: "field.set", card: "林远", label: "性格", value: "闷" }]);
    const stale = await applyFoundationDecision(book, confirm);
    expect(stale).toMatchObject({ ok: false, summary: expect.stringContaining("提议之后设定本改过") });
    expect((await cards()).cards.find((card) => card.name === "林远")!.fields.find((field) => field.label === "身份")).toMatchObject({ value: "审计员" });

    const again = await foundationWriteLogic({ projectDir: book, ops: [{ op: "field.set", card: "林远", label: "身份", value: "记者" }] });
    expect(await applyFoundationDecision(book, again.foundationConfirm!)).toMatchObject({ ok: true });
    expect((await cards()).cards.find((card) => card.name === "林远")!.fields.find((field) => field.label === "身份")).toMatchObject({ value: "记者", by: "author" });
  });

  it("这一批有 AI 直接写的：basisFrom 是写之前、basis 是写完的样子（一轮几个按钮合并时靠它接上）", async () => {
    await authorWrite([{ op: "field.set", card: "林远", label: "身份", value: "审计员" }]);
    const out = await foundationWriteLogic({
      projectDir: book,
      ops: [
        { op: "field.set", card: "林远", label: "身份", value: "记者" },
        { op: "card.create", kind: "item", name: "蓝色账册" },
      ],
    });
    const confirm = out.foundationConfirm!;
    expect(confirm.basisFrom).toMatch(/^[0-9a-f]{64}$/u);
    expect(confirm.basis).not.toBe(confirm.basisFrom);
    expect(await applyFoundationDecision(book, confirm)).toMatchObject({ ok: true });
  });

  it("改名 + 按新名字补栏、删作者建的卡：全交给作者（跟着被拦那步的一起交），一个字不写、不打存档点", async () => {
    await authorWrite([{ op: "card.create", kind: "character", name: "顾明" }]);
    const before = await cardsText();
    const snapshots = (await listSnapshots(book)).length;
    const out = await foundationWriteLogic({
      projectDir: book,
      ops: [
        { op: "card.rename", card: "林远", name: "林澈" },
        { op: "field.set", card: "林澈", label: "外貌", value: "瘦高" },
        { op: "card.delete", card: "顾明" },
      ],
    });

    expect(out).toMatchObject({ ok: true, needsConfirmation: true, applied: [] });
    expect(out.foundationConfirm!.input).toEqual({
      ops: [
        { op: "card.rename", card: "林远", name: "林澈" },
        { op: "field.set", card: "林澈", label: "外貌", value: "瘦高" },
        { op: "card.delete", card: "顾明" },
      ],
    });
    expect(out.pending).toEqual(["「林远」改名为「林澈」，旧名留作别名", "「林澈」的「外貌」写上了", "删了人物卡「顾明」"]);
    expect(out.snapshotId).toBeUndefined();
    expect(out.refreshScope).toBeUndefined();
    expect(out.summary).not.toContain("改好了");
    expect(await cardsText()).toBe(before);
    expect((await listSnapshots(book)).length).toBe(snapshots);
  });

  it("换主角也要作者点头", async () => {
    await authorWrite([{ op: "card.create", kind: "character", name: "苏晴" }]);
    const out = await foundationWriteLogic({ projectDir: book, ops: [{ op: "card.protagonist", card: "苏晴" }] });
    expect(out).toMatchObject({ ok: true, needsConfirmation: true, pending: ["「苏晴」设为主角"] });
    expect((await cards()).cards.find((card) => card.protagonist)?.name).toBe("林远");
  });
});

describe("foundation_write：没做成的如实说", () => {
  it("格式不对、指错卡 → 进「没改成」并说清第几步、为什么；对的那步照做", async () => {
    const out = await foundationWriteLogic({
      projectDir: book,
      ops: [
        { op: "card.create", kind: "怪物", name: "夜行者" },
        { op: "field.set", card: "不存在的人", label: "外貌", value: "高" },
        { name: "没写 op" },
        { op: "card.create", kind: "place", name: "市档案馆" },
      ],
    });
    expect(out).toMatchObject({ ok: true, applied: ["建了地点卡「市档案馆」"] });
    expect(out.notDone).toEqual([
      "第 1 步（card.create）格式不对：kind",
      "第 3 步（（没写 op））格式不对：op",
      "没有叫「不存在的人」的卡",
    ]);
    expect(out.summary).toContain("没改成：");
    expect((await cards()).cards.map((card) => card.name)).toEqual(["林远", "市档案馆"]);
  });

  it("全都做不成 → ok=false、不写盘、不打存档点，摘要不报成功", async () => {
    const before = await cardsText();
    const snapshots = (await listSnapshots(book)).length;
    const out = await foundationWriteLogic({
      projectDir: book,
      ops: [
        { op: "card.create", kind: "character", name: "林远" },
        { op: "rules.set", field: "targetWords", value: "两千" },
      ],
    });
    expect(out).toMatchObject({ ok: false, applied: [] });
    expect(out.notDone).toHaveLength(2);
    expect(out.notDone![0]).toContain("已经有叫「林远」的卡了");
    expect(out.notDone![1]).toContain("要写一个整数");
    expect(out.summary).not.toContain("改好了");
    expect(out.snapshotId).toBeUndefined();
    expect(await cardsText()).toBe(before);
    expect((await listSnapshots(book)).length).toBe(snapshots);
  });

  it("要写的和现在的一样（一个字没改）→ ok=false，摘要说没有变化、不打存档点", async () => {
    const first = await foundationWriteLogic({ projectDir: book, ops: [{ op: "field.set", card: "林远", label: "外貌", value: "高个子" }] });
    expect(first.ok).toBe(true);
    const snapshots = (await listSnapshots(book)).length;
    const again = await foundationWriteLogic({ projectDir: book, ops: [{ op: "field.set", card: "林远", label: "外貌", value: "高个子" }] });
    expect(again).toMatchObject({ ok: false, applied: [] });
    expect(again.summary).toBe("设定本没有变化（要写的和现在的一样）。");
    expect(again.snapshotId).toBeUndefined();
    expect((await listSnapshots(book)).length).toBe(snapshots);
  });
});
