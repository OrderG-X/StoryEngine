import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  blankToUndefined,
  coerceBoolean,
  coerceEnum,
  coerceEnumValues,
  coerceJsonArray,
  coerceJsonObject,
  coerceNumber,
  coerceStringArray,
} from "./lenient-args.js";

/**
 * 复刻 generate_draft 的真实 input 形状（实测 qwen3.7-plus 把全部参数发成字符串）。
 */
const draftLike = z.object({
  chapter: coerceNumber(z.number().int().positive().optional()),
  requestedDraftLength: coerceNumber(z.number().int().positive().optional()),
  maxTimelineEvents: coerceNumber(z.number().int().nonnegative().optional()),
  selectedCharacterIds: coerceStringArray(z.array(z.string()).optional()),
  allowWriteAhead: coerceBoolean(z.boolean().optional()),
});

describe("lenient-args 宽容层（治模型把 tool-call 参数全发成字符串）", () => {
  it("Qwen 真实字符串入参 → 还原成正确类型并通过", () => {
    const r = draftLike.safeParse({
      chapter: "5",
      requestedDraftLength: "3000",
      maxTimelineEvents: "10",
      selectedCharacterIds: "[]",
      allowWriteAhead: "false",
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data).toEqual({
      chapter: 5,
      requestedDraftLength: 3000,
      maxTimelineEvents: 10,
      selectedCharacterIds: [],
      allowWriteAhead: false,
    });
  });

  it("好模型发正确类型 → 逐字节不变照过", () => {
    const r = draftLike.safeParse({
      chapter: 5,
      requestedDraftLength: 3000,
      maxTimelineEvents: 0,
      selectedCharacterIds: ["c1", "c2"],
      allowWriteAhead: true,
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data.selectedCharacterIds).toEqual(["c1", "c2"]);
    expect(r.success && r.data.allowWriteAhead).toBe(true);
  });

  it("空对象（全 optional）可省略", () => {
    expect(draftLike.safeParse({}).success).toBe(true);
  });

  describe("coerceNumber", () => {
    const s = coerceNumber(z.number().int().positive().optional());
    it('"5"→5；5→5；空串→undefined', () => {
      expect(s.parse("5")).toBe(5);
      expect(s.parse(5)).toBe(5);
      expect(s.parse("")).toBeUndefined();
      expect(s.parse("  ")).toBeUndefined();
    });
    it('"abc" 还原不了 → 仍如实拒（不放水）', () => {
      expect(s.safeParse("abc").success).toBe(false);
    });
    it('"0" → 0 → .positive() 仍拒（约束不放宽）', () => {
      expect(s.safeParse("0").success).toBe(false);
    });
  });

  describe("coerceBoolean", () => {
    const s = coerceBoolean(z.boolean().optional());
    it('"true"/"false"/"TRUE" 大小写不敏感', () => {
      expect(s.parse("true")).toBe(true);
      expect(s.parse("false")).toBe(false);
      expect(s.parse("TRUE")).toBe(true);
      expect(s.parse(true)).toBe(true);
      expect(s.parse("")).toBeUndefined();
    });
    // 模型无关：不同模型给布尔的常见退化形态都收（治 suggest_next_steps recommended 整张卡消失）。
    it('常见变体 1/0/yes/no/y/n（字符串与数字）都归一', () => {
      expect(s.parse("1")).toBe(true);
      expect(s.parse("0")).toBe(false);
      expect(s.parse("yes")).toBe(true);
      expect(s.parse("no")).toBe(false);
      expect(s.parse("YES")).toBe(true);
      expect(s.parse("y")).toBe(true);
      expect(s.parse("n")).toBe(false);
      expect(s.parse(1)).toBe(true);
      expect(s.parse(0)).toBe(false);
    });
    it('真还原不了的 "maybe"/数字 2 → 原样 → 由 z.boolean 如实拒（不放水）', () => {
      expect(s.safeParse("maybe").success).toBe(false);
      expect(s.safeParse(2).success).toBe(false);
    });
    // E2E 实锤：模型给 suggest_next_steps 的 recommended 传 null → 旧码 null 穿过 → z.boolean().optional() 拒 null
    // → 用户面一次失败工具块。null 是退化空值，视同缺省（undefined），由 optional 收下。
    it('null → undefined（退化空值视同缺省，不报 validation error）', () => {
      expect(s.parse(null)).toBeUndefined();
      expect(s.safeParse(null).success).toBe(true);
    });
  });

  describe("blankToUndefined（空串/纯空白 → undefined，让下游 ?? 默认 正常兜底）", () => {
    const s = blankToUndefined(z.string().optional());
    it('""/"  " → undefined；非空原样', () => {
      expect(s.parse("")).toBeUndefined();
      expect(s.parse("   ")).toBeUndefined();
      expect(s.parse("悬疑")).toBe("悬疑");
      expect(s.parse(undefined)).toBeUndefined();
    });
    it("不 trim 非空值（保留用户原文前后空格语义由下游决定）", () => {
      expect(s.parse(" 悬疑 ")).toBe(" 悬疑 ");
    });
  });

  describe("coerceEnum（trim + 小写，宽容大小写/空白；空串→undefined）", () => {
    const s = coerceEnum(z.enum(["add", "remove", "supersede"]).optional());
    it('"Add"/" REMOVE "/"supersede" → 小写匹配', () => {
      expect(s.parse("Add")).toBe("add");
      expect(s.parse(" REMOVE ")).toBe("remove");
      expect(s.parse("supersede")).toBe("supersede");
    });
    it('空串/空白 → undefined（交给 optional）', () => {
      expect(s.parse("")).toBeUndefined();
      expect(s.parse("  ")).toBeUndefined();
    });
    it('不在枚举内的 "frobnicate" → 仍如实拒（不放水）', () => {
      expect(s.safeParse("frobnicate").success).toBe(false);
    });
  });

  describe("coerceStringArray", () => {
    const s = coerceStringArray(z.array(z.string()).optional());
    it('""/"[]"→[]；JSON 串→解析；逗号串→切分', () => {
      expect(s.parse("")).toEqual([]);
      expect(s.parse("[]")).toEqual([]);
      expect(s.parse('["a","b"]')).toEqual(["a", "b"]);
      expect(s.parse("a, b，c")).toEqual(["a", "b", "c"]);
      expect(s.parse(["x"])).toEqual(["x"]);
    });
  });

  describe("coerceJsonArray（对象数组，如 choices）", () => {
    const choice = z.object({ label: z.string(), recommended: coerceBoolean(z.boolean().optional()) });
    const s = coerceJsonArray(z.array(choice).min(1));
    it("整块对象数组被序列化成字符串 → 解析还原（含嵌套 bool 串）", () => {
      const r = s.safeParse('[{"label":"写第二章","recommended":"true"}]');
      expect(r.success).toBe(true);
      expect(r.success && r.data[0]).toEqual({ label: "写第二章", recommended: true });
    });
    it("本来就是数组 → 照过", () => {
      expect(s.safeParse([{ label: "x" }]).success).toBe(true);
    });
  });

  describe("coerceJsonObject（如 foundation_write.after）", () => {
    const s = coerceJsonObject(z.record(z.string(), z.unknown()));
    it("对象被序列化成字符串 → 解析还原", () => {
      const r = s.safeParse('{"core":"千亿富豪","goal":"买车"}');
      expect(r.success).toBe(true);
      expect(r.success && r.data).toEqual({ core: "千亿富豪", goal: "买车" });
    });
    it("本来就是对象 → 照过", () => {
      expect(s.safeParse({ core: "x" }).success).toBe(true);
    });
  });

  it("toJSONSchema：模型看到的 schema 仍是正确类型 + 保留 optional（required 不含它）", () => {
    const js = z.toJSONSchema(draftLike) as {
      properties: Record<string, { type?: string }>;
      required?: string[];
    };
    expect(js.properties.chapter?.type).toBe("integer");
    expect(js.properties.allowWriteAhead?.type).toBe("boolean");
    expect(js.properties.selectedCharacterIds?.type).toBe("array");
    expect(js.required ?? []).not.toContain("chapter");
  });

  describe("coerceEnumValues（camelCase 枚举大小写不敏感 → 归一回 canonical，如 category）", () => {
    const CATS = ["characters", "characterRelationships", "writingRules", "world"] as const;
    const s = coerceEnumValues(CATS, z.enum(CATS).optional());
    it('"WritingRules"/"writingrules"/" CharacterRelationships " → 归一回 canonical 大小写', () => {
      expect(s.parse("WritingRules")).toBe("writingRules");
      expect(s.parse("writingrules")).toBe("writingRules");
      expect(s.parse(" CharacterRelationships ")).toBe("characterRelationships");
      expect(s.parse("WORLD")).toBe("world");
    });
    it('空串→undefined；不在枚举内 → 如实拒', () => {
      expect(s.parse("")).toBeUndefined();
      expect(s.safeParse("bogus").success).toBe(false);
    });
  });

  it("coerceEnum 的 JSONSchema 仍暴露枚举选项（模型看得到合法值）", () => {
    const schema = z.object({ op: coerceEnum(z.enum(["add", "remove", "supersede"])) });
    const js = z.toJSONSchema(schema) as { properties: Record<string, { enum?: readonly string[] }> };
    expect(js.properties.op?.enum).toEqual(["add", "remove", "supersede"]);
  });
});
