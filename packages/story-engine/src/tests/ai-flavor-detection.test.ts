import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AI_FLAVOR_MAX_VIOLATIONS,
  buildAiFlavorReport,
  detectAiFlavorViolations,
  type AiFlavorFrequencyGateRule,
  type AiFlavorPatternRule,
} from "../ai-flavor-detection.js";
import { runFastDraft, type WriterClient } from "../fast-draft-writer.js";
import { createStoryProject } from "../project-store.js";

// AI 腔确定性检测机器（机制进引擎、策略留 UI）：规则全部以数据入参传入，引擎不内置禁词表。
// 语义对齐 UI 原实现 ai-flavor-rules.ts detectAiFlavorRules：模式规则抽整句、同句多命中留最高 severity、
// 频率闸（次数 ≥ minOccurrences 且每千字密度 > maxPerThousandChars）扎堆才报一条。
// 这里规则全部用测试玩具数据（玩具词 忽忽/悠悠 等），证明机器本身题材中立、词表由调用方给。
function patternRule(overrides: Partial<AiFlavorPatternRule> = {}): AiFlavorPatternRule {
  return {
    kind: "pattern",
    id: "shell-pattern",
    label: "壳句式",
    severity: "high",
    pattern: /不是[^，。！？\n]{1,12}，?而是/gu,
    reason: "测试用壳句式",
    suggestedFix: "拆成直述句",
    ...overrides,
  };
}

function gateRule(overrides: Partial<AiFlavorFrequencyGateRule> = {}): AiFlavorFrequencyGateRule {
  return {
    kind: "frequency_gate",
    id: "filler-flood",
    label: "弱化词扎堆",
    severity: "low",
    words: ["忽忽", "悠悠"],
    maxPerThousandChars: 3,
    minOccurrences: 4,
    reason: "测试用弱化词密度过高",
    suggestedFix: "删掉大部分弱化词",
    ...overrides,
  };
}

