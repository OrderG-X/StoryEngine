import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  buildWritingRulesEnrichmentMessages,
  generateWritingRulesEnrichment,
  hasWritingRulesContext,
  mergeWritingRulesEnrichmentIntoEngine,
  parseWritingRulesEnrichment,
  summarizeWritingRulesEnrichment,
  writingRulesEnrichmentSchema,
  type WritingRulesContextInput,
} from "./writing-rules-enrichment.js";

// 用 zod 输入类型：default 字段（fingerprints/antiRules）输入侧可省。
const VALID: z.input<typeof writingRulesEnrichmentSchema> = {
  fingerprints: [
    { label: "奢靡物质铺陈", value: 88 },
    { label: "短句快节奏", value: 72 },
  ],
  antiRules: [
    { name: "禁排比抒情", desc: "连续三个以上结构相同的排比句是典型 AI 味，改成具体细节。", type: "forbidden", severity: "high" },
    { name: "少用『不禁』", desc: "『不禁』『忍不住』这类心理副词泛滥是 AI 味，删掉直接写动作。", type: "risk", severity: "medium" },
    { name: "多用感官锚点", desc: "鼓励每个场景落实到具体的视觉/嗅觉细节，这是反 AI 味的好习惯。", type: "encourage", severity: "low" },
  ],
};

const CONTEXT: WritingRulesContextInput = {
  genre: "都市后宫",
  narrativePerspective: "第三人称限知",
  proseStyle: ["奢靡", "物质铺陈", "短句"],
  pacing: "快",
  forbiddenContent: ["排比抒情", "心理副词泛滥"],
  antiAiPatterns: ["不禁", "忍不住"],
};

afterEach(() => vi.restoreAllMocks());

async function tempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "wre-test-"));
}

describe("writing-rules-enrichment 生成与落盘", () => {
  it("buildWritingRulesEnrichmentMessages：含 0-100/枚举/禁脱离风格等约束，user 带本书题材与现有规则", () => {
    const msgs = buildWritingRulesEnrichmentMessages(CONTEXT);
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("反 AI");
    expect(msgs[0].content).toContain("0 到 100");
    expect(msgs[0].content).toContain("forbidden");
    expect(msgs[0].content).toContain("encourage");
    // 禁脱离本书风格凭空发挥。
    expect(msgs[0].content).toContain("别脱离本书风格凭空发挥");
    // user 带入本书真实题材与现有规则。
    expect(msgs[1].content).toContain("都市后宫");
    expect(msgs[1].content).toContain("第三人称限知");
    expect(msgs[1].content).toContain("不禁");
  });

  it("generate：ok + 结构落到 .story-engine-ui/writing-rules-enrichment.json", async () => {
    const dir = await tempProject();
    const callModel = vi.fn(async () => JSON.stringify(VALID));
    const r = await generateWritingRulesEnrichment({ projectDir: dir, context: CONTEXT, callModel });

    expect(r.ok).toBe(true);
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(r.summary).toContain("已替换旧的自动规则");
    const saved = JSON.parse(await readFile(join(dir, ".story-engine-ui", "writing-rules-enrichment.json"), "utf-8"));
    expect(saved.fingerprints).toHaveLength(2);
    expect(saved.fingerprints[0].label).toBe("奢靡物质铺陈");
    expect(saved.fingerprints[0].value).toBe(88);
    expect(saved.antiRules).toHaveLength(3);
    expect(saved.antiRules[0].type).toBe("forbidden");
    expect(saved.antiRules[0].severity).toBe("high");
  });

  it("空写作规则上下文 → ok:false，不调模型", async () => {
    const dir = await tempProject();
    const callModel = vi.fn(async () => JSON.stringify(VALID));
    const r = await generateWritingRulesEnrichment({ projectDir: dir, context: {}, callModel });
    expect(r.ok).toBe(false);
    expect(callModel).not.toHaveBeenCalled();
  });

  it("hasWritingRulesContext：仅题材也算有上下文，全空才没有", () => {
    expect(hasWritingRulesContext({})).toBe(false);
    expect(hasWritingRulesContext({ proseStyle: ["  "] })).toBe(false);
    expect(hasWritingRulesContext({ genre: "都市" })).toBe(true);
    expect(hasWritingRulesContext({ proseStyle: ["奢靡"] })).toBe(true);
  });

  it("parseWritingRulesEnrichment：非 JSON / 非法枚举 / 越界值 → 抛错（绝不放过半成品）", () => {
    expect(() => parseWritingRulesEnrichment("这不是 JSON")).toThrow();
    // type 非法枚举 → 抛错。
    expect(() => parseWritingRulesEnrichment(JSON.stringify({ antiRules: [{ name: "x", type: "bad", severity: "high" }] }))).toThrow();
    // value 越界（>100）→ 抛错。
    expect(() => parseWritingRulesEnrichment(JSON.stringify({ fingerprints: [{ label: "x", value: 120 }] }))).toThrow();
  });

  it("parseWritingRulesEnrichment：能从带前后文的文本里抠出 JSON，并对缺省字段补默认值", () => {
    const wrapped = "好的，结果如下：\n" + JSON.stringify(VALID) + "\n（以上）";
    expect(parseWritingRulesEnrichment(wrapped).fingerprints).toHaveLength(2);
    // 空对象 → 两个 default 字段补全，不抛错。
    const empty = parseWritingRulesEnrichment("{}");
    expect(empty.fingerprints).toEqual([]);
    expect(empty.antiRules).toEqual([]);
  });

  it("并入：antiRules 按 type 进 writing-rules，且不带「反AI·」前缀、条目 ≤40 字", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wre-merge-"));
    await mkdir(join(dir, "story"), { recursive: true });
    await writeFile(join(dir, "story", "writing-rules.json"), JSON.stringify({ version: "v0", proseStyle: [], genreRequirements: [], suspenseRules: [], payoffRules: [], reversalRules: [], readerExperienceRules: [], forbiddenContent: [], doNotDo: [] }), "utf-8");
    const data = writingRulesEnrichmentSchema.parse({ antiRules: [
      { name: "禁排比凑字", desc: "别用排比堆字数", type: "forbidden", severity: "high" },
      { name: "慎用万能比喻", desc: "如同…一般 少用", type: "risk", severity: "medium" },
      { name: "多写动作细节", desc: "用动作带情绪", type: "encourage", severity: "low" },
    ] });
    await mergeWritingRulesEnrichmentIntoEngine(dir, data);
    const wr = JSON.parse(await readFile(join(dir, "story", "writing-rules.json"), "utf-8"));
    expect(wr.forbiddenContent.some((s: string) => s.includes("禁排比凑字") || s.includes("别用排比"))).toBe(true);
    expect(wr.doNotDo.some((s: string) => s.includes("慎用万能比喻") || s.includes("少用"))).toBe(true);
    expect(wr.readerExperienceRules.some((s: string) => s.includes("多写动作细节") || s.includes("用动作带情绪"))).toBe(true);
    const all = [...wr.forbiddenContent, ...wr.doNotDo, ...wr.readerExperienceRules] as string[];
    expect(all.every((s) => !s.startsWith("反AI·"))).toBe(true);
    expect(all.every((s) => s.length <= 40)).toBe(true);
  });

  it("P0-4：二次做厚整组替换，不叠加；摘要声明已替换", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wre-replace-"));
    await mkdir(join(dir, "story"), { recursive: true });
    await writeFile(join(dir, "story", "writing-rules.json"), JSON.stringify({
      version: "v0",
      customNotes: "作者手写：每章开头标时间",
      forbiddenContent: ["禁止视角越界"],
      doNotDo: [],
      readerExperienceRules: [],
    }), "utf-8");
    const first = writingRulesEnrichmentSchema.parse({
      antiRules: [
        { name: "禁止视角越界", desc: "", type: "forbidden", severity: "high" },
        { name: "视角越界禁止", desc: "", type: "forbidden", severity: "high" },
      ],
    });
    await mergeWritingRulesEnrichmentIntoEngine(dir, first);
    const second = writingRulesEnrichmentSchema.parse({
      antiRules: [{ name: "禁排比凑字", desc: "别堆字数", type: "forbidden", severity: "high" }],
    });
    const merge = await mergeWritingRulesEnrichmentIntoEngine(dir, second);
    const wr = JSON.parse(await readFile(join(dir, "story", "writing-rules.json"), "utf-8"));
    expect(wr.customNotes).toBe("作者手写：每章开头标时间");
    expect(wr.forbiddenContent).toEqual(["禁排比凑字：别堆字数"]);
    expect(wr.forbiddenContent).not.toContain("禁止视角越界");
    const summary = summarizeWritingRulesEnrichment(second, merge);
    expect(summary).toContain("已替换旧的自动规则，不会重复叠加");
  });
});

