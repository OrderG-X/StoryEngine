// @vitest-environment node
// 设定包（重构 P9）：设定卡 + 账里记的现状 → 给写手 / 审稿 / 改稿看的一份。纯函数用例直接拿核心的 applyCardOps + bibleView 造设定视图。
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyCardOps,
  bibleView,
  emptySettingCards,
  ledgerOf,
  project,
  type BibleView,
  type CardOp,
  type ChapterLedger,
  type EntryDraft,
} from "@actalk/story-core";
import {
  EMPTY_BIBLE,
  EXEMPLAR_PROMPT_TEXT_CHARS,
  MAX_CAST,
  MAX_LINE_CHARS,
  MAX_LINES_PER_CARD,
  buildSettingPack,
  exemplarPromptItems,
  readBibleTolerant,
  renderSettingPack,
} from "./setting-pack.js";

const AT = "2026-10-19T00:00:00.000Z";

function bibleOf(ops: readonly CardOp[], ledgers: readonly ChapterLedger[] = [], by: "author" | "ai" = "author"): BibleView {
  const applied = applyCardOps(emptySettingCards(), ops, { by, at: AT });
  if (!applied.ok) throw new Error(applied.message);
  return bibleView(project({ ledgers, decisions: [] }), applied.file);
}

function chapterLedger(chapter: number, entries: readonly Record<string, unknown>[]): ChapterLedger {
  return ledgerOf({ chapter, committedAt: AT, entries: entries.map((entry, index) => ({ id: `e-${chapter}-${index}`, review: "auto", ...entry }) as unknown as EntryDraft) });
}

const character = (name: string, extra: Partial<Extract<CardOp, { op: "card.create" }>> = {}): CardOp =>
  ({ op: "card.create", kind: "character", name, ...extra });
const place = (name: string, extra: Partial<Extract<CardOp, { op: "card.create" }>> = {}): CardOp =>
  ({ op: "card.create", kind: "place", name, ...extra });

describe("buildSettingPack：选人", () => {
  it("主角恒带；本章相关人物只带点到名字（或别名）的，其余人物只列名字；点不到卡的名字不编", () => {
    const bible = bibleOf([
      character("林远", { protagonist: true, fields: [{ label: "身份", value: "外院杂役" }] }),
      character("苏晴", { aliases: ["阿晴"], fields: [{ label: "身份", value: "记者" }] }),
      character("老周"),
      character("陈管事"),
    ]);
    const pack = buildSettingPack(bible, { characters: ["阿晴", "林远", "查无此人"] });
    expect(pack.protagonist).toMatchObject({ name: "林远", card: ["身份：外院杂役"] });
    // 别名「阿晴」对上苏晴；主角不重复进 cast；「查无此人」没有卡，也没在账里出现过，不进。
    expect(pack.cast.map((brief) => brief.name)).toEqual(["苏晴"]);
    expect(pack.cast[0]).toMatchObject({ aliases: ["阿晴"], card: ["身份：记者"] });
    expect(pack.otherNames.characters).toEqual(["老周", "陈管事"]);
  });

  it("不给人物：只带主角；没有主角卡也不编一个", () => {
    const withProtagonist = buildSettingPack(bibleOf([character("林远", { protagonist: true }), character("苏晴")]));
    expect(withProtagonist.protagonist?.name).toBe("林远");
    expect(withProtagonist.cast).toEqual([]);
    const noProtagonist = buildSettingPack(bibleOf([character("苏晴")]), { characters: [] });
    expect(noProtagonist.protagonist).toBeUndefined();
    expect(noProtagonist.otherNames.characters).toEqual(["苏晴"]);
  });

  it(`本章相关人物最多 ${MAX_CAST} 人`, () => {
    const names = Array.from({ length: MAX_CAST + 3 }, (_, index) => `配角${index + 1}号`);
    const pack = buildSettingPack(bibleOf(names.map((name) => character(name))), { characters: names });
    expect(pack.cast).toHaveLength(MAX_CAST);
  });

  it("账里出场过、还没建卡的人点到了也带上，标「还没建卡」，只有账里记的", () => {
    const bible = bibleOf([character("林远", { protagonist: true })], [
      chapterLedger(1, [
        { kind: "presence", name: "林远", nameUsed: "林远", quote: "林远推开门。" },
        { kind: "presence", name: "老周", nameUsed: "老周", quote: "老周在门口。" },
        { kind: "fact", nature: "state", subject: "老周", attribute: "在哪", value: "码头", text: "老周在码头", quote: "老周在门口。" },
      ]),
    ]);
    const pack = buildSettingPack(bible, { characters: ["老周"] });
    expect(pack.cast).toEqual([expect.objectContaining({ name: "老周", card: [], uncarded: true })]);
    const text = renderSettingPack(pack).join("\n");
    expect(text).toContain("【老周】（还没建卡，只有账里记的）");
    expect(text).toContain("在哪：码头（第 1 章）");
  });
});

