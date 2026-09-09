import { describe, expect, it } from "vitest";
import {
  buildStyleExemplarPromptItems,
  normalizeStyleExemplars,
  STYLE_EXEMPLAR_MAX_COUNT,
  STYLE_EXEMPLAR_MAX_TEXT_CHARS,
  STYLE_EXEMPLAR_PROMPT_TEXT_CHARS,
  STYLE_EXEMPLAR_PROMPT_TOTAL_TEXT_CHARS,
} from "../style-exemplars.js";
import type { StyleExemplar } from "../types.js";

function exemplar(partial: Partial<StyleExemplar> & { readonly title: string; readonly text: string }): StyleExemplar {
  return {
    id: partial.id ?? `exemplar-${partial.title}`,
    title: partial.title,
    text: partial.text,
    ...(partial.note ? { note: partial.note } : {}),
    createdAtMs: partial.createdAtMs ?? 1000,
  };
}

describe("normalizeStyleExemplars（防御性归一·坏条目跳过+报告）", () => {
  it("旧书无此字段（undefined/null）→ 空表、无 dropped", () => {
    expect(normalizeStyleExemplars(undefined)).toEqual({ exemplars: [], dropped: [] });
    expect(normalizeStyleExemplars(null)).toEqual({ exemplars: [], dropped: [] });
  });

  it("字段不是数组 → 整段忽略并报告", () => {
    const result = normalizeStyleExemplars("不是数组");
    expect(result.exemplars).toEqual([]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]).toContain("不是数组");
  });

  it("坏条目逐条跳过+报告：非对象 / 缺 title / 缺 text / 超存储上限", () => {
    const result = normalizeStyleExemplars([
      42,
      { id: "x1", text: "有正文没标题" },
      { id: "x2", title: "有标题没正文" },
      { id: "x3", title: "超长", text: "长".repeat(STYLE_EXEMPLAR_MAX_TEXT_CHARS + 1) },
      { id: "ok-1", title: "正常样本", text: "这是正常的样本正文。", note: "开头示范", createdAtMs: 123 },
    ]);
    expect(result.exemplars).toHaveLength(1);
    expect(result.exemplars[0]).toMatchObject({ id: "ok-1", title: "正常样本", text: "这是正常的样本正文。", note: "开头示范", createdAtMs: 123 });
    expect(result.dropped).toHaveLength(4);
    expect(result.dropped.join("\n")).toContain("不是对象");
    expect(result.dropped.join("\n")).toContain("缺 title");
    expect(result.dropped.join("\n")).toContain("缺 text");
    expect(result.dropped.join("\n")).toContain("超过存储上限");
  });

  it(`超过 ${STYLE_EXEMPLAR_MAX_COUNT} 条的合法条目溢出跳过并报告`, () => {
    const entries = Array.from({ length: STYLE_EXEMPLAR_MAX_COUNT + 2 }, (_, i) => ({
      id: `ex-${i}`,
      title: `样本${i + 1}`,
      text: `正文${i + 1}`,
      createdAtMs: i,
    }));
    const result = normalizeStyleExemplars(entries);
    expect(result.exemplars).toHaveLength(STYLE_EXEMPLAR_MAX_COUNT);
    expect(result.exemplars.map((item) => item.title)).toEqual(["样本1", "样本2", "样本3", "样本4", "样本5"]);
    expect(result.dropped).toHaveLength(2);
    expect(result.dropped[0]).toContain("样本6");
    expect(result.dropped[0]).toContain("上限");
  });

  it("缺 id 按内容哈希派生稳定 id；非法 createdAtMs 归零；空白 note 丢弃", () => {
    const raw = [{ title: "无 id 样本", text: "正文", note: "   ", createdAtMs: "不是数字" }];
    const first = normalizeStyleExemplars(raw);
    const second = normalizeStyleExemplars(raw);
    expect(first.exemplars).toHaveLength(1);
    expect(first.exemplars[0]?.id).toMatch(/^exemplar-[0-9a-f]{6}$/u);
    expect(first.exemplars[0]?.id).toBe(second.exemplars[0]?.id); // 确定性：同一输入同一 id
    expect(first.exemplars[0]?.createdAtMs).toBe(0);
    expect(first.exemplars[0]?.note).toBeUndefined();
    expect(first.dropped).toEqual([]);
  });

  it("重复 id 去重加后缀，不静默合并", () => {
    const result = normalizeStyleExemplars([
      { id: "same", title: "样本甲", text: "甲正文", createdAtMs: 1 },
      { id: "same", title: "样本乙", text: "乙正文", createdAtMs: 2 },
    ]);
    expect(result.exemplars).toHaveLength(2);
    expect(result.exemplars[0]?.id).toBe("same");
    expect(result.exemplars[1]?.id).toBe("same-2");
  });
});

describe("buildStyleExemplarPromptItems（注入预算：单条截断 + 总量封顶）", () => {
  it(`单条 text 截断到 ${STYLE_EXEMPLAR_PROMPT_TEXT_CHARS} 字`, () => {
    const items = buildStyleExemplarPromptItems([
      exemplar({ title: "长样本", text: "句".repeat(STYLE_EXEMPLAR_PROMPT_TEXT_CHARS + 200) }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.text).toHaveLength(STYLE_EXEMPLAR_PROMPT_TEXT_CHARS);
    expect(items[0]?.title).toBe("长样本");
  });

  it(`样本区 text 总量封顶 ${STYLE_EXEMPLAR_PROMPT_TOTAL_TEXT_CHARS} 字，预算耗尽的整条不进`, () => {
    const items = buildStyleExemplarPromptItems([
      exemplar({ title: "一", text: "一".repeat(900) }),
      exemplar({ title: "二", text: "二".repeat(900) }),
      exemplar({ title: "三", text: "三".repeat(900) }),
    ]);
    const total = items.reduce((sum, item) => sum + item.text.length, 0);
    expect(total).toBeLessThanOrEqual(STYLE_EXEMPLAR_PROMPT_TOTAL_TEXT_CHARS);
    expect(items.map((item) => item.title)).toEqual(["一", "二"]); // 800 + 800，第三条预算耗尽整条不进
    expect(items[0]?.text).toHaveLength(STYLE_EXEMPLAR_PROMPT_TEXT_CHARS);
    expect(items[1]?.text).toHaveLength(STYLE_EXEMPLAR_PROMPT_TEXT_CHARS);
  });

  it("短样本原样通过、note 随行、顺序保持", () => {
    const items = buildStyleExemplarPromptItems([
      exemplar({ title: "甲", text: "甲的正文", note: "这是开头示范" }),
      exemplar({ title: "乙", text: "乙的正文" }),
    ]);
    expect(items).toEqual([
      { title: "甲", text: "甲的正文", note: "这是开头示范" },
      { title: "乙", text: "乙的正文" },
    ]);
  });

  it("空表 → 空表", () => {
    expect(buildStyleExemplarPromptItems([])).toEqual([]);
  });
});
