// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { FactEntry } from "../book/types.js";
import { selectEffectiveFacts } from "./fact-selection.js";

function fact(partial: Partial<FactEntry> & { id: string; chapter: number; text: string }): FactEntry {
  return { source: "auto", ...partial };
}

describe("selectEffectiveFacts", () => {
  it("旧账本无区间字段 → 全部视为有效（向后兼容）", () => {
    const facts = [
      fact({ id: "f1", chapter: 1, text: "甲" }),
      fact({ id: "f2", chapter: 2, text: "乙" }),
    ];
    const out = selectEffectiveFacts({ facts, chapter: 10, cap: 20 });
    // 顺序=重要性（相关性同级时近章在前）；两条都保留
    expect(out.facts).toEqual(["第2章：乙", "第1章：甲"]);
    expect(out.diagnostics).toMatchObject({ total: 2, valid: 2, superseded: 0, notYetEffective: 0, cappedOut: 0 });
  });

  it("尚未生效（effectiveFromChapter > 本章）→ 排除", () => {
    const facts = [fact({ id: "f1", chapter: 5, text: "未来事", effectiveFromChapter: 50 })];
    const out = selectEffectiveFacts({ facts, chapter: 10 });
    expect(out.facts).toEqual([]);
    expect(out.diagnostics).toMatchObject({ valid: 0, notYetEffective: 1 });
  });

  it("已被取代（supersededByChapter <= 本章）→ 排除；取代前仍有效", () => {
    const frozen = fact({ id: "f1", chapter: 7, text: "资金冻结不能动", supersededByChapter: 42 });
    expect(selectEffectiveFacts({ facts: [frozen], chapter: 30 }).facts).toEqual(["第7章：资金冻结不能动"]); // 取代前
    const out = selectEffectiveFacts({ facts: [frozen], chapter: 180 });
    expect(out.facts).toEqual([]); // 取代后
    expect(out.diagnostics).toMatchObject({ superseded: 1 });
  });

  it("根治：早期但相关的有效事实在 180 章不被 cap 挤出（相关性优先于 recency）", () => {
    const facts: FactEntry[] = [
      fact({ id: "early", chapter: 7, text: "林远的钱在境外信托不能动" }), // 早、提到在场角色林远
      ...Array.from({ length: 50 }, (_, i) =>
        fact({ id: `r${i}`, chapter: 100 + i, text: `无关近期事${i}` }), // 晚、不相关
      ),
    ];
    const out = selectEffectiveFacts({ facts, chapter: 180, relevantNames: ["林远"], cap: 3 });
    expect(out.facts).toContain("第7章：林远的钱在境外信托不能动"); // 早期相关事实仍进
    expect(out.facts.length).toBe(3);
    expect(out.diagnostics.cappedOut).toBeGreaterThan(0); // 有被 cap 掉的、如实记
  });

  it("相关性同级时按 recency（近章优先）", () => {
    const facts = [
      fact({ id: "a", chapter: 3, text: "近期A" }),
      fact({ id: "b", chapter: 9, text: "近期B" }),
    ];
    const out = selectEffectiveFacts({ facts, chapter: 10, cap: 1 });
    expect(out.facts).toEqual(["第9章：近期B"]);
  });

  it("过滤空文本，不崩", () => {
    const facts = [fact({ id: "f1", chapter: 1, text: "   " }), fact({ id: "f2", chapter: 2, text: "实" })];
    expect(selectEffectiveFacts({ facts, chapter: 5 }).facts).toEqual(["第2章：实"]);
  });

  // 收口洞#9：相关性原本只认"含在场角色名"，不含人名的硬设定(遗产3亿/密道在城西)relevance 恒=0
  // 被 recency 挤出——Phase 2a 想根治的"早期硬设定蒸发"换形式留下。补：方向(chapterGoal)文本相关 + 硬 token 加权。
  it("根治洞#9：不含人名但与本章方向相关的早期硬设定不被挤出（chapterGoal 文本相关性）", () => {
    const facts: FactEntry[] = [
      fact({ id: "estate", chapter: 5, text: "遗产总额三亿、存在境外信托不可动" }), // 无人名，方向相关(遗产)+硬token(亿)
      ...Array.from({ length: 50 }, (_, i) =>
        fact({ id: `n${i}`, chapter: 100 + i, text: "城北街市照常开张人来人往" }), // 晚、无人名、无方向重叠、无数字 → 分 0
      ),
    ];
    const out = selectEffectiveFacts({ facts, chapter: 180, chapterGoal: "本章主角争夺遗产的归属", relevantNames: [], cap: 3 });
    expect(out.facts).toContain("第5章：遗产总额三亿、存在境外信托不可动");
    expect(out.facts.length).toBe(3);
  });

  it("根治洞#9：含数字/金额的硬事实比同章普通事实优先（hardToken 加权）", () => {
    const facts = [
      fact({ id: "soft", chapter: 7, text: "走廊里很安静没什么人" }), // 同章、无数字 → 分 0
      fact({ id: "hard", chapter: 7, text: "密室保险柜里有两千万现金" }), // 同章、含万 → +1
    ];
    const out = selectEffectiveFacts({ facts, chapter: 10, cap: 1 });
    expect(out.facts).toEqual(["第7章：密室保险柜里有两千万现金"]);
  });

  it("角色名命中仍最高优先（4 > 方向 2 > 硬 token 1）", () => {
    const facts = [
      fact({ id: "goalonly", chapter: 9, text: "遗产分配有争议尚未定" }), // 方向 +2，晚
      fact({ id: "named", chapter: 3, text: "林远背着一笔旧债" }), // 人名 +4，早
    ];
    const out = selectEffectiveFacts({ facts, chapter: 20, chapterGoal: "本章处理遗产", relevantNames: ["林远"], cap: 2 });
    expect(out.facts[0]).toBe("第3章：林远背着一笔旧债"); // 人名压过方向+recency
  });

  // 2026-10-08 十章验收：主角名出现在一半以上事实里，+4 让排序退化成「最近 N 条」；
  // 三章前「菜场十年前就拆了」这类不带人名的事实再也翻不出来，第 8 章就写成了「菜场还在」。
  it("人人都带的主角名降权 + 上一章原文里的特有词把早期相关事实翻出来", () => {
    const facts: FactEntry[] = [
      fact({ id: "market", chapter: 4, text: "南门菜场十年前就拆了，原址盖了商场" }),
      ...Array.from({ length: 20 }, (_, i) =>
        fact({ id: `p${i}`, chapter: 5 + Math.floor(i / 4), text: `林舟在铺子里修表第${["一", "二", "三", "四", "五"][i % 5]}回，台灯亮着` }),
      ),
    ];
    const out = selectEffectiveFacts({
      facts,
      chapter: 8,
      relevantNames: ["林舟"],
      continuityText: "林舟把登记表折好塞进口袋，决定明天一早骑车去南门菜场后街看看。",
      cap: 5,
    });
    expect(out.facts[0]).toBe("第4章：南门菜场十年前就拆了，原址盖了商场");
  });

  it("事实不多时不判「人人都带」：名字仍 4 分；上一章正写到的物件/地点（多个特有词）排得更前", () => {
    const facts = [
      fact({ id: "named", chapter: 2, text: "林舟背着一笔旧债" }),
      fact({ id: "ctx", chapter: 3, text: "南门菜场十年前就拆了" }),
      fact({ id: "noise", chapter: 4, text: "天气转凉了" }),
    ];
    const out = selectEffectiveFacts({ facts, chapter: 5, relevantNames: ["林舟"], continuityText: "去南门菜场", cap: 2 });
    expect(out.facts).toEqual(["第3章：南门菜场十年前就拆了", "第2章：林舟背着一笔旧债"]);
  });

  it("没有上一章原文时与旧行为一致", () => {
    const facts = [fact({ id: "a", chapter: 3, text: "近期A" }), fact({ id: "b", chapter: 9, text: "近期B" })];
    expect(selectEffectiveFacts({ facts, chapter: 10, cap: 1, continuityText: "" }).facts).toEqual(["第9章：近期B"]);
  });

  it("小卡司里条条带配角名时，上一章正写到的物件的旧事实也有保底名额", () => {
    const names = ["许棠", "周婶", "林溪", "老赵"];
    const facts: FactEntry[] = [
      fact({ id: "ledger", chapter: 2, text: "登记表上的地址是南门槐树巷十七号" }),
      ...Array.from({ length: 40 }, (_, i) =>
        fact({ id: `c${i}`, chapter: 3 + (i % 5), text: `${names[i % 4]}第${i}次来铺子里坐了一会儿` }),
      ),
    ];
    const out = selectEffectiveFacts({
      facts,
      chapter: 9,
      relevantNames: names,
      continuityText: "他又把登记表摊开，盯着槐树巷那一行看了很久。",
      cap: 10,
    });
    expect(out.facts).toContain("第2章：登记表上的地址是南门槐树巷十七号");
    expect(out.facts).toHaveLength(10);
  });

  it("章纲点名的地点/物件把不在上一章原文里的旧事实也翻出来（主角名不算检索词）", () => {
    const facts: FactEntry[] = [
      fact({ id: "market", chapter: 4, text: "南门菜场十年前就拆了，原址盖了商场" }),
      ...Array.from({ length: 20 }, (_, i) => fact({ id: `p${i}`, chapter: 5 + (i % 3), text: `林舟和周婶第${i}回说起拆迁补偿` })),
    ];
    const out = selectEffectiveFacts({
      facts,
      chapter: 8,
      relevantNames: ["林舟", "周婶"],
      continuityText: "他躺下，听着挂钟一下一下地走。",
      retrievalTerms: ["南门菜场", "林舟"],
      cap: 3,
    });
    expect(out.facts[0]).toBe("第4章：南门菜场十年前就拆了，原址盖了商场");
  });
});
