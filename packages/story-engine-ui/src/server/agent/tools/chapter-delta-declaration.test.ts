// @vitest-environment node
//
// chapter-delta-declaration 纯逻辑单测：prompt 题材中立、JSON 解析健壮、坏 JSON/超时/空正文全部降级为 undefined。
// callModel 注入，不真连网络。
import { afterEach, describe, expect, it, vi } from "vitest";

const llmMocks = vi.hoisted(() => ({
  resolveConfiguredChatModel: vi.fn(),
  streamChatModelToText: vi.fn(),
  callOpenAICompatibleChatModel: vi.fn(),
}));
vi.mock("../../lib/llm-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/llm-client.js")>();
  return { ...actual, ...llmMocks };
});

import {
  buildChapterDeltaMessages,
  callConfiguredDeclareModel,
  DECLARE_IDLE_TIMEOUT_MS,
  declareChapterDelta,
  declareChapterDeltaWithStatus,
  parseChapterDeltaDeclaration,
} from "./chapter-delta-declaration.js";

describe("buildChapterDeltaMessages", () => {
  it("system 提示题材中立、要求逐字证据；user 带章号与正文", () => {
    const messages = buildChapterDeltaMessages({ chapter: 3, draft: "正文内容。" });
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toContain("题材中立");
    expect(messages[0]?.content).toContain("quote");
    expect(messages[1]?.role).toBe("user");
    expect(messages[1]?.content).toContain("第 3 章");
    expect(messages[1]?.content).toContain("正文内容。");
  });

  it("传入未决线索标题 → 提示模型回收时从既有线索里选", () => {
    const messages = buildChapterDeltaMessages({
      chapter: 4,
      draft: "正文。",
      openThreadTitles: ["玄鹤失踪之谜", "账房后墙响动"],
    });
    expect(messages[1]?.content).toContain("玄鹤失踪之谜");
    expect(messages[1]?.content).toContain("账房后墙响动");
  });

  it("system 提醒计划/待办自然完成也要报进 resolvedForeshadowing", () => {
    const messages = buildChapterDeltaMessages({ chapter: 4, draft: "正文。" });
    expect(messages[0]?.content).toContain("之前挂着的计划/待办");
    expect(messages[0]?.content).toContain("本章做完了/不再需要了");
    expect(messages[0]?.content).toContain("也算回收");
  });

  it("system 要求声明 charactersPresent，并明令角色名逐字沿用、别写形近错名", () => {
    const messages = buildChapterDeltaMessages({ chapter: 1, draft: "正文。" });
    expect(messages[0]?.content).toContain("charactersPresent");
    expect(messages[0]?.content).toContain("形近");
  });

  it("传入已确立角色名 → user 提示逐字沿用这些名字", () => {
    const messages = buildChapterDeltaMessages({
      chapter: 2,
      draft: "正文。",
      establishedNames: ["林澈", "林宁"],
    });
    expect(messages[1]?.content).toContain("本书已确立的角色名");
    expect(messages[1]?.content).toContain("林澈");
    expect(messages[1]?.content).toContain("林宁");
  });

  it("system 要求声明 arcGoalProgress（主线/阶段目标推进），题材中立", () => {
    const messages = buildChapterDeltaMessages({ chapter: 1, draft: "正文。" });
    expect(messages[0]?.content).toContain("arcGoalProgress");
    expect(messages[0]?.content).toContain("主线");
  });

  it("system 要求声明 conflict/discovery/decision 三个可选语义标量", () => {
    const messages = buildChapterDeltaMessages({ chapter: 1, draft: "正文。" });
    expect(messages[0]?.content).toContain("conflict");
    expect(messages[0]?.content).toContain("discovery");
    expect(messages[0]?.content).toContain("decision");
  });

  it("system 要求声明 pendingIntents（未完成待办/下一步意图）", () => {
    const messages = buildChapterDeltaMessages({ chapter: 1, draft: "正文。" });
    expect(messages[0]?.content).toContain("pendingIntents");
    expect(messages[0]?.content).toContain("未完成待办");
    expect(messages[0]?.content).toContain("只输出一个 JSON 对象");
  });

  it("system 要求 resourceDeltas 只报实际完成得失，交易未成交不算", () => {
    const messages = buildChapterDeltaMessages({ chapter: 53, draft: "正文。" });
    expect(messages[0]?.content).toContain("实际完成");
    expect(messages[0]?.content).toContain("交易未成交");
    expect(messages[0]?.content).toContain("对方没收下");
    expect(messages[0]?.content).toContain("把灵石放在柜台上但对方没收=没有失去");
  });

  it("system 要求 resourceDeltas 的 amount 必须出现在 quote 中，否则省略 amount", () => {
    const messages = buildChapterDeltaMessages({ chapter: 53, draft: "正文。" });
    expect(messages[0]?.content).toContain("程序逐字核对 amount 在 quote 里");
    expect(messages[0]?.content).toContain("正文没写明数量就省略 amount");
  });

  it("system 要求 seededForeshadowing 只报后文回收的跨章悬念，本章内解决的不算", () => {
    const messages = buildChapterDeltaMessages({ chapter: 53, draft: "正文。" });
    expect(messages[0]?.content).toContain("预期后文回收");
    expect(messages[0]?.content).toContain("跨章悬念");
    expect(messages[0]?.content).toContain("本章内已经解决");
    expect(messages[0]?.content).toContain("不要报");
  });

  it("system 明确 mainEvent 只能选本章最大推动事件，不能选望风/赶路/环境铺垫", () => {
    const messages = buildChapterDeltaMessages({ chapter: 26, draft: "正文。" });

    expect(messages[0]?.content).toContain("本章推动故事的最大一件事");
    expect(messages[0]?.content).toContain("看见某人/某物");
    expect(messages[0]?.content).toContain("赶路");
    expect(messages[0]?.content).toContain("环境与气氛铺垫都不是 mainEvent");
  });

  it("system 要求 summary 是干净概括，禁止照抄 quote 原句", () => {
    const messages = buildChapterDeltaMessages({ chapter: 26, draft: "正文。" });

    expect(messages[0]?.content).toContain("summary 必须是你自己组织的一句话概括");
    expect(messages[0]?.content).toContain("禁止把 quote 原句照抄");
    expect(messages[0]?.content).toContain("summary 是给时间线看的干净摘要");
  });

  it("传入已存在目标标题 → user 提示推进时对号入座既有目标（targetGoalHint 从这里选）", () => {
    const messages = buildChapterDeltaMessages({
      chapter: 6,
      draft: "正文。",
      openGoalTitles: ["查明码头凶案真凶", "摆脱漕帮控制"],
    });
    expect(messages[1]?.content).toContain("已存在的主线/阶段目标");
    expect(messages[1]?.content).toContain("查明码头凶案真凶");
    expect(messages[1]?.content).toContain("摆脱漕帮控制");
  });

  it("传入上一章结尾 → user 单列摘录并禁止作为 quote 来源", () => {
    const messages = buildChapterDeltaMessages({
      chapter: 6,
      draft: "本章开头。",
      previousChapterEnding: "上一章结尾：主角已在黑龙潭等待。",
    });
    expect(messages[1]?.content).toContain("上一章结尾");
    expect(messages[1]?.content).toContain("主角已在黑龙潭等待");
    expect(messages[1]?.content).toContain("绝不能作为任何字段的 quote 来源");
    expect(messages[0]?.content).toContain("continuityWithPrevious");
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

  it("summary 疑似照抄 quote → console.warn 记录告警但保留该条目", async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };
    const payload = {
      mainEvent: {
        summary: "他贴着墙根往阴影里缩了缩，看见两个穿灰布衫的汉子走了过去。",
        quote: "他贴着墙根往阴影里缩了缩，看见两个穿灰布衫的汉子走了过去。",
      },
      discovery: {
        summary: "发现铜腰牌",
        quote: "腰间隐约露出执法殿的铜腰牌。",
      },
    };

    try {
      const result = await declareChapterDelta({
        chapter: 26,
        draft: "他贴着墙根往阴影里缩了缩，看见两个穿灰布衫的汉子走了过去。腰间隐约露出执法殿的铜腰牌。",
        callModel: async () => JSON.stringify(payload),
      });

      expect(result?.mainEvent?.summary).toBe("他贴着墙根往阴影里缩了缩，看见两个穿灰布衫的汉子走了过去。");
      expect(warnings.some((entry) => entry.includes("ch26 mainEvent.summary 疑似照抄 quote 原句"))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("declareChapterDelta", () => {
  it("正常路径：注入 callModel 返回合法 JSON → 得到 declaration", async () => {
    const result = await declareChapterDelta({
      chapter: 5,
      draft: "本章正文。",
      callModel: async () => JSON.stringify({ mainEvent: { summary: "事", quote: "本章正文。" } }),
    });
    expect(result?.chapter).toBe(5);
    expect(result?.mainEvent?.summary).toBe("事");
  });

  it("空正文 → 直接 undefined，不调模型", async () => {
    let called = false;
    const result = await declareChapterDelta({
      chapter: 1,
      draft: "   ",
      callModel: async () => {
        called = true;
        return "{}";
      },
    });
    expect(result).toBeUndefined();
    expect(called).toBe(false);
  });

  it("模型抛错（超时/网络）→ undefined（非致命降级）", async () => {
    const result = await declareChapterDelta({
      chapter: 1,
      draft: "正文。",
      callModel: async () => {
        throw new Error("模型请求超时：20000ms");
      },
    });
    expect(result).toBeUndefined();
  });

  it("模型返回坏 JSON → undefined", async () => {
    const result = await declareChapterDelta({
      chapter: 1,
      draft: "正文。",
      callModel: async () => "对不起我无法输出 JSON",
    });
    expect(result).toBeUndefined();
  });
});

// P1（2026-10-02）：声明失败不再静默——带状态的编排返回 status + 原因，供 commit_preview/commit_apply 折进用户可见摘要。
describe("declareChapterDeltaWithStatus（状态 + 原因，绝不静默）", () => {
  it("合法 JSON → status=model，带 declaration", async () => {
    const out = await declareChapterDeltaWithStatus({
      chapter: 5,
      draft: "本章正文。",
      callModel: async () => JSON.stringify({ mainEvent: { summary: "事", quote: "本章正文。" } }),
    });
    expect(out.status).toBe("model");
    expect(out.declaration?.chapter).toBe(5);
    expect(out.reason).toBeUndefined();
  });

  it("空正文 → fallback + 原因，不调模型", async () => {
    let called = false;
    const out = await declareChapterDeltaWithStatus({
      chapter: 1,
      draft: "  ",
      callModel: async () => {
        called = true;
        return "{}";
      },
    });
    expect(called).toBe(false);
    expect(out.status).toBe("fallback");
    expect(out.reason).toContain("正文为空");
  });

  it("模型抛错（空闲超时/流中 error 帧/截断）→ fallback，原因含错误摘要且压成一行截短", async () => {
    const out = await declareChapterDeltaWithStatus({
      chapter: 1,
      draft: "正文。",
      callModel: async () => {
        throw new Error(`模型返回错误：${"x".repeat(500)}\n多行`);
      },
    });
    expect(out.status).toBe("fallback");
    expect(out.declaration).toBeUndefined();
    expect(out.reason).toMatch(/^声明模型调用失败：模型返回错误：x+…$/u);
    expect(out.reason?.length).toBeLessThan(200);
  });

  it("坏 JSON → fallback，原因说明无法解析", async () => {
    const out = await declareChapterDeltaWithStatus({
      chapter: 1,
      draft: "正文。",
      callModel: async () => "对不起我无法输出 JSON",
    });
    expect(out.status).toBe("fallback");
    expect(out.reason).toContain("无法解析");
  });
});

describe("callConfiguredDeclareModel（走 streamChatModelToText 空闲超时，不再是 45s 固定死表）", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("用 chapterSteering 档、强制 thinking:false、json_object、idleTimeoutMs=DECLARE_IDLE_TIMEOUT_MS；不走非流式固定超时", async () => {
    llmMocks.resolveConfiguredChatModel.mockResolvedValue({
      provider: { id: "p", baseUrl: "https://x.invalid/v1" },
      profile: { id: "m", provider: "p", model: "m" },
      apiKey: "",
      thinking: true,
      thinkingDialect: "glm",
    });
    llmMocks.streamChatModelToText.mockResolvedValue({ content: "{\"mainEvent\":{\"summary\":\"a\",\"quote\":\"b\"}}", thinking: "" });
    const text = await callConfiguredDeclareModel([{ role: "user", content: "声明" }]);
    expect(text).toContain("mainEvent");
    expect(llmMocks.resolveConfiguredChatModel).toHaveBeenCalledWith("chapterSteering");
    expect(llmMocks.callOpenAICompatibleChatModel).not.toHaveBeenCalled();
    const call = llmMocks.streamChatModelToText.mock.calls[0]?.[0] as Record<string, unknown>;
    expect((call.configured as { thinking: boolean }).thinking).toBe(false);
    expect(call.responseFormat).toEqual({ type: "json_object" });
    expect(call.idleTimeoutMs).toBe(DECLARE_IDLE_TIMEOUT_MS);
    expect(DECLARE_IDLE_TIMEOUT_MS).toBeLessThan(90_000); // 预览路径收紧的空闲窗口（不是总时长上限）
    expect("timeoutMs" in call).toBe(false);
    expect("max_tokens" in call || "maxTokens" in call).toBe(false);
  });

  it("流式返回空正文 → 抛错（由上层收成 fallback，不把空串当成功声明）", async () => {
    llmMocks.resolveConfiguredChatModel.mockResolvedValue({
      provider: { id: "p", baseUrl: "https://x.invalid/v1" },
      profile: { id: "m", provider: "p", model: "m" },
      apiKey: "",
      thinking: false,
      thinkingDialect: "none",
    });
    llmMocks.streamChatModelToText.mockResolvedValue({ content: "   ", thinking: "" });
    await expect(callConfiguredDeclareModel([{ role: "user", content: "声明" }])).rejects.toThrow("空内容");
  });
});