describe("R2 停谎报：写作规则并入诚实回报", () => {
  it("写盘失败时 merge 返回 {merged:false, reason 含失败}", async () => {
    const dir = await tempProject();
    await mkdir(join(dir, "story"), { recursive: true });
    // 把 writing-rules.json 建成目录 → writeFile 抛 EISDIR
    await mkdir(join(dir, "story", "writing-rules.json"), { recursive: true });
    const data = writingRulesEnrichmentSchema.parse(VALID);
    const r = await mergeWritingRulesEnrichmentIntoEngine(dir, data);
    expect(r.merged).toBe(false);
    expect(r.reason ?? "").toContain("失败");
  });

  it("正常并入时 merge 返回 {merged:true}", async () => {
    const dir = await tempProject();
    const data = writingRulesEnrichmentSchema.parse(VALID);
    const r = await mergeWritingRulesEnrichmentIntoEngine(dir, data);
    expect(r.merged).toBe(true);
  });

  it("generate 摘要不再宣称『引擎不变』、且如实提到进正文", async () => {
    const dir = await tempProject();
    const callModel = vi.fn(async () => JSON.stringify(VALID));
    const r = await generateWritingRulesEnrichment({ projectDir: dir, context: CONTEXT, callModel });
    expect(r.ok).toBe(true);
    expect(r.mergedIntoEngine).toBe(true);
    expect(r.summary).not.toContain("引擎不变");
    expect(r.summary).toContain("正文");
  });

  it("写盘失败时 generate 仍 ok:true 但 summary 如实标注未进正文 + mergedIntoEngine:false", async () => {
    const dir = await tempProject();
    await mkdir(join(dir, "story"), { recursive: true });
    await mkdir(join(dir, "story", "writing-rules.json"), { recursive: true });
    const callModel = vi.fn(async () => JSON.stringify(VALID));
    const r = await generateWritingRulesEnrichment({ projectDir: dir, context: CONTEXT, callModel });
    expect(r.ok).toBe(true);             // 展示层已落盘
    expect(r.mergedIntoEngine).toBe(false);
    expect(r.summary).toContain("未能");  // 如实告知未进正文
  });
});
