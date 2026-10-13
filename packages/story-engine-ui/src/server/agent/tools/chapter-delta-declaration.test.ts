// @vitest-environment node
//
// chapter-delta-declaration 确定性契约层单测：字段说明题材中立、JSON 解析健壮（逐条打捞，坏条目只丢那一条）。
// R3 删旧声明调用后这里只剩纯函数；声明编排（记账员）见 brain/ledger.test.ts。
import { describe, expect, it } from "vitest";

import { buildChapterDeltaContextSections, buildChapterDeltaSystemSpec, parseChapterDeltaDeclaration } from "./chapter-delta-declaration.js";

describe("buildChapterDeltaSystemSpec / ContextSections", () => {
  it("字段说明题材中立、要求逐字证据", () => {
    const spec = buildChapterDeltaSystemSpec();
    expect(spec).toContain("题材中立");
    expect(spec).toContain("quote");
    expect(spec).toContain("只输出一个 JSON 对象");
  });

  it("传入未决线索标题 → 上下文段带编号，提示回收时从既有线索里选", () => {
    const context = buildChapterDeltaContextSections({ openThreadTitles: ["玄鹤失踪之谜", "账房后墙响动"] });
    expect(context).toContain("已开着的线索");
    expect(context).toContain("玄鹤失踪之谜");
    expect(context).toContain("账房后墙响动");
  });

  it("字段说明提醒计划/待办自然完成也要报进 resolvedForeshadowing", () => {
    expect(buildChapterDeltaSystemSpec()).toContain("之前挂着的计划/待办");
    expect(buildChapterDeltaSystemSpec()).toContain("本章做完了/不再需要了");
    expect(buildChapterDeltaSystemSpec()).toContain("也算回收");
  });

  it("字段说明要求声明 charactersPresent，并明令角色名逐字沿用、别写形近错名", () => {
    expect(buildChapterDeltaSystemSpec()).toContain("charactersPresent");
    expect(buildChapterDeltaSystemSpec()).toContain("形近");
  });

  it("字段说明要求声明 viewpoint（R5.1 视角人物）：跟着谁的眼睛走写谁，多视角/全知就省略", () => {
    const spec = buildChapterDeltaSystemSpec();
    expect(spec).toContain("viewpoint");
    expect(spec).toContain("视角人物");
    expect(spec).toContain("多视角或全知");
  });

  it("传入已确立角色名 → 上下文段提示逐字沿用这些名字", () => {
    const context = buildChapterDeltaContextSections({ establishedNames: ["林澈", "林宁"] });
    expect(context).toContain("本书已确立的角色名");
    expect(context).toContain("林澈");
    expect(context).toContain("林宁");
  });

  it("字段说明要求声明 arcGoalProgress（主线/阶段目标推进），题材中立", () => {
    const spec = buildChapterDeltaSystemSpec();
    expect(spec).toContain("arcGoalProgress");
    expect(spec).toContain("主线");
  });

  it("字段说明要求声明 conflict/discovery/decision 三个可选语义标量", () => {
    const spec = buildChapterDeltaSystemSpec();
    expect(spec).toContain("conflict");
    expect(spec).toContain("discovery");
    expect(spec).toContain("decision");
  });

  it("字段说明要求声明 pendingIntents（未完成待办/下一步意图）", () => {
    const spec = buildChapterDeltaSystemSpec();
    expect(spec).toContain("pendingIntents");
    expect(spec).toContain("未完成待办");
  });

  it("字段说明要求 resourceDeltas 只报实际完成得失，交易未成交不算", () => {
    const spec = buildChapterDeltaSystemSpec();
    expect(spec).toContain("实际完成");
    expect(spec).toContain("交易未成交");
    expect(spec).toContain("对方没收下");
    expect(spec).toContain("把灵石放在柜台上但对方没收=没有失去");
  });

  it("字段说明要求 resourceDeltas 的 amount 必须出现在 quote 中，否则省略 amount", () => {
    const spec = buildChapterDeltaSystemSpec();
    expect(spec).toContain("程序逐字核对 amount 在 quote 里");
    expect(spec).toContain("正文没写明数量就省略 amount");
  });

  it("字段说明要求 seededForeshadowing 只报后文回收的跨章悬念，本章内解决的不算", () => {
    const spec = buildChapterDeltaSystemSpec();
    expect(spec).toContain("预期后文回收");
    expect(spec).toContain("跨章悬念");
    expect(spec).toContain("本章内已经解决");
    expect(spec).toContain("不要报");
  });

  it("字段说明明确 mainEvent 只能选本章最大推动事件，不能选望风/赶路/环境铺垫", () => {
    const spec = buildChapterDeltaSystemSpec();
    expect(spec).toContain("本章推动故事的最大一件事");
    expect(spec).toContain("看见某人/某物");
    expect(spec).toContain("赶路");
    expect(spec).toContain("环境与气氛铺垫都不是 mainEvent");
  });

  it("字段说明要求 summary 是干净概括，禁止照抄 quote 原句", () => {
    const spec = buildChapterDeltaSystemSpec();
    expect(spec).toContain("summary 必须是你自己组织的一句话概括");
    expect(spec).toContain("禁止把 quote 原句照抄");
    expect(spec).toContain("summary 是给时间线看的干净摘要");
  });

  it("传入已存在目标标题 → 上下文段提示推进时对号入座既有目标（targetGoalHint 从这里选）", () => {
    const context = buildChapterDeltaContextSections({ openGoalTitles: ["查明码头凶案真凶", "摆脱漕帮控制"] });
    expect(context).toContain("已存在的主线/阶段目标");
    expect(context).toContain("查明码头凶案真凶");
    expect(context).toContain("摆脱漕帮控制");
  });

  it("传入上一章结尾 → 上下文段单列摘录并禁止作为 quote 来源", () => {
    const context = buildChapterDeltaContextSections({ previousChapterEnding: "上一章结尾：主角已在黑龙潭等待。" });
    expect(context).toContain("上一章结尾");
    expect(context).toContain("主角已在黑龙潭等待");
    expect(context).toContain("绝不能作为任何字段的 quote 来源");
    expect(buildChapterDeltaSystemSpec()).toContain("continuityWithPrevious");
  });
});

