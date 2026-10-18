// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  resolveCurrentGoal,
  resolveMentalState,
  resolveIdentity,
  resolveCurrentLocation,
  dedupeAppearanceAnchors,
  normalizeForDedup,
  dedupeStringList,
  resolveCharacterRole,
  resolveTrust,
} from "./canonical-resolvers.js";

describe("resolveCurrentGoal", () => {
  it("优先 currentGoal", () => {
    expect(resolveCurrentGoal({ currentGoal: "夺回家产", goal: "活下去" })).toBe("夺回家产");
  });
  it("缺 currentGoal 用 goal", () => {
    expect(resolveCurrentGoal({ goal: "活下去" })).toBe("活下去");
  });
  it("都缺 → undefined", () => {
    expect(resolveCurrentGoal({})).toBeUndefined();
    expect(resolveCurrentGoal(undefined)).toBeUndefined();
  });
});

describe("resolveMentalState", () => {
  it("三级优先 currentMentalState > mood > emotion", () => {
    expect(resolveMentalState({ currentMentalState: "决绝", mood: "焦虑", emotion: "怒" })).toBe("决绝");
    expect(resolveMentalState({ mood: "焦虑", emotion: "怒" })).toBe("焦虑");
    expect(resolveMentalState({ emotion: "怒" })).toBe("怒");
  });
  it("全缺 → undefined", () => {
    expect(resolveMentalState({})).toBeUndefined();
    expect(resolveMentalState(undefined)).toBeUndefined();
  });
});

describe("resolveIdentity", () => {
  it("bible 静态定义优先（curated 权威，runtime 可能滞后）", () => {
    expect(resolveIdentity({ bibleIdentity: "集团CEO", runtimeIdentity: "现任董事长" })).toBe("集团CEO");
  });
  it("缺 bible 用 runtime", () => {
    expect(resolveIdentity({ runtimeIdentity: "现任董事长" })).toBe("现任董事长");
  });
  it("都缺 → undefined", () => {
    expect(resolveIdentity({})).toBeUndefined();
    expect(resolveIdentity(undefined)).toBeUndefined();
  });
});

describe("resolveCurrentLocation", () => {
  it("runtime 位置优先", () => {
    expect(resolveCurrentLocation({ runtimeLocationName: "顶楼办公室", timelineLocation: "停车场" })).toBe("顶楼办公室");
  });
  it("缺 runtime 用 timeline 派生", () => {
    expect(resolveCurrentLocation({ timelineLocation: "停车场" })).toBe("停车场");
  });
  it("都缺 → undefined", () => {
    expect(resolveCurrentLocation({})).toBeUndefined();
  });
});

describe("dedupeAppearanceAnchors", () => {
  it("多源合并 + 去重（保序）", () => {
    expect(dedupeAppearanceAnchors(["身高175", "戴眼镜"], ["戴眼镜", "左手疤"])).toEqual([
      "身高175",
      "戴眼镜",
      "左手疤",
    ]);
  });
  it("跳过 undefined 源", () => {
    expect(dedupeAppearanceAnchors(undefined, ["A"], undefined)).toEqual(["A"]);
  });
  it("空 → []", () => {
    expect(dedupeAppearanceAnchors()).toEqual([]);
    expect(dedupeAppearanceAnchors(undefined)).toEqual([]);
  });

  // E1 升级：读侧也走 dedupeStringList（空白折叠 + 前缀含纳）。真书陈雨薇式后缀重复必须折叠，
  // 否则下游 generate_draft 读到矛盾脏卡。守 #357：子串/后缀不并。
  it("折叠真书式后缀重复（前缀含纳，留更长一条）", () => {
    expect(dedupeAppearanceAnchors(
      ["穿着米色风衣，风衣下摆有块深色污渍"],
      ["穿着米色风衣，风衣下摆有块深色污渍——像是匆忙中蹭上的"],
    )).toEqual(["穿着米色风衣，风衣下摆有块深色污渍——像是匆忙中蹭上的"]);
  });
  it("守 #357：账本/账目（后缀关系）都保留", () => {
    expect(dedupeAppearanceAnchors(["账本"], ["账目"])).toEqual(["账本", "账目"]);
  });
});

describe("normalizeForDedup（去重归一：连续空白折叠为单空格 + trim，零有损）", () => {
  it("连续/各类空白折叠为单个 ASCII 空格", () => {
    expect(normalizeForDedup("他  怕  水")).toBe("他 怕 水");
    expect(normalizeForDedup("他\t怕\n水")).toBe("他 怕 水");
    expect(normalizeForDedup("他　怕　水")).toBe("他 怕 水"); // 全角空格 U+3000
  });
  it("trim 首尾空白", () => {
    expect(normalizeForDedup("  左手有疤  ")).toBe("左手有疤");
  });
  it("不删全部空白（防英文分词过度合并）", () => {
    expect(normalizeForDedup("dark room")).toBe("dark room");
  });
  it("不转小写、不去标点（题材中立、零有损）", () => {
    expect(normalizeForDedup("ABC，。")).toBe("ABC，。");
  });
});

