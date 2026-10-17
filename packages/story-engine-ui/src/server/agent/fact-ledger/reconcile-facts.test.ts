// @vitest-environment node
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readFactLedger } from "./fact-ledger.js";
import { buildReconcileMessages, stripInventedStoryDays, factSwapsKinshipForName, parseReconcile, pickRelatedFacts, proposeFactChanges, toChapterFactUpdate } from "./reconcile-facts.js";

const DRAFT = "林舟骑车到了南门。菜场还在，门口摆着几摊卖豆腐的。他想起周婶那座钟昨天已经修好送回去了。";

async function makeLedger(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "se-reconcile-facts-"));
  await mkdir(join(dir, "story"), { recursive: true });
  await writeFile(join(dir, "story", "fact-ledger.json"), JSON.stringify({
    version: "v0",
    facts: [
      { id: "fact-4-0", chapter: 4, text: "南门菜场十来年前就拆了，原址盖了商场。", source: "auto" },
      { id: "fact-4-1", chapter: 4, text: "周婶的座钟停了，放在林舟铺子里等修。", source: "auto" },
      { id: "fact-4-2", chapter: 4, text: "许棠约定后天上午九点来量面积。", source: "auto" },
    ],
  }), "utf-8");
  return dir;
}

describe("pickRelatedFacts / buildReconcileMessages", () => {
  it("按本章正文挑相关旧事实并编号；只取本章之前的", async () => {
    const dir = await makeLedger();
    const { facts } = await readFactLedger(dir);
    const related = pickRelatedFacts([...facts, { id: "fact-8-0", chapter: 8, text: "本章自己上一版记的", source: "auto" }], 8, DRAFT, ["林舟", "周婶"]);
    expect(related.map((item) => item.fact.id)).toContain("fact-4-0");
    expect(related.map((item) => item.fact.id)).not.toContain("fact-8-0");
    expect(related[0].ref).toBe("F1");
    const [, user] = buildReconcileMessages(DRAFT, related, ["林舟"]);
    expect(user.content).toContain("（第4章）南门菜场十来年前就拆了");
    // 第十七轮「下周三」原样入账：给本章日子，要求换成故事第几天 / 星期几。
    const [system, dated] = buildReconcileMessages(DRAFT, related, ["林舟"], "本章是故事第 8 天，周三");
    expect(dated.content).toContain("【本章日子】本章是故事第 8 天，周三");
    expect(system.content).toContain("不要写明天、后天、下周、前天这类相对说法");
  });
});

describe("parseReconcile 宽进", () => {
  it("条目给成字符串、ref 小写、多余键都收；缺字段的丢", () => {
    const parsed = parseReconcile(JSON.stringify({
      facts: ["座钟已修好送回周婶", { text: "" }],
      changes: [{ ref: "f2", text: "周婶的座钟已修好送回", quote: "座钟昨天已经修好送回去了", why: "多余" }, { ref: "F9" }],
      conflicts: [{ ref: "F1", quote: "菜场还在", note: "第4章说已拆" }, { ref: "F1", note: "没引文" }],
      newCharacters: ["吴师傅"],
      extra: true,
    }));
    expect(parsed.facts).toEqual([{ text: "座钟已修好送回周婶", quote: "" }]);
    expect(parsed.changes).toEqual([{ ref: "F2", text: "周婶的座钟已修好送回", quote: "座钟昨天已经修好送回去了" }]);
    expect(parsed.conflicts).toEqual([{ ref: "F1", quote: "菜场还在", note: "第4章说已拆" }]);
    expect(parsed.newCharacters).toEqual(["吴师傅"]);
  });
});

describe("factSwapsKinshipForName（第十九轮「爸的老同事」记成祖父的老同事）", () => {
  it("原句用称呼、事实换成人名 → 不收；称呼和名字都在、或原句就有名字的照收", () => {
    const names = ["林舟", "林德昌", "林溪"];
    expect(factSwapsKinshipForName({ text: "吴德发是林德昌的老同事", quote: "他是我爸的老同事" }, names)).toBe(true);
    expect(factSwapsKinshipForName({ text: "吴德发是林舟父亲的老同事", quote: "他是我爸的老同事" }, names)).toBe(false);
    expect(factSwapsKinshipForName({ text: "林溪是林舟的妹妹", quote: "妹妹林溪打来电话" }, names)).toBe(false);
    expect(factSwapsKinshipForName({ text: "林舟把表放在柜上", quote: "他把表放在柜上" }, names)).toBe(false);
  });
});