describe("detectAiFlavorViolations · AI 腔确定性检测（规则数据入参）", () => {
  it("模式规则命中 → 抽整句，text 是草稿子串且 slice(start,end)===text", () => {
    const draft = "他往前走。他不是在逃跑，而是在找一条出路。风很大。";
    const hits = detectAiFlavorViolations(draft, [patternRule()]);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.text).toBe("他不是在逃跑，而是在找一条出路。");
    expect(draft.includes(hits[0]!.text)).toBe(true); // 必须是草稿子串（供下游改写定位）
    expect(draft.slice(hits[0]!.start, hits[0]!.end)).toBe(hits[0]!.text);
    expect(hits[0]?.severity).toBe("high");
    expect(hits[0]?.ruleId).toBe("shell-pattern");
    expect(hits[0]?.reason).toBe("壳句式：测试用壳句式");
    expect(hits[0]?.suggestedFix).toBe("拆成直述句");
  });

  it("同一整句被多条规则命中 → 只报一条、取最高 severity（与规则传入顺序无关）", () => {
    const medium = patternRule({ id: "face-cliche", label: "表情套路", severity: "medium", pattern: /眼中闪过/gu });
    const low = patternRule({ id: "hedge-word", label: "情态词", severity: "low", pattern: /一丝/gu });
    const draft = "他眼中闪过一丝光。";
    for (const rules of [[low, medium], [medium, low]] as const) {
      const hits = detectAiFlavorViolations(draft, rules);
      expect(hits).toHaveLength(1);
      expect(hits[0]?.severity).toBe("medium");
      expect(hits[0]?.ruleId).toBe("face-cliche");
    }
  });

  it("返回按 severity 高→低排序；同级保持草稿中出现顺序；id 形如 aiflavor-rule-{ruleId}-{序号}", () => {
    const low = patternRule({ id: "hedge", label: "情态词", severity: "low", pattern: /一丝/gu });
    const medium = patternRule({ id: "sudden", label: "突兀转折", severity: "medium", pattern: /忽然/gu });
    const high = patternRule();
    const draft = "他有一丝犹豫。他不是逃，而是等。她忽然笑了。她又多了一丝恍惚。";
    const hits = detectAiFlavorViolations(draft, [low, medium, high]);
    expect(hits.map((h) => h.severity)).toEqual(["high", "medium", "low", "low"]);
    expect(hits[3]?.text).toBe("她又多了一丝恍惚。"); // 同级 low 里先出现的排前
    // id 序号在整句去重阶段（草稿出现序）分配，排序不重排——与 UI 原实现一致。
    expect(hits.map((h) => h.id)).toEqual([
      "aiflavor-rule-shell-pattern-3",
      "aiflavor-rule-sudden-2",
      "aiflavor-rule-hedge-0",
      "aiflavor-rule-hedge-1",
    ]);
    const report = buildAiFlavorReport(hits);
    expect(report.total).toBe(4);
    expect(report.bySeverity).toEqual({ high: 1, medium: 1, low: 2 });
    expect(report.violations).toHaveLength(4); // 未超 cap 不截
  });

  it("频率闸：次数与密度都达标 → 报一条（id 无序号后缀），挂在第一处含弱化词的整句", () => {
    const draft = "他忽忽起身，悠悠抬头，忽忽叹气，悠悠一笑。";
    const hits = detectAiFlavorViolations(draft, [gateRule()]);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.id).toBe("aiflavor-rule-filler-flood");
    expect(hits[0]?.ruleId).toBe("filler-flood");
    expect(hits[0]?.severity).toBe("low");
    expect(hits[0]?.text).toBe("他忽忽起身，悠悠抬头，忽忽叹气，悠悠一笑。");
    expect(draft.slice(hits[0]!.start, hits[0]!.end)).toBe(hits[0]!.text);
  });

  it("频率闸：次数不够（3 次 < minOccurrences 4）→ 不报", () => {
    const draft = "他忽忽起身，悠悠抬头，忽忽叹气。";
    expect(detectAiFlavorViolations(draft, [gateRule()])).toHaveLength(0);
  });

  it("频率闸：次数够但密度被长正文稀释（每千字 ≤ 阈值）→ 不报", () => {
    const head = "他忽忽起身，悠悠抬头，忽忽叹气，悠悠一笑。";
    const tail = "他想着白天发生的事，越想越觉得不对劲，索性披上外套出了门。".repeat(50);
    const draft = head + tail;
    expect(draft.length).toBeGreaterThan(1333); // 4 次 / 1333+ 字 → 每千字 ≤ 3
    expect(detectAiFlavorViolations(draft, [gateRule()])).toHaveLength(0);
  });

  it("频率闸守「同句只报一条」：挂在第一处还没被模式规则命中的整句上", () => {
    const pattern = patternRule({ id: "face-cliche", label: "表情套路", severity: "medium", pattern: /眼中闪过/gu });
    const draft = "他忽忽地眼中闪过光。他悠悠走来，忽忽坐下，悠悠叹气。";
    const hits = detectAiFlavorViolations(draft, [pattern, gateRule()]);
    expect(hits).toHaveLength(2);
    const gate = hits.find((h) => h.ruleId === "filler-flood");
    expect(gate?.text).toBe("他悠悠走来，忽忽坐下，悠悠叹气。"); // 第一句已被模式规则占用 → 挂第二句
  });

  it("频率闸：弱化词全落在已被模式规则命中的句子里 → 不再重复报", () => {
    const pattern = patternRule({ id: "face-cliche", label: "表情套路", severity: "medium", pattern: /眼中闪过/gu });
    const draft = "他忽忽起身，悠悠抬头，眼中闪过光，忽忽坐下，悠悠叹气。"; // 一整句，4 个弱化词全在里面
    const hits = detectAiFlavorViolations(draft, [pattern, gateRule()]);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.ruleId).toBe("face-cliche");
  });

  it("空规则 / 空文本 / 无命中 / 空词表 → 空结果", () => {
    expect(detectAiFlavorViolations("他不是在逃，而是等。", [])).toEqual([]);
    expect(detectAiFlavorViolations("   ", [patternRule()])).toEqual([]);
    expect(detectAiFlavorViolations("他起身走到窗边，外面下着雨。", [patternRule()])).toEqual([]);
    expect(detectAiFlavorViolations("忽忽忽忽悠悠悠悠。", [gateRule({ words: [] })])).toEqual([]);
  });

  it("模式规则正则缺 g 旗标 → 自动补 g，多处命中都能抓到", () => {
    const rule = patternRule({ pattern: /不是[^，。！？\n]{1,12}，?而是/u });
    const hits = detectAiFlavorViolations("他不是逃，而是等。她不是哭，而是笑。", [rule]);
    expect(hits).toHaveLength(2);
  });

  it("频率闸词表按字面量匹配：正则元字符不生效", () => {
    const draft = "先写 a.b 再写 axb 最后 a.b。";
    // 字面量 a.b 出现 2 次（< 3）→ 不报；若 . 被当正则元字符，axb 也算 → 3 次会报。
    expect(detectAiFlavorViolations(draft, [gateRule({ words: ["a.b"], minOccurrences: 3, maxPerThousandChars: 0 })])).toEqual([]);
    // 对照：minOccurrences 2 → 字面量 2 次达标 → 报一条。
    const hits = detectAiFlavorViolations(draft, [gateRule({ words: ["a.b"], minOccurrences: 2, maxPerThousandChars: 0 })]);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.text).toContain("a.b");
  });

  it("零宽正则命中 → 跳过不抽句、不死循环", () => {
    const rule = patternRule({ pattern: /(?=她)/gu });
    expect(detectAiFlavorViolations("她来了。她走了。", [rule])).toEqual([]);
  });

  it("buildAiFlavorReport：total/bySeverity 统计全量，violations 截到 8 条（对齐 UI cap）", () => {
    const draft = Array.from({ length: 10 }, (_, i) => `第${i}回他不是逃，而是等。`).join("");
    const hits = detectAiFlavorViolations(draft, [patternRule()]);
    expect(hits).toHaveLength(10);
    const report = buildAiFlavorReport(hits);
    expect(AI_FLAVOR_MAX_VIOLATIONS).toBe(8);
    expect(report.total).toBe(10);
    expect(report.bySeverity).toEqual({ high: 10, medium: 0, low: 0 });
    expect(report.violations).toHaveLength(8);
    expect(report.violations[0]?.text).toBe(hits[0]?.text); // cap 保留排序后前 8 条
  });
});

