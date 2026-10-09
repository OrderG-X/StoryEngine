// @vitest-environment node
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readFactLedger } from "./fact-ledger.js";
import { absolutizeRelativeDays, buildReconcileMessages, extractAndReconcileFacts, factSwapsKinshipForName, parseReconcile, pickRelatedFacts } from "./reconcile-facts.js";

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

describe("extractAndReconcileFacts", () => {
  it("新事实入账；明写的变化让旧条失效；对不上的不动账本、交给作者定", async () => {
    const dir = await makeLedger();
    const { facts } = await readFactLedger(dir);
    const related = pickRelatedFacts(facts, 8, DRAFT, ["林舟", "周婶"]);
    const refOf = (id: string) => related.find((item) => item.fact.id === id)!.ref;
    const callModel = vi.fn(async () => JSON.stringify({
      facts: [{ text: "林舟骑车去了南门" }],
      changes: [
        { ref: refOf("fact-4-1"), text: "周婶的座钟已修好送回周婶家", quote: "他想起周婶那座钟昨天已经修好送回去了。" },
        // 没引原句（或引的不在正文里）的「变化」不让旧条失效——防把仍有效的事实误标过期。
        { ref: refOf("fact-4-2"), text: "许棠改了量面积的时间" },
      ],
      conflicts: [
        { ref: refOf("fact-4-0"), quote: "菜场还在，门口摆着几摊卖豆腐的。", note: "第4章说菜场已拆" },
        { ref: refOf("fact-4-0"), quote: "正文里没有这句", note: "幻觉引文" },
      ],
      newCharacters: [],
    }));
    const result = await extractAndReconcileFacts({ projectDir: dir, chapter: 8, draftText: DRAFT, callModel, knownNames: ["林舟", "周婶"] });

    expect(result.ok).toBe(true);
    expect(result.added).toBe(2);
    expect(result.superseded).toEqual(["周婶的座钟停了，放在林舟铺子里等修。"]);
    expect(result.conflicts).toEqual([expect.objectContaining({ quote: "菜场还在，门口摆着几摊卖豆腐的。" })]);
    const after = (await readFactLedger(dir)).facts;
    expect(after.find((fact) => fact.id === "fact-4-1")?.supersededByChapter).toBe(8);
    expect(after.find((fact) => fact.id === "fact-4-0")?.supersededByChapter).toBeUndefined(); // 冲突不动账本
    expect(after.find((fact) => fact.id === "fact-4-2")?.supersededByChapter).toBeUndefined(); // 没有原句为证的「变化」不算
    expect(result.summary).toContain("这章记下 2 条硬事实");
    expect(result.summary).toContain("更新了 1 条旧设定");
    expect(result.summary).toContain("需要你定以哪个为准");
  });

  it("新事实引的原句在正文里找不到 → 不入账（第十四轮：推断出的改期、把交还记成卖给）；抄错一两个字的照收", async () => {
    const dir = await makeLedger();
    const callModel = vi.fn(async () => JSON.stringify({
      facts: [
        { text: "林舟骑车去了南门", quote: "林舟骑车到了南门。" },
        { text: "南门菜场门口有豆腐摊", quote: "菜场还在，门口摆着几摊卖豆腐的摊子。" },
        { text: "周婶把座钟卖给了杂货铺", quote: "周婶把座钟卖给了街口杂货铺" },
        { text: "没给原句的照收" },
      ],
      changes: [], conflicts: [], newCharacters: [],
    }));
    const result = await extractAndReconcileFacts({ projectDir: dir, chapter: 8, draftText: DRAFT, callModel, knownNames: ["林舟", "周婶"] });
    expect(result.added).toBe(3);
    const texts = (await readFactLedger(dir)).facts.map((fact) => fact.text);
    expect(texts).not.toContain("周婶把座钟卖给了杂货铺");
    expect(texts).toContain("南门菜场门口有豆腐摊");
  });

  it("两次都抽不成 → ok:false，账本不动，如实说明", async () => {
    const dir = await makeLedger();
    const callModel = vi.fn(async () => "不是 JSON");
    const result = await extractAndReconcileFacts({ projectDir: dir, chapter: 8, draftText: DRAFT, callModel });
    expect(callModel).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(false);
    expect((await readFactLedger(dir)).facts).toHaveLength(3);
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

describe("absolutizeRelativeDays（第二十一轮账本 30 条留着昨天 / 明天）", () => {
  it("按本章天数换成故事第几天；大前天 / 大后天不被拆错；天数未知原样", () => {
    expect(absolutizeRelativeDays("许棠说明天来量铺子，昨晚有人敲门", 5)).toBe("许棠说故事第6天来量铺子，故事第4天晚上有人敲门");
    expect(absolutizeRelativeDays("大前天送来的表，后天取", 5)).toBe("故事第2天送来的表，故事第7天取");
    expect(absolutizeRelativeDays("前天的事", 1)).toBe("前天的事");
    expect(absolutizeRelativeDays("目前天气转凉，然后天亮了", 5)).toBe("目前天气转凉，然后天亮了");
    expect(absolutizeRelativeDays("明天来", undefined)).toBe("明天来");
    expect(absolutizeRelativeDays("明天（故事第6天）来量", 5)).toBe("故事第6天来量");
  });
});