// 账本 v2（带 kind / subject）＋ 没这两字段的老条目，各一条——R7.4 的确定性检查用。
async function makeLedgerV2(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "se-reconcile-facts-v2-"));
  await mkdir(join(dir, "story"), { recursive: true });
  await writeFile(join(dir, "story", "fact-ledger.json"), JSON.stringify({
    version: "v0",
    facts: [
      { id: "fact-1-4", chapter: 1, text: "老周的茶馆在钟楼斜对面。", source: "auto", subject: "老周的茶馆", attribute: "位置", value: "钟楼斜对面", kind: "hard" },
      { id: "fact-1-12", chapter: 1, text: "铜盒在沈青禾帆布包最里层。", source: "auto", subject: "铜盒", attribute: "在哪", value: "帆布包最里层", kind: "state" },
      { id: "fact-5-7", chapter: 5, text: "周晓兰手背上也有一道疤。", source: "auto", subject: "周晓兰", attribute: "手背疤", value: "一道浅的横疤", kind: "hard" },
      { id: "fact-4-5", chapter: 4, text: "旧怀表是沈青禾的爷爷留下的。", source: "auto", subject: "旧怀表", attribute: "归属", value: "沈青禾的爷爷", kind: "hard" },
      { id: "fact-3-0", chapter: 3, text: "茶馆门口支着两张竹桌。", source: "auto" },
    ],
  }), "utf-8");
  return dir;
}

const V2_NAMES = ["沈青禾", "老周", "周晓兰"];

describe("改记过确定性检查（R7.4：别作废不会变的事实）", () => {
  it("旧条是 hard（茶馆在哪）：改记不自动作废 → changesToConfirm；作者勾了（confirmChanges）才写", async () => {
    const dir = await makeLedgerV2();
    const draft = "到茶馆的时候，门口两张竹桌已经收进墙根，店门关着。";
    // 编号由挑事实算法定：换成真编号再发。
    const related = pickRelatedFacts((await readFactLedger(dir)).facts, 9, draft, V2_NAMES);
    const ref = related.find((item) => item.fact.id === "fact-1-4")!.ref;
    const callModel = vi.fn(async () => JSON.stringify({
      facts: [],
      changes: [{ ref, text: "茶馆门口竹桌收进墙根，店门关着", quote: "门口两张竹桌已经收进墙根，店门关着" }],
      conflicts: [], newCharacters: [],
    }));
    const proposal = await proposeFactChanges({ projectDir: dir, chapter: 9, draftText: draft, callModel, knownNames: V2_NAMES });
    expect(proposal.changes).toEqual([]);
    expect(proposal.changesToConfirm).toEqual([{
      factId: "fact-1-4",
      oldChapter: 1,
      oldText: "老周的茶馆在钟楼斜对面。",
      newText: "茶馆门口竹桌收进墙根，店门关着",
      quote: "门口两张竹桌已经收进墙根，店门关着",
      why: "hard",
    }]);
    // 默认（没勾）不作数；勾了（change_confirm 前缀拆出来的 confirmChanges）才进引擎的变更。
    expect(toChapterFactUpdate(proposal, {})!.changes).toEqual([]);
    expect(toChapterFactUpdate(proposal, { confirmChanges: new Set(["fact-1-4"]) })!.changes)
      .toEqual([expect.objectContaining({ factId: "fact-1-4", newText: "茶馆门口竹桌收进墙根，店门关着" })]);
  });

  it("旧条主语和新说法对不上（state：铜盒 vs 图纸）也不自动作废", async () => {
    const dir = await makeLedgerV2();
    const draft = "铜盒还在帆布包最里层压着。她把图纸卷成一卷塞进侧兜。";
    const related = pickRelatedFacts((await readFactLedger(dir)).facts, 9, draft, V2_NAMES);
    const ref = related.find((item) => item.fact.id === "fact-1-12")!.ref;
    const callModel = vi.fn(async () => JSON.stringify({
      facts: [],
      changes: [{ ref, text: "图纸卷成一卷塞进侧兜", quote: "她把图纸卷成一卷塞进侧兜。" }],
      conflicts: [], newCharacters: [],
    }));
    const proposal = await proposeFactChanges({ projectDir: dir, chapter: 9, draftText: draft, callModel, knownNames: V2_NAMES });
    expect(proposal.changes).toEqual([]);
    expect(proposal.changesToConfirm?.[0]).toMatchObject({ factId: "fact-1-12", why: "subject" });
  });

  it("主语对得上的 state 改记账旧路自动作废；老数据（没有 kind / subject）两关都过、照旧自动", async () => {
    const dir = await makeLedgerV2();
    const draft = "铜盒取出来放在台面正中。茶馆门口两张竹桌已经收进墙根。";
    const facts = (await readFactLedger(dir)).facts;
    const related = pickRelatedFacts(facts, 9, draft, V2_NAMES);
    const refBox = related.find((item) => item.fact.id === "fact-1-12")!.ref;
    const refOld = related.find((item) => item.fact.id === "fact-3-0")!.ref;
    const callModel = vi.fn(async () => JSON.stringify({
      facts: [],
      changes: [
        { ref: refBox, text: "铜盒从帆布包里取出，放在台面正中", quote: "铜盒取出来放在台面正中。" },
        { ref: refOld, text: "茶馆门口竹桌收了", quote: "茶馆门口两张竹桌已经收进墙根。" },
      ],
      conflicts: [], newCharacters: [],
    }));
    const proposal = await proposeFactChanges({ projectDir: dir, chapter: 9, draftText: draft, callModel, knownNames: V2_NAMES });
    expect(proposal.changes.map((change) => change.factId)).toEqual(["fact-1-12", "fact-3-0"]);
    expect(proposal.changesToConfirm ?? []).toEqual([]);
  });
});

