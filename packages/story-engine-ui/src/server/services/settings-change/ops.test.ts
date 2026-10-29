// @vitest-environment node
//
// 改设定（写作版本 P2a 片 3：settings.change 收编 foundation_write、「确认改设定」「认下」）：
// 边界先把模型常传的退化写法归一；全是 AI 能做的写进去、标「AI 补的」，备好「认下」；碰了作者写的**整批**一个字不改、
// 等作者点「确认改设定」，提议之后书变了就不改；格式不对 / 指错卡的如实列进「没改成」；一处没改成如实失败。
// 真项目、真存档点、真执行器，不调模型。
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { cardWrite, MAX_OPS_PER_CHANGE, readCards, runCommand, type CardOp } from "@actalk/story-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStoryProject } from "../../book/project-store.js";
import { makeHomeTempDir } from "../../lib/home-test-tmp.js";
import { readCheckpoint } from "../../lib/operations/checkpoints.js";
import { __resetExecutionsForTests } from "../../lib/operations/context.js";
import { __resetLiveForTests } from "../../lib/operations/live.js";
import { __resetOperationStoreForTests, listOperations, readOperation, type OperationRecord } from "../../lib/operations/store.js";
import { listSnapshots } from "../../lib/snapshot.js";
import { __drainOperationsForTests, __resetRecipesForTests, registerRecipe, resumeOperation, submitOperation } from "../operations/executor.js";
import { readSettingsChangeParams, SETTINGS_CHANGE_KIND, SETTINGS_CONFIRM_KIND, settingsChangeRecipe, type SettingsChangeBody, type SettingsConfirmPreview } from "../operations/recipes/settings-change.js";
import { normalizeRawOp } from "./ops.js";

/** 编号只给程序用，给人看的话里一个都不许出现。 */
const RAW_ID = /[kre]-\d/u;