describe("parseChapterDeltaDeclaration", () => {
  it("完整 JSON → 解析成 declaration，chapter 用入参", () => {
    const text = JSON.stringify({
      mainEvent: { summary: "捡到残玉", quote: "半块残玉露了出来。" },
      seededForeshadowing: [{ summary: "鹤纹", quote: "刻着半只青色的鹤。" }],
      resolvedForeshadowing: [{ summary: "师父下落", quote: "师父原来早已不在。", targetThreadHint: "师父失踪" }],
      resourceDeltas: [{ item: "补气丹", change: "gain", amount: "十二枚", quote: "补气丹，十二枚。" }],
      keyLeads: [{ summary: "线索", quote: "墙后有异响。" }],
      pendingIntents: [{ summary: "明日查账房", quote: "他决定明日去账房。" }],
    });
    const result = parseChapterDeltaDeclaration(text, 7);
    expect(result?.chapter).toBe(7);
    expect(result?.mainEvent).toEqual({ summary: "捡到残玉", quote: "半块残玉露了出来。" });
    expect(result?.seededForeshadowing).toHaveLength(1);
    expect(result?.resolvedForeshadowing[0]?.targetThreadHint).toBe("师父失踪");
    expect(result?.resourceDeltas[0]).toMatchObject({ item: "补气丹", change: "gain", amount: "十二枚" });
    expect(result?.keyLeads).toHaveLength(1);
    expect(result?.pendingIntents).toHaveLength(1);
    expect(result?.pendingIntents?.[0]?.summary).toBe("明日查账房");
  });

  it("解析 charactersPresent（含 identityHint）", () => {
    const text = JSON.stringify({
      mainEvent: { summary: "事", quote: "原句。" },
      charactersPresent: [
        { name: "林澈", identityHint: "主角", quote: "林澈走进来。" },
        { name: "林宁", quote: "林宁的怀表。" },
      ],
    });
    const result = parseChapterDeltaDeclaration(text, 2);
    expect(result?.charactersPresent).toHaveLength(2);
    expect(result?.charactersPresent?.[0]).toMatchObject({ name: "林澈", identityHint: "主角" });
    expect(result?.charactersPresent?.[1]?.name).toBe("林宁");
  });

  it("charactersPresent 的 aliasOf：宽进——空串/空白当没给，不丢整条", () => {
    const parse = (aliasOf: unknown) => parseChapterDeltaDeclaration(JSON.stringify({
      mainEvent: { summary: "事", quote: "原句。" },
      charactersPresent: [{ name: "林师傅", aliasOf, quote: "林师傅走进来。" }],
    }), 2);
    expect(parse("林澈")?.charactersPresent?.[0]).toMatchObject({ name: "林师傅", aliasOf: "林澈" });
    expect(parse("  ")?.charactersPresent?.[0]?.aliasOf).toBeUndefined();
    expect(parse("")?.charactersPresent).toHaveLength(1);
    expect(parse(null)?.charactersPresent?.[0]?.name).toBe("林师傅");
  });

  it("viewpoint（R5.1 视角人物）：字符串归一后透传；空串/空白/非字符串当没给（多视角/全知），不连坐别的字段", () => {
    const parse = (viewpoint: unknown) => parseChapterDeltaDeclaration(JSON.stringify({
      mainEvent: { summary: "事", quote: "原句。" },
      charactersPresent: [{ name: "林澈", quote: "林澈走进来。" }],
      viewpoint,
    }), 2);
    expect(parse("  林澈 ")?.viewpoint).toBe("林澈");
    expect(parse("林澈")?.viewpoint).toBe("林澈");
    expect(parse("")?.viewpoint).toBeUndefined();
    expect(parse("   ")?.viewpoint).toBeUndefined();
    expect(parse(null)?.viewpoint).toBeUndefined();
    expect(parse(42)?.mainEvent?.summary).toBe("事"); // 坏值不丢整份声明
  });

  it("章内换天 timeSpan：天数宽进（「一」「1」都收）；0 / 坏值当没报，不连坐别的字段", () => {
    const parse = (timeSpan: unknown) => parseChapterDeltaDeclaration(JSON.stringify({ mainEvent: { summary: "事", quote: "原句。" }, timeSpan }), 6);
    expect(parse({ days: "一", quote: "第二天上午，她去了槐树巷。" })?.timeSpan).toEqual({ days: 1, quote: "第二天上午，她去了槐树巷。" });
    expect(parse({ days: 2, quote: "过了两天。" })?.timeSpan).toEqual({ days: 2, quote: "过了两天。" });
    expect(parse({ days: 0, quote: "当天。" })?.timeSpan).toBeUndefined();
    expect(parse({ days: "", quote: "" })?.mainEvent?.summary).toBe("事");
    expect(parse(null)?.timeSpan).toBeUndefined();
  });

  it("未给 charactersPresent → 默认空数组", () => {
    const result = parseChapterDeltaDeclaration(JSON.stringify({ mainEvent: { summary: "事", quote: "原句。" } }), 1);
    expect(result?.charactersPresent).toEqual([]);
  });

  it("解析 arcGoalProgress（progress/scope/targetGoalHint）", () => {
    const text = JSON.stringify({
      mainEvent: { summary: "事", quote: "原句。" },
      arcGoalProgress: [
        { summary: "查明码头凶案真凶", progress: "introduced", scope: "main_arc", quote: "他决心查明真凶。" },
        { summary: "凶案告破", progress: "completed", targetGoalHint: "查明码头凶案真凶", quote: "真凶落网。" },
      ],
    });
    const result = parseChapterDeltaDeclaration(text, 3);
    expect(result?.arcGoalProgress).toHaveLength(2);
    expect(result?.arcGoalProgress?.[0]).toMatchObject({ summary: "查明码头凶案真凶", progress: "introduced", scope: "main_arc" });
    expect(result?.arcGoalProgress?.[1]).toMatchObject({ progress: "completed", targetGoalHint: "查明码头凶案真凶" });
  });

  it("未给 arcGoalProgress → 默认空数组", () => {
    const result = parseChapterDeltaDeclaration(JSON.stringify({ mainEvent: { summary: "事", quote: "原句。" } }), 1);
    expect(result?.arcGoalProgress).toEqual([]);
  });

  it("arcGoalProgress.progress 非法枚举 → 只丢那一条（逐条打捞），mainEvent 等其余照收", () => {
    const drops: string[] = [];
    const text = JSON.stringify({
      mainEvent: { summary: "事", quote: "原句。" },
      arcGoalProgress: [
        { summary: "目标", progress: "瞎推进", quote: "句。" },
        { summary: "好目标", progress: "advanced", quote: "另一句。" },
      ],
    });
    const result = parseChapterDeltaDeclaration(text, 1, (field) => drops.push(field));
    expect(result?.mainEvent?.summary).toBe("事");
    expect(result?.arcGoalProgress).toHaveLength(1);
    expect(result?.arcGoalProgress?.[0]?.summary).toBe("好目标");
    expect(drops).toContain("arcGoalProgress[0]");
  });

  it("解析 conflict/discovery/decision（可选语义标量）", () => {
    const text = JSON.stringify({
      mainEvent: { summary: "事", quote: "原句。" },
      conflict: { summary: "冲突", quote: "冲突句。" },
      discovery: { summary: "发现", quote: "发现句。" },
      decision: { summary: "决定", quote: "决定句。" },
    });
    const result = parseChapterDeltaDeclaration(text, 3);
    expect(result?.conflict).toEqual({ summary: "冲突", quote: "冲突句。" });
    expect(result?.discovery).toEqual({ summary: "发现", quote: "发现句。" });
    expect(result?.decision).toEqual({ summary: "决定", quote: "决定句。" });
  });

  it("未给 conflict/discovery/decision → 不出现在结果里（可选、不占位）", () => {
    const result = parseChapterDeltaDeclaration(JSON.stringify({ mainEvent: { summary: "事", quote: "原句。" } }), 1);
    expect(result?.conflict).toBeUndefined();
    expect(result?.discovery).toBeUndefined();
    expect(result?.decision).toBeUndefined();
  });

  it("未给 pendingIntents → 默认空数组", () => {
    const result = parseChapterDeltaDeclaration(JSON.stringify({ mainEvent: { summary: "事", quote: "原句。" } }), 1);
    expect(result?.pendingIntents).toEqual([]);
  });

  it("解析 continuityWithPrevious（connects/note）", () => {
    const text = JSON.stringify({
      mainEvent: { summary: "事", quote: "原句。" },
      continuityWithPrevious: { connects: false, note: "上一章在黑龙潭，本章回到园圃。" },
    });
    const result = parseChapterDeltaDeclaration(text, 6);
    expect(result?.continuityWithPrevious).toEqual({
      connects: false,
      note: "上一章在黑龙潭，本章回到园圃。",
    });
  });

  it("未给 continuityWithPrevious → 不出现在结果里", () => {
    const result = parseChapterDeltaDeclaration(JSON.stringify({ mainEvent: { summary: "事", quote: "原句。" } }), 1);
    expect(result?.continuityWithPrevious).toBeUndefined();
  });

  it("带 Markdown 代码围栏的 JSON → 仍能抠出并解析", () => {
    const text = "```json\n{\"mainEvent\":{\"summary\":\"事\",\"quote\":\"原句。\"}}\n```";
    const result = parseChapterDeltaDeclaration(text, 1);
    expect(result?.mainEvent?.summary).toBe("事");
    // 缺省列表补空数组
    expect(result?.seededForeshadowing).toEqual([]);
    expect(result?.resourceDeltas).toEqual([]);
  });

  it("缺 mainEvent → 用空证据占位并记录缺失告警（引擎会以 empty_quote 拒收并回退）", () => {
    const drops: string[] = [];
    const details: string[] = [];
    const result = parseChapterDeltaDeclaration(
      JSON.stringify({ keyLeads: [] }),
      2,
      (field, detail) => {
        drops.push(field);
        details.push(detail);
      },
    );
    expect(result?.mainEvent).toEqual({ summary: "", quote: "" });
    expect(drops).toContain("mainEvent");
    expect(details.join("\n")).toContain("声明缺失 mainEvent");
  });

  it("非 JSON 文本 → undefined，且 onDrop 记录整体失败原因", () => {
    const drops: string[] = [];
    expect(parseChapterDeltaDeclaration("这不是 JSON", 1, (field) => drops.push(field))).toBeUndefined();
    expect(drops).toContain("(root)");
  });

  it("resourceDeltas 单条 change 非法枚举 → 只丢那一条，声明整体保留", () => {
    const drops: string[] = [];
    const text = JSON.stringify({
      mainEvent: { summary: "事", quote: "原句。" },
      resourceDeltas: [
        { item: "丹", change: "偷", quote: "句。" },
        { item: "灵石", change: "spend", amount: "两枚", quote: "花了两枚灵石。" },
      ],
    });
    const result = parseChapterDeltaDeclaration(text, 1, (field) => drops.push(field));
    expect(result?.mainEvent?.summary).toBe("事");
    expect(result?.resourceDeltas).toHaveLength(1);
    expect(result?.resourceDeltas?.[0]?.item).toBe("灵石");
    expect(drops).toContain("resourceDeltas[0]");
  });

  it("pendingIntents 单条坏数据 → 逐条丢弃，其余照收", () => {
    const drops: string[] = [];
    const text = JSON.stringify({
      mainEvent: { summary: "事", quote: "原句。" },
      pendingIntents: [
        { summary: "缺证据" },
        { summary: "明日去账房", quote: "他决定明日去账房。" },
      ],
    });
    const result = parseChapterDeltaDeclaration(text, 1, (field) => drops.push(field));
    expect(result?.pendingIntents).toHaveLength(1);
    expect(result?.pendingIntents?.[0]?.summary).toBe("明日去账房");
    expect(drops).toContain("pendingIntents[0]");
  });

  it("列表字段是退化输入（字符串而非数组）→ 该字段按空数组，其余照收", () => {
    const drops: string[] = [];
    const text = JSON.stringify({
      mainEvent: { summary: "事", quote: "原句。" },
      keyLeads: "没有线索",
    });
    const result = parseChapterDeltaDeclaration(text, 1, (field) => drops.push(field));
    expect(result?.mainEvent?.summary).toBe("事");
    expect(result?.keyLeads).toEqual([]);
    expect(drops).toContain("keyLeads");
  });

  it("mainEvent 本身坏（缺 quote）→ 空证据占位（引擎 empty_quote 拒收），conflict 等好字段照收", () => {
    const drops: string[] = [];
    const text = JSON.stringify({
      mainEvent: { summary: "只有概括没有证据" },
      conflict: { summary: "冲突", quote: "冲突句。" },
    });
    const result = parseChapterDeltaDeclaration(text, 1, (field) => drops.push(field));
    expect(result?.mainEvent).toEqual({ summary: "", quote: "" });
    expect(result?.conflict?.summary).toBe("冲突");
    expect(drops).toContain("mainEvent");
  });

  it("warnLikelyCopiedSummaries：summary 疑似照抄 quote → console.warn 记录告警但保留该条目", async () => {
    const { warnLikelyCopiedSummaries } = await import("./chapter-delta-declaration.js");
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };
    const declaration = parseChapterDeltaDeclaration(JSON.stringify({
      mainEvent: {
        summary: "他贴着墙根往阴影里缩了缩，看见两个穿灰布衫的汉子走了过去。",
        quote: "他贴着墙根往阴影里缩了缩，看见两个穿灰布衫的汉子走了过去。",
      },
      discovery: {
        summary: "发现铜腰牌",
        quote: "腰间隐约露出执法殿的铜腰牌。",
      },
    }), 26);
    try {
      expect(declaration?.mainEvent?.summary).toBe("他贴着墙根往阴影里缩了缩，看见两个穿灰布衫的汉子走了过去。");
      warnLikelyCopiedSummaries(26, declaration!);
      expect(warnings.some((entry) => entry.includes("ch26 mainEvent.summary 疑似照抄 quote 原句"))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });
});