describe("回执「和旧设定对不上」的确定性过滤（R7.4 误报）", () => {
  it("老周的疤对上周晓兰的疤（不同主语）不报；同主语的照报", async () => {
    const dir = await makeLedgerV2();
    const draft = "老周的右手腕上有一道疤，从手腕往上爬。右手袖口那里，有一道很浅的疤从手腕往上爬，被灯光照着。周晓兰的手背上干干净净，什么都没有。";
    const related = pickRelatedFacts((await readFactLedger(dir)).facts, 9, draft, V2_NAMES);
    const refScar = related.find((item) => item.fact.id === "fact-5-7")!.ref;
    const callModel = vi.fn(async () => JSON.stringify({
      // 本章新事实：同一引文，主语是老周（账本 v2 三元组）。
      facts: [{ text: "老周右手腕上有一道浅疤", quote: "右手袖口那里，有一道很浅的疤从手腕往上爬，被灯光照着。", subject: "老周", attribute: "疤", value: "很浅，从手腕往上爬", kind: "hard" }],
      changes: [],
      conflicts: [
        // 引文没点名（和上面那条新事实同引文）→ 靠新事实的主语认出是老周 ≠ 周晓兰 → 不报。
        { ref: refScar, quote: "右手袖口那里，有一道很浅的疤从手腕往上爬，被灯光照着。", note: "第5章说疤在周晓兰手背上" },
        // 引文点了另一个已确立人物（老周）→ 两个人的事不比 → 不报。
        { ref: refScar, quote: "老周的右手腕上有一道疤，从手腕往上爬。", note: "第5章说疤在周晓兰手背上" },
        // 同一个主语（周晓兰）→ 照报。
        { ref: refScar, quote: "周晓兰的手背上干干净净，什么都没有。", note: "第5章说周晓兰手背上有疤" },
      ],
      newCharacters: [],
    }));
    const proposal = await proposeFactChanges({ projectDir: dir, chapter: 9, draftText: draft, callModel, knownNames: V2_NAMES });
    expect(proposal.conflicts.map((conflict) => conflict.quote)).toEqual(["周晓兰的手背上干干净净，什么都没有。"]);
  });

  it("引文是问句（角色在发问）不当断言比；陈述句照报", async () => {
    const dir = await makeLedgerV2();
    const draft = "她问老周：「怀表是那个外乡人留下的？」后来又说：「这只怀表是那个外乡人留下的。」";
    const related = pickRelatedFacts((await readFactLedger(dir)).facts, 9, draft, V2_NAMES);
    const refWatch = related.find((item) => item.fact.id === "fact-4-5")!.ref;
    const callModel = vi.fn(async () => JSON.stringify({
      facts: [], changes: [],
      conflicts: [
        { ref: refWatch, quote: "怀表是那个外乡人留下的？", note: "第4章说是爷爷留下的" },
        { ref: refWatch, quote: "这只怀表是那个外乡人留下的。", note: "第4章说是爷爷留下的" },
      ],
      newCharacters: [],
    }));
    const proposal = await proposeFactChanges({ projectDir: dir, chapter: 9, draftText: draft, callModel, knownNames: V2_NAMES });
    expect(proposal.conflicts.map((conflict) => conflict.quote)).toEqual(["这只怀表是那个外乡人留下的。"]);
  });

  it("老数据没有 subject 的旧条目：冲突照旧报，不崩", async () => {
    const dir = await makeLedgerV2();
    const draft = "茶馆门口的两张竹桌不见了。";
    const related = pickRelatedFacts((await readFactLedger(dir)).facts, 9, draft, V2_NAMES);
    const refOld = related.find((item) => item.fact.id === "fact-3-0")!.ref;
    const callModel = vi.fn(async () => JSON.stringify({
      facts: [], changes: [],
      conflicts: [{ ref: refOld, quote: "茶馆门口的两张竹桌不见了。", note: "第3章说门口支着两张竹桌" }],
      newCharacters: [],
    }));
    const proposal = await proposeFactChanges({ projectDir: dir, chapter: 9, draftText: draft, callModel, knownNames: V2_NAMES });
    expect(proposal.conflicts).toHaveLength(1);
  });
});

describe("作者自己写的章（没有章纲、不知道第几天）", () => {
  it("提示词让模型照正文写星期，不许自己换算故事第几天", () => {
    const [system] = buildReconcileMessages("周屿说他周六一早过来。", [], []);
    expect(system.content).toContain("绝不自己换算成「故事第几天」");
    const [withDay] = buildReconcileMessages("周屿说他周六一早过来。", [], [], "本章是故事第 2 天");
    expect(withDay.content).toContain("按【本章日子】");
  });

  it("模型还是编了「故事第 3 天（周六）」→ 只留星期", () => {
    expect(stripInventedStoryDays("周屿在外地出差，故事第3天（周六）一早会去半页书店。")).toBe("周屿在外地出差，周六一早会去半页书店。");
    expect(stripInventedStoryDays("故事第 5 天(周五)之后")).toBe("周五之后");
    expect(stripInventedStoryDays("没有日子的事实")).toBe("没有日子的事实");
  });
});