describe("runFastDraft · aiFlavorRules 回检挂接（warning-only）", () => {
  it("不传 aiFlavorRules → 报告无 aiFlavor 字段（旧调用方零行为变化）", async () => {
    const projectDir = await createFixtureProject();
    const writerClient: WriterClient = {
      generateDraft: vi.fn(async () => ({
        title: "无回检",
        content: "顾言不是在逃跑，而是在找一条出路。风很大。",
      })),
    };

    const report = await runFastDraft({
      projectDir,
      chapter: 1,
      chapterGoal: "测试不传规则的向后兼容。",
      writerClient,
    });

    expect(report.passed).toBe(true);
    expect(report.aiFlavor).toBeUndefined();
    expect("aiFlavor" in report).toBe(false);
  });

  it("空规则数组 → 等同不传，报告无 aiFlavor 字段", async () => {
    const projectDir = await createFixtureProject();
    const writerClient: WriterClient = {
      generateDraft: vi.fn(async () => ({
        title: "空规则",
        content: "顾言起身走到窗边，外面下着雨。",
      })),
    };

    const report = await runFastDraft({
      projectDir,
      chapter: 1,
      chapterGoal: "测试空规则数组。",
      writerClient,
      aiFlavorRules: [],
    });

    expect(report.passed).toBe(true);
    expect(report.aiFlavor).toBeUndefined();
  });

  it("传规则且命中 → aiFlavor diagnostics 出现，passed 不受影响、草稿照写（warning-only）", async () => {
    const projectDir = await createFixtureProject();
    const writerClient: WriterClient = {
      generateDraft: vi.fn(async () => ({
        title: "回检命中",
        content: "顾言不是在逃跑，而是在找一条出路。风很大。",
      })),
    };

    const report = await runFastDraft({
      projectDir,
      chapter: 1,
      chapterGoal: "测试 AI 腔回检。",
      writerClient,
      aiFlavorRules: [patternRule()],
    });

    expect(report.passed).toBe(true); // high severity 命中也不拦稿、不进 issues、不触发重试
    expect(report.issues).toEqual([]);
    expect(report.draftPath).toBeDefined();
    expect(report.aiFlavor).toBeDefined();
    expect(report.aiFlavor?.total).toBe(1);
    expect(report.aiFlavor?.bySeverity).toEqual({ high: 1, medium: 0, low: 0 });
    expect(report.aiFlavor?.violations).toHaveLength(1);
    expect(report.aiFlavor?.violations[0]?.text).toBe("顾言不是在逃跑，而是在找一条出路。");
    expect(report.aiFlavor?.violations[0]?.ruleId).toBe("shell-pattern");
  });

  it("传规则但正文干净 → aiFlavor 出现、total 0（如实回报无命中）", async () => {
    const projectDir = await createFixtureProject();
    const writerClient: WriterClient = {
      generateDraft: vi.fn(async () => ({
        title: "干净稿",
        content: "顾言翻身下床，光脚踩在地板上走了两步，腰背有点酸。",
      })),
    };

    const report = await runFastDraft({
      projectDir,
      chapter: 1,
      chapterGoal: "测试干净正文。",
      writerClient,
      aiFlavorRules: [patternRule()],
    });

    expect(report.passed).toBe(true);
    expect(report.aiFlavor).toEqual({ total: 0, bySeverity: { high: 0, medium: 0, low: 0 }, violations: [] });
  });
});

async function createFixtureProject(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "story-engine-ai-flavor-"));
  const { projectDir } = await createStoryProject({
    rootDir,
    title: "回检测试书",
    genre: "悬疑",
    premise: "测试 AI 腔回检挂接。",
    mainCharacterName: "顾言",
  });
  return projectDir;
}