describe("buildSettingPack：地点 / 物品 / 设定按本章方向挑", () => {
  const manyPlaces = ["南门菜场", "旧码头", "钟楼", "账房", "后院", "城隍庙", "织造局", "药铺"];

  it("卡不多（≤6）就整张都带", () => {
    const pack = buildSettingPack(bibleOf([place("旧码头"), place("钟楼")]), { texts: ["随便写点什么"] });
    expect(pack.places.map((brief) => brief.name)).toEqual(["旧码头", "钟楼"]);
    expect(pack.otherNames.places).toEqual([]);
  });

  it("卡多了：本章方向 / 上一章正文里点到名字或别名的、章纲定的地点整张带，其余只列名字", () => {
    const bible = bibleOf([
      ...manyPlaces.map((name) => place(name, name === "城隍庙" ? { aliases: ["庙里"] } : {})),
    ]);
    const pack = buildSettingPack(bible, {
      texts: ["林远去旧码头等船。", "上一章：他在庙里躲雨。"],
      plannedPlaces: ["药铺"],
    });
    expect(pack.places.map((brief) => brief.name)).toEqual(["旧码头", "城隍庙", "药铺"]);
    expect(pack.otherNames.places).toEqual(["南门菜场", "钟楼", "账房", "后院", "织造局"]);
  });

  it("一个字的名字不拿去找（防普通字误中）", () => {
    const bible = bibleOf([...manyPlaces.map((name) => place(name)), place("井")]);
    const pack = buildSettingPack(bible, { texts: ["他从井边打了一桶水。"] });
    expect(pack.places.map((brief) => brief.name)).not.toContain("井");
  });

  it("物品、其他设定同一规矩：点到名字的整张带", () => {
    const items = Array.from({ length: 7 }, (_, index) => `物件${index + 1}号`);
    const bible = bibleOf([
      ...items.map((name): CardOp => ({ op: "card.create", kind: "item", name, fields: [{ label: "样子", value: `${name}的样子` }] })),
      { op: "card.create", kind: "lore", name: "守夜规矩", fields: [{ label: "内容", value: "子时后不许点灯" }] },
    ]);
    const pack = buildSettingPack(bible, { texts: ["他把物件3号揣进怀里。"] });
    expect(pack.items).toEqual([expect.objectContaining({ name: "物件3号", card: ["样子：物件3号的样子"] })]);
    expect(pack.otherNames.items).toHaveLength(6);
    expect(pack.lore.map((brief) => brief.name)).toEqual(["守夜规矩"]);
  });
});