describe("dedupeStringList（空白折叠 + 前缀含纳；保序、留更长、零文本损失）", () => {
  it("折叠仅差内部空白数量的重复，留首个出现的原串（只去重、不重排内部空白）", () => {
    expect(dedupeStringList(["他 怕 水", "他  怕  水"])).toEqual(["他 怕 水"]);
  });
  it("折叠仅差首尾空白的重复（trim 外缘）", () => {
    expect(dedupeStringList(["左手有疤 ", "左手有疤"])).toEqual(["左手有疤"]);
  });
  it("前缀含纳：A 是 B 前缀且边界处标点 → 丢 A 留更长 B（真书陈雨薇后缀重复）", () => {
    expect(dedupeStringList([
      "穿着米色风衣，风衣下摆有块深色污渍",
      "穿着米色风衣，风衣下摆有块深色污渍——像是匆忙中蹭上的",
    ])).toEqual(["穿着米色风衣，风衣下摆有块深色污渍——像是匆忙中蹭上的"]);
    expect(dedupeStringList([
      "指甲修剪整齐，涂着裸粉色指甲油",
      "指甲修剪整齐，涂着裸粉色指甲油，但食指指甲油有剥落",
    ])).toEqual(["指甲修剪整齐，涂着裸粉色指甲油，但食指指甲油有剥落"]);
  });
  it("前缀含纳与顺序无关：更长的在前也只留更长", () => {
    expect(dedupeStringList([
      "指甲修剪整齐，涂着裸粉色指甲油，但食指指甲油有剥落",
      "指甲修剪整齐，涂着裸粉色指甲油",
    ])).toEqual(["指甲修剪整齐，涂着裸粉色指甲油，但食指指甲油有剥落"]);
  });
  it("守 #357：后缀/子串不并（账本≠账目、血痕≠走廊尽头的血痕与碎镜）", () => {
    expect(dedupeStringList(["账本", "账目"])).toEqual(["账本", "账目"]);
    expect(dedupeStringList(["血痕", "走廊尽头的血痕与碎镜"])).toEqual(["血痕", "走廊尽头的血痕与碎镜"]);
  });
  it("守中文续字：前缀后紧跟汉字（非标点/空白）不并（他很高≠他很高兴）", () => {
    expect(dedupeStringList(["他很高", "他很高兴"])).toEqual(["他很高", "他很高兴"]);
  });
  it("不并同义/不同细节（180cm/一米八、父亲的债/邻居的债）", () => {
    expect(dedupeStringList(["180cm", "一米八"])).toEqual(["180cm", "一米八"]);
    expect(dedupeStringList(["对父亲的债务焦虑", "对邻居的债务焦虑"]))
      .toEqual(["对父亲的债务焦虑", "对邻居的债务焦虑"]);
  });
  it("保守不删空白：180cm/180 cm 并存（明确 fail-safe，非空白数量差）", () => {
    expect(dedupeStringList(["180cm", "180 cm"])).toEqual(["180cm", "180 cm"]);
  });
  it("年龄矛盾不臆断（无含纳关系、属语义，E1 保留并存交人判）", () => {
    expect(dedupeStringList(["二十六七岁", "三十出头"])).toEqual(["二十六七岁", "三十出头"]);
  });
  it("空/纯空白项被滤除", () => {
    expect(dedupeStringList(["", "  ", "左手有疤"])).toEqual(["左手有疤"]);
  });
});

describe("resolveCharacterRole（A 类·职能三名合一）", () => {
  it("narrativeRole(叙事岗位)优先", () => {
    expect(resolveCharacterRole({ narrativeRole: "主要障碍方", bibleRole: "配角", roleHint: "候选人物" })).toBe("主要障碍方");
  });
  it("缺 narrativeRole 用 bibleRole", () => {
    expect(resolveCharacterRole({ bibleRole: "配角", roleHint: "候选人物" })).toBe("配角");
  });
  it("只有 roleHint", () => {
    expect(resolveCharacterRole({ roleHint: "候选人物" })).toBe("候选人物");
  });
  it("空串/纯空白视作缺失，跳过", () => {
    expect(resolveCharacterRole({ narrativeRole: "   ", bibleRole: "配角" })).toBe("配角");
    expect(resolveCharacterRole({ narrativeRole: "", roleHint: "候选" })).toBe("候选");
  });
  it("全缺 → undefined", () => {
    expect(resolveCharacterRole({})).toBeUndefined();
    expect(resolveCharacterRole(undefined)).toBeUndefined();
  });
});

describe("resolveTrust（B 类·三档权威+派生%）", () => {
  it("三档各自派生百分比", () => {
    expect(resolveTrust("low")).toEqual({ level: "low", percent: 25 });
    expect(resolveTrust("medium")).toEqual({ level: "medium", percent: 55 });
    expect(resolveTrust("high")).toEqual({ level: "high", percent: 85 });
  });
  it("undefined → undefined（无信任信息）", () => {
    expect(resolveTrust(undefined)).toBeUndefined();
  });
});
