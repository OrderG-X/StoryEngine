import { describe, expect, it } from "vitest";
import { detectAiFlavorRules, BUILTIN_AI_FLAVOR_RULES } from "./ai-flavor-rules.js";

describe("detectAiFlavorRules · 确定性去AI味闸", () => {
  it("命中『不是…而是』壳句式(high)，text 是逐字整句", () => {
    const draft = "他往前走。他不是在逃跑，而是在找一条出路。风很大。";
    const v = detectAiFlavorRules(draft);
    const hit = v.find((x) => x.text.includes("而是"));
    expect(hit).toBeTruthy();
    expect(hit?.severity).toBe("high");
    expect(hit?.text).toBe("他不是在逃跑，而是在找一条出路。");
    expect(draft.includes(hit!.text)).toBe(true); // 必须是草稿子串(供改写定位)
  });

  it("不误报『是不是』反问 / 单独『不是吗』", () => {
    const draft = "你是不是傻？这不是吗，明摆着的事。他问她到底来不来。";
    const v = detectAiFlavorRules(draft);
    expect(v.find((x) => x.reason.includes("不是…而是"))).toBeUndefined();
  });

  it("命中解释腔/剧透腔(殊不知/他不知道的是/命运早已)", () => {
    const draft = "他笑着挂了电话。殊不知，这通电话改变了一切。";
    const v = detectAiFlavorRules(draft);
    const hit = v.find((x) => x.reason.includes("解释腔"));
    expect(hit?.severity).toBe("high");
    expect(hit?.text).toContain("殊不知");
  });

  it("命中 AI 表情/心理套路词(眼中闪过/心中一动/嘴角勾起)", () => {
    const draft = "她眼中闪过一丝慌乱。他心中一动，嘴角勾起一抹笑。";
    const v = detectAiFlavorRules(draft);
    expect(v.length).toBeGreaterThanOrEqual(1);
    expect(v.every((x) => draft.includes(x.text))).toBe(true);
  });

  it("同一整句被多词命中 → 只报一条(治噪音)，取最高 severity", () => {
    const draft = "他心中一动，仿佛明白了什么，眼中闪过一丝精光。";
    const v = detectAiFlavorRules(draft);
    // 这一整句里有 心中一动(medium)+仿佛(low)+眼中闪过(medium) → 去重成 1 条、取 medium
    const forThisSentence = v.filter((x) => x.text.includes("心中一动"));
    expect(forThisSentence).toHaveLength(1);
    expect(forThisSentence[0]?.severity).toBe("medium");
  });

  it("干净的人话不误报(空结果)", () => {
    const draft = "林远翻身下床，光脚踩在地毯上走了两步，腰背有点酸。他端起杯子，灌了一口凉水。";
    expect(detectAiFlavorRules(draft)).toHaveLength(0);
  });

  // novel-deslop 吸收：高精度固定短语扩充（情态/判断词、动作套路、万能状语）。
  it("命中 情态/判断 套话扩展(隐约/一抹/不可否认)", () => {
    const draft = "桌上隐约有一抹灰。这一点不可否认。";
    const v = detectAiFlavorRules(draft);
    expect(v.length).toBeGreaterThanOrEqual(1);
    expect(v.every((x) => draft.includes(x.text))).toBe(true);
  });

  it("命中 AI 动作套路『深吸一口气』", () => {
    const draft = "他深吸一口气，压下怒火。门外的脚步停了。";
    const v = detectAiFlavorRules(draft);
    const hit = v.find((x) => x.text.includes("深吸一口气"));
    expect(hit).toBeTruthy();
    expect(draft.includes(hit!.text)).toBe(true);
  });

  it("命中 万能状语『，带着…的』(novel-deslop gate B)", () => {
    const draft = "一个声音在他脑海里炸开，带着颤抖和极力压抑的恐慌。";
    const v = detectAiFlavorRules(draft);
    const hit = v.find((x) => x.text.includes("带着"));
    expect(hit).toBeTruthy();
    expect(draft.includes(hit!.text)).toBe(true);
  });

  // novel-deslop「弱化副词每千字≤3」→ 频率闸：扎堆才报，偶用不报（避免对常用词出现即报的噪音）。
  it("虚弱副词扎堆(缓缓/微微/轻轻/淡淡 超频) → 报一条降频提示", () => {
    const draft = "他缓缓起身，微微抬头，轻轻叹了气，淡淡一笑。";
    const v = detectAiFlavorRules(draft);
    const hit = v.find((x) => x.reason.includes("副词"));
    expect(hit).toBeTruthy();
    expect(draft.includes(hit!.text)).toBe(true);
  });

  it("虚弱副词偶用(长正文里 1 个)不报降频", () => {
    const draft = "他起身走到窗边，看了很久，外面下着雨。他缓缓坐下，点了支烟。" + "他想着白天发生的事，越想越觉得不对劲，索性披上外套出了门。".repeat(20);
    const v = detectAiFlavorRules(draft);
    expect(v.find((x) => x.reason.includes("副词"))).toBeUndefined();
  });

  it("空稿返回空", () => {
    expect(detectAiFlavorRules("   ")).toHaveLength(0);
  });

  it("内置规则集非空、每条带必要字段", () => {
    expect(BUILTIN_AI_FLAVOR_RULES.length).toBeGreaterThanOrEqual(4);
    for (const r of BUILTIN_AI_FLAVOR_RULES) {
      expect(r.id && r.label && r.reason && r.suggestedFix).toBeTruthy();
      expect(r.pattern.flags).toContain("g");
    }
  });
});