describe("buildSettingPack：卡上的字", () => {
  it(`每张卡最多 ${MAX_LINES_PER_CARD} 行，超了如实标「还有 N 项没列」；每行过长截断`, () => {
    const fields = Array.from({ length: MAX_LINES_PER_CARD + 3 }, (_, index) => ({ label: `第${index + 1}项`, value: "内容" }));
    fields[0] = { label: "长段", value: "长".repeat(MAX_LINE_CHARS + 50) };
    const pack = buildSettingPack(bibleOf([character("林远", { protagonist: true, fields })]));
    const card = pack.protagonist?.card ?? [];
    expect(card).toHaveLength(MAX_LINES_PER_CARD + 1);
    expect(card.at(-1)).toBe("（还有 3 项没列）");
    expect(card[0]?.length).toBe(MAX_LINE_CHARS);
    expect(card[0]?.endsWith("…")).toBe(true);
  });

  it("两人之间的关系两张卡上都显示「和 X：…」", () => {
    const pack = buildSettingPack(bibleOf([
      character("林远", { protagonist: true }),
      character("苏晴"),
      { op: "relation.set", a: "林远", b: "苏晴", label: "同事，互相提防" },
    ]), { characters: ["苏晴"] });
    expect(pack.protagonist?.relations).toEqual(["和苏晴：同事，互相提防"]);
    expect(pack.cast[0]?.relations).toEqual(["和林远：同事，互相提防"]);
  });

  it("账里记的：会变的进「现状」、不会变的进「正文里已经定下的」，都带章号", () => {
    const bible = bibleOf([character("林远", { protagonist: true })], [
      chapterLedger(1, [
        { kind: "presence", name: "林远", nameUsed: "林远", quote: "林远推开门。" },
        { kind: "fact", nature: "hard", subject: "林远", attribute: "左手", value: "缺一根小指", text: "林远左手缺一根小指", quote: "林远推开门。" },
      ]),
      chapterLedger(2, [
        { kind: "presence", name: "林远", nameUsed: "林远", quote: "林远到了码头。" },
        { kind: "fact", nature: "state", subject: "林远", attribute: "在哪", value: "码头", text: "林远在码头", quote: "林远到了码头。" },
      ]),
    ]);
    const pack = buildSettingPack(bible);
    expect(pack.protagonist?.fixed).toEqual(["左手：缺一根小指（第 1 章）"]);
    expect(pack.protagonist?.now).toEqual(["在哪：码头（第 2 章）"]);
    const text = renderSettingPack(pack).join("\n");
    expect(text).toContain("- 正文里已经定下的：\n  - 左手：缺一根小指（第 1 章）");
    expect(text).toContain("- 账里记的现状（以最新一章为准）：\n  - 在哪：码头（第 2 章）");
  });
});

describe("exemplarPromptItems：文风样本进提示词有预算", () => {
  it(`单条截到 ${EXEMPLAR_PROMPT_TEXT_CHARS} 字，合计封顶后剩下的整条不进`, () => {
    const bible = bibleOf([
      { op: "exemplar.add", text: "一".repeat(900), note: "开头节奏" },
      { op: "exemplar.add", text: "二".repeat(900) },
      { op: "exemplar.add", text: "三".repeat(900) },
    ]);
    const items = exemplarPromptItems(bible.rules);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ text: "一".repeat(EXEMPLAR_PROMPT_TEXT_CHARS), note: "开头节奏" });
    expect(items[1]?.text).toBe("二".repeat(EXEMPLAR_PROMPT_TEXT_CHARS));
  });
});