let rootDir: string;
let book: string;
beforeEach(async () => {
  __resetOperationStoreForTests();
  __resetExecutionsForTests();
  __resetLiveForTests();
  __resetRecipesForTests();
  rootDir = await makeHomeTempDir("settings-change-");
  vi.stubEnv("SE_DATA_DIR", join(rootDir, "data"));
  ({ projectDir: book } = await createStoryProject({ rootDir, title: "海州账册", genre: "都市", logline: "审计员林远追查账册篡改。", protagonistName: "林远" }));
  registerRecipe(settingsChangeRecipe);
});
afterEach(async () => {
  await __drainOperationsForTests();
  __resetRecipesForTests();
  vi.unstubAllEnvs();
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

const submit = (params: Record<string, unknown>, origin: "chat" | "button" = "chat") => submitOperation(book, {
  kind: SETTINGS_CHANGE_KIND,
  params,
  requestKey: randomUUID(),
  issuedAt: new Date().toISOString(),
  origin: origin === "chat" ? { kind: "chat", messageId: randomUUID() } : { kind: "button" },
});

async function stored(opId: string): Promise<OperationRecord> {
  const read = await readOperation(book, opId);
  if (read.kind !== "record") throw new Error("记录没了");
  return read.record;
}

/** 交一次、等它停下（做完 / 没做成 / 等作者）。 */
async function settled(params: Record<string, unknown>, origin: "chat" | "button" = "chat"): Promise<OperationRecord> {
  const outcome = await submit(params, origin);
  if (!outcome.ok || !("record" in outcome)) throw new Error(`没受理：${JSON.stringify(outcome)}`);
  await __drainOperationsForTests();
  return stored(outcome.record.opId);
}

async function change(ops: Record<string, unknown>[]): Promise<OperationRecord> {
  return settled({ ops });
}

const bodyOf = (record: OperationRecord): SettingsChangeBody => (record.result as { readonly body: SettingsChangeBody }).body;
const summaryOf = (record: OperationRecord): string => (record.result as { readonly summary: string }).summary;

async function confirm(record: OperationRecord): Promise<OperationRecord> {
  const outcome = await resumeOperation(book, record.opId, { actionId: "confirm-settings", decision: "apply" });
  expect(outcome.ok).toBe(true);
  await __drainOperationsForTests();
  return stored(record.opId);
}

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

describe("参数：受理前挡下没法做的", () => {
  it("没有要改的、全是格式不对的、步数超了都不受理；认下只认作者按钮、要带对的操作号", async () => {
    expect(readSettingsChangeParams("chat", { ops: [] })).toEqual({ invalid: "没有要改的。" });
    expect(readSettingsChangeParams("chat", { ops: [{ name: "没写 op" }] })).toEqual({ invalid: "设定没改：第 1 步（（没写 op））格式不对：op。" });
    expect(readSettingsChangeParams("chat", { ops: Array.from({ length: MAX_OPS_PER_CHANGE + 1 }, (_, i) => ({ op: "card.create", kind: "item", name: `物${i}` })) })).toMatchObject({ invalid: expect.stringContaining("一次最多改") });
    expect(readSettingsChangeParams("chat", { accept: "op-0123456789abcdef0123" })).toEqual({ invalid: "认下要你自己点按钮。" });
    expect(readSettingsChangeParams("button", { accept: "op-短" })).toEqual({ invalid: "这个按钮缺了标记，请刷新后再点。" });
    expect(await submit({ accept: "op-0123456789abcdef0123" }, "button")).toMatchObject({ ok: false, code: "stale_button" });
    expect(await listOperations(book)).toEqual([]);
  });
});

describe("全是 AI 能做的：写进去，标 AI 补的", () => {
  it("建新卡、给作者的卡加新栏、记关系、写作规则（中文栏名）→ 真写盘、带存档点、记成 AI 写的；摘要只有名字", async () => {
    const before = (await listSnapshots(book)).length;
    const record = await change([
      { op: "card.create", kind: "人物", name: "苏晴", aliases: "", fields: [{ label: "身份", value: "报社记者" }], protagonist: "false" },
      { op: "field.set", card: "林远", label: "外貌", value: "高个子，戴黑框眼镜" },
      { op: "relation.set", a: "林远", b: "苏晴", label: "大学同学" },
      { op: "rules.set", field: "每章目标字数", value: "2400" },
      { op: "rules.add", list: "一定不要写", text: "不写血腥场面" },
    ]);

    expect(record.state).toBe("succeeded");
    const body = bodyOf(record);
    expect(body.notDone).toEqual([]);
    expect(body.applied).toEqual([
      "建了人物卡「苏晴」",
      "「林远」的「外貌」写上了",
      "「林远」和「苏晴」的关系写上了",
      "写作规则「每章目标字数」写上了",
      "写作规则「一定不要写」加了一条",
    ]);
    expect(body.snapshotId).toMatch(/^[0-9a-f]{40}$/u);
    expect((await listSnapshots(book)).length).toBeGreaterThan(before);
    expect(summaryOf(record).startsWith("改好了：")).toBe(true);
    expect(summaryOf(record)).not.toMatch(RAW_ID);

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
  });

  it("AI 改自己补的直接改，不用作者点头", async () => {
    await change([{ op: "card.create", kind: "item", name: "蓝色账册", fields: [{ label: "样子", value: "硬皮" }] }]);
    const record = await change([{ op: "field.set", card: "蓝色账册", label: "样子", value: "硬皮，第三页被撕" }]);
    expect(record.state).toBe("succeeded");
    expect(bodyOf(record).applied).toEqual(["「蓝色账册」的「样子」改了"]);
    expect((await cards()).cards.find((card) => card.name === "蓝色账册")!.fields[0]).toMatchObject({ value: "硬皮，第三页被撕", by: "ai" });
  });
});

describe("「认下」：AI 刚写进去的，作者点了算作者写的", () => {
  it("建卡、给作者的卡填栏、故事设定、写作规则 → 备好对应的认下；作者点了就都算作者写的", async () => {
    const record = await change([
      { op: "card.create", kind: "人物", name: "苏晴", fields: [{ label: "身份", value: "报社记者" }] },
      { op: "field.set", card: "苏晴", label: "性格", value: "急" },
      { op: "field.set", card: "林远", label: "外貌", value: "高个子" },
      { op: "relation.set", a: "林远", b: "苏晴", label: "大学同学" },
      { op: "story.set", label: "基调", value: "冷" },
      { op: "rules.add", list: "一定不要写", text: "不写血腥场面" },
    ]);
    expect(bodyOf(record).accept).toEqual({ label: "刚写的这几处" });
    expect(summaryOf(record)).toContain("点「认下」就算你写的");
    const plan = (await readCheckpoint(book, record.opId, "accept"))!.output as { readonly ops: readonly CardOp[] };
    expect(plan.ops).toEqual([
      { op: "field.accept", card: "苏晴" },
      { op: "field.accept", card: "林远", label: "外貌" },
      { op: "story.accept", label: "基调" },
      { op: "rules.accept" },
    ]);

    const accepted = await settled({ accept: record.opId }, "button");
    expect(accepted).toMatchObject({ state: "succeeded", mode: "accept" });
    expect(summaryOf(accepted)).toMatch(/^认下了「苏晴」/u);
    const file = await cards();
    const su = file.cards.find((card) => card.name === "苏晴")!;
    expect(su.by).toBe("author");
    expect(su.fields.every((field) => field.by === "author")).toBe(true);
    expect(file.cards.find((card) => card.name === "林远")!.fields.find((field) => field.label === "外貌")!.by).toBe("author");
    expect(file.story.fields.find((field) => field.label === "基调")!.by).toBe("author");
    expect(file.rules.bans[0]!.by).toBe("author");
  });

  it("写作规则里本来就有作者没过目的 AI 补的：不带整体认下，免得一并认下", async () => {
    await change([{ op: "rules.add", list: "一定不要写", text: "不写血腥场面" }]);
    const record = await change([{ op: "rules.add", list: "文风", text: "短句" }]);
    expect(record.state).toBe("succeeded");
    expect(bodyOf(record).accept).toBeUndefined();
  });

  it("AI 写完之后设定又改过 → 不认、说清哪里变了", async () => {
    const record = await change([{ op: "card.create", kind: "人物", name: "苏晴" }]);
    await authorWrite([{ op: "field.set", card: "林远", label: "性格", value: "闷" }]);
    const accepted = await settled({ accept: record.opId }, "button");
    expect(accepted.state).toBe("obsolete");
    expect(accepted.failure?.message).toMatch(/^AI 写完之后.+改过，这份改动是照改之前提的，没改。$/u);
    expect((await cards()).cards.find((card) => card.name === "苏晴")!.by).toBe("ai");
  });
});

describe("碰了作者写的：整批一个字不改，等作者点「确认改设定」", () => {
  it("改作者写的栏 + 建新卡：整批停下等作者（AI 能做的那步也不先做）；卡上说清每一处；点了按作者写的改齐", async () => {
    await authorWrite([{ op: "field.set", card: "林远", label: "身份", value: "审计员" }]);
    const before = await cardsText();
    const record = await change([
      { op: "field.set", card: "林远", label: "身份", value: "记者" },
      { op: "card.create", kind: "item", name: "蓝色账册" },
    ]);

    expect(record.state).toBe("waiting_author");
    expect(record.pendingActions).toEqual([expect.objectContaining({ actionId: "confirm-settings", kind: SETTINGS_CONFIRM_KIND, decisions: ["apply"] })]);
    const preview = record.pendingActions[0]!.preview as SettingsConfirmPreview;
    expect(preview).toEqual({ lines: ["「林远」的「身份」改了", "建了物品卡「蓝色账册」"], notDone: [] });
    expect(await cardsText()).toBe(before);

    const done = await confirm(record);
    expect(done.state).toBe("succeeded");
    expect(summaryOf(done)).toBe("改好了：「林远」的「身份」改了；建了物品卡「蓝色账册」（可撤销）。");
    const file = await cards();
    expect(file.cards.find((card) => card.name === "林远")!.fields.find((field) => field.label === "身份")).toMatchObject({ value: "记者", by: "author" });
    expect(file.cards.find((card) => card.name === "蓝色账册")).toMatchObject({ by: "author" });
  });

  it("提议之后作者又改了设定 → 点了也不改、说清哪里变了", async () => {
    await authorWrite([{ op: "field.set", card: "林远", label: "身份", value: "审计员" }]);
    const record = await change([{ op: "field.set", card: "林远", label: "身份", value: "记者" }]);
    await authorWrite([{ op: "field.set", card: "林远", label: "性格", value: "闷" }]);
    const done = await confirm(record);
    expect(done.state).toBe("obsolete");
    expect(done.failure?.message).toMatch(/^提议之后.+改过，这份改动是照改之前提的，没改。$/u);
    expect((await cards()).cards.find((card) => card.name === "林远")!.fields.find((field) => field.label === "身份")).toMatchObject({ value: "审计员" });
  });

  it("改名 + 按新名字补栏、删作者建的卡：整批交给作者，一个字不写、不打存档点", async () => {
    await authorWrite([{ op: "card.create", kind: "character", name: "顾明" }]);
    const before = await cardsText();
    const snapshots = (await listSnapshots(book)).length;
    const record = await change([
      { op: "card.rename", card: "林远", name: "林澈" },
      { op: "field.set", card: "林澈", label: "外貌", value: "瘦高" },
      { op: "card.delete", card: "顾明" },
    ]);
    expect(record.state).toBe("waiting_author");
    expect((record.pendingActions[0]!.preview as SettingsConfirmPreview).lines).toEqual(["「林远」改名为「林澈」，旧名留作别名", "「林澈」的「外貌」写上了", "删了人物卡「顾明」"]);
    expect(await cardsText()).toBe(before);
    expect((await listSnapshots(book)).length).toBe(snapshots);
  });

  it("换主角也要作者点头", async () => {
    await authorWrite([{ op: "card.create", kind: "character", name: "苏晴" }]);
    const record = await change([{ op: "card.protagonist", card: "苏晴" }]);
    expect(record.state).toBe("waiting_author");
    expect((record.pendingActions[0]!.preview as SettingsConfirmPreview).lines).toEqual(["「苏晴」设为主角"]);
    expect((await cards()).cards.find((card) => card.protagonist)?.name).toBe("林远");
  });
});

describe("没做成的如实说", () => {
  it("格式不对、指错卡 → 进「没改成」并说清第几步、为什么；对的那步照做", async () => {
    const record = await change([
      { op: "card.create", kind: "怪物", name: "夜行者" },
      { op: "field.set", card: "不存在的人", label: "外貌", value: "高" },
      { name: "没写 op" },
      { op: "card.create", kind: "place", name: "市档案馆" },
    ]);
    expect(record.state).toBe("succeeded");
    expect(bodyOf(record).applied).toEqual(["建了地点卡「市档案馆」"]);
    expect(bodyOf(record).notDone).toEqual([
      "第 1 步（card.create）格式不对：kind",
      "第 3 步（（没写 op））格式不对：op",
      "没有叫「不存在的人」的卡",
    ]);
    expect(summaryOf(record)).toContain("没改成：");
    expect((await cards()).cards.map((card) => card.name)).toEqual(["林远", "市档案馆"]);
  });

  it("全都做不成 → 没做成、说清每一步为什么；不写盘、不打存档点", async () => {
    const before = await cardsText();
    const snapshots = (await listSnapshots(book)).length;
    const record = await change([
      { op: "card.create", kind: "character", name: "林远" },
      { op: "rules.set", field: "targetWords", value: "两千" },
    ]);
    expect(record.state).toBe("failed");
    expect(record.failure?.message).toContain("已经有叫「林远」的卡了");
    expect(record.failure?.message).toContain("要写一个整数");
    expect(await cardsText()).toBe(before);
    expect((await listSnapshots(book)).length).toBe(snapshots);
  });

  it("要写的和现在的一样（一个字没改）→ 没做成、说没有变化，不打存档点", async () => {
    expect((await change([{ op: "field.set", card: "林远", label: "外貌", value: "高个子" }])).state).toBe("succeeded");
    const snapshots = (await listSnapshots(book)).length;
    const again = await change([{ op: "field.set", card: "林远", label: "外貌", value: "高个子" }]);
    expect(again.state).toBe("failed");
    expect(again.failure?.message).toBe("要写的和现在的一样，设定本没有变化。");
    expect((await listSnapshots(book)).length).toBe(snapshots);
  });
});