describe("renderSettingPack：渲染成中文", () => {
  it("作者自定写作规矩、文风样本放最前；写作规则、故事设定、各组卡、没展开的名字依次跟上；不带编号", () => {
    const bible = bibleOf([
      { op: "story.set", label: "一句话", value: "外院杂役查账翻身。" },
      { op: "rules.set", field: "notes", value: "## 我的节奏\n- 打斗段落用短句" },
      { op: "rules.set", field: "perspective", value: "第三人称，紧跟主角" },
      { op: "rules.set", field: "targetWords", value: 2400 },
      { op: "rules.set", field: "minWords", value: 2000 },
      { op: "rules.add", list: "style", text: "克制" },
      { op: "rules.add", list: "musts", text: "每章结尾留一个钩子" },
      { op: "rules.add", list: "bans", text: "不写血腥场面" },
      { op: "rules.add", list: "avoid", text: "嘴角勾起一抹弧度" },
      { op: "exemplar.add", text: "雨先是落在檐角，再落到他的肩上。", note: "我满意的开头" },
      character("林远", { protagonist: true, aliases: ["小林"], fields: [{ label: "身份", value: "外院杂役" }] }),
      character("苏晴"),
      place("账房", { fields: [{ label: "格局", value: "两进院子" }] }),
      { op: "card.create", kind: "item", name: "蓝皮账册" },
      { op: "card.create", kind: "lore", name: "守夜规矩" },
    ]);
    const lines = renderSettingPack(buildSettingPack(bible));
    const text = lines.join("\n");
    const order = [
      "## 作者自定写作规矩（务必遵守）",
      "## 作者文风样本（模仿风格·不得照抄内容）",
      "## 写作规则",
      "## 故事设定",
      "## 主角",
      "## 地点",
      "## 物品",
      "## 其他设定",
      "## 设定本里还有",
    ].map((heading) => text.indexOf(heading));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain("- 打斗段落用短句");
    expect(text).toContain("不得照抄样本内容、情节或具体名物");
    expect(text).toContain("### 样本1\n（注：我满意的开头）\n雨先是落在檐角，再落到他的肩上。");
    expect(text).toContain("- 视角：第三人称，紧跟主角");
    expect(text).toContain("- 文风：克制");
    expect(text).toContain("- 每章目标字数：2400");
    expect(text).toContain("- 每章最少字数：2000");
    expect(text).toContain("- 一定要做到：每章结尾留一个钩子");
    expect(text).toContain("- 一定不要写：不写血腥场面");
    expect(text).toContain("- 别用的说法：嘴角勾起一抹弧度");
    expect(text).toContain("- 一句话：外院杂役查账翻身。");
    expect(text).toContain("【林远】（也叫：小林）\n- 身份：外院杂役");
    expect(text).toContain("【账房】\n- 格局：两进院子");
    expect(text).toContain("- 人物：苏晴");
    expect(text).not.toMatch(/\b(?:k|r|e)-\d+\b/u);
  });

  it("空设定本渲染成空，不出空标题", () => {
    expect(renderSettingPack(buildSettingPack(EMPTY_BIBLE))).toEqual([]);
  });
});

describe("readBibleTolerant：设定本读坏如实降级", () => {
  it("cards.json 坏了 → 按空设定继续，原因如实交回（不带本地绝对路径）", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "story-engine-setting-pack-"));
    await mkdir(join(projectDir, "ledger"), { recursive: true });
    await writeFile(join(projectDir, "ledger", "cards.json"), "{not-json", "utf-8");
    const read = await readBibleTolerant(projectDir);
    expect(read.bible).toBe(EMPTY_BIBLE);
    expect(read.projection).toBeUndefined();
    expect(read.failure).toContain("设定本读取失败");
    expect(read.failure).toContain("已按空设定降级");
    expect(read.failure).not.toMatch(/\/Users|\/var|\/private|\/tmp|\/home/u);
  });
});

describe("定论（P12）进写作上下文", () => {
  it("作者定论全带、排在规则前，写明全书以它为准；没有就不出这一节", () => {
    const bible = bibleOf([{ op: "canon.add", text: "杜长顺十年前去世" }, character("许微", { protagonist: true })]);
    const pack = buildSettingPack(bible, {});
    expect(pack.canon).toEqual(["杜长顺十年前去世"]);
    const text = renderSettingPack(pack).join("\n");
    expect(text).toContain("## 作者定论（前文说法打架时作者定下的，全书以它为准；写的时候不许和它矛盾）");
    expect(text).toContain("杜长顺十年前去世");
    expect(renderSettingPack(buildSettingPack(bibleOf([character("许微", { protagonist: true })]), {})).join("\n")).not.toContain("作者定论");
  });
});
