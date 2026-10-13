import { describe, expect, it } from "vitest";
import type { StateOverview } from "@actalk/story-engine";
import { buildChapterChatMessages, buildFoundationGapChatMessages, buildFoundationGapChatSystemPrompt } from "./prompt-builder.js";

describe("chapter chat prompt builder", () => {
  it("exposes all implemented workflow intents to the router model", () => {
    const messages = buildChapterChatMessages({
      overview: minimalOverview(),
      chapter: 1,
      message: "帮我质检一下",
      messages: [],
      mode: "discuss",
    });
    const system = messages[0]?.content ?? "";
    for (const intent of [
      "generate_steering",
      "quality_check",
      "ai_review",
      "revision_preview",
      "commit_preview",
      "commit_apply",
      "continue_next",
    ]) {
      expect(system).toContain(intent);
    }
  });

  it("keeps the full 16-intent enum line stable in the system prompt", () => {
    const messages = buildChapterChatMessages({
      overview: minimalOverview(),
      chapter: 1,
      message: "帮我质检一下",
      messages: [],
      mode: "discuss",
    });
    const system = messages[0]?.content ?? "";
    expect(system).toContain(
      "discuss | suggest | direct_edit | generate_steering | generate_draft | quality_check | ai_review | revision_preview | commit_preview | commit_apply | continue_next | query_story_data | edit_foundation | write_writing_rules | write_story_settings | chapter_complete",
    );
  });
});

describe("foundation gap prompt builder", () => {
  it("includes the current article excerpt when the user asks to extract facts from the article", () => {
    const messages = buildFoundationGapChatMessages({
      history: [],
      message: "根据文章内容补充具体信息",
      overview: minimalOverview(),
      report: minimalReport(),
      suggestions: [],
      currentDraftContent: "林远在海天市旧城区拿到黑色权限卡，随后进入远山集团总部地下车库。",
    });

    const userMessage = messages.at(-1)?.content ?? "";

    expect(userMessage).toContain("当前正文摘录");
    expect(userMessage).toContain("林远在海天市旧城区拿到黑色权限卡");
    expect(userMessage).toContain("用户消息：根据文章内容补充具体信息");
  });

  it("pins a must-emit directive at the end of the user message in directArchive mode", () => {
    // 治真机回归：裸句「林晚突破金丹期了」在 directArchive 下模型 reply 认出了「境界」却出空卡、说"没有谈妥"。
    // 在用户消息末尾（recency 最优）再钉一遍"认出字段就必须出对应建议、不许空数组/没有谈妥"。
    const directArchive = buildFoundationGapChatMessages({
      history: [],
      message: "林晚突破金丹期了",
      overview: minimalOverview(),
      report: minimalReport(),
      suggestions: [],
      directArchive: true,
    });
    const userMessage = directArchive.at(-1)?.content ?? "";
    expect(userMessage).toContain("用户消息：林晚突破金丹期了");
    expect(userMessage).toContain("必须出卡");
    expect(userMessage).toContain("reply 里描述了字段却 generatedSuggestions 为空");

    // 默认（交互式资料管家，非 directArchive）不加这条命令，「先问」体验不变。
    const interactive = buildFoundationGapChatMessages({
      history: [],
      message: "林晚突破金丹期了",
      overview: minimalOverview(),
      report: minimalReport(),
      suggestions: [],
    });
    expect(interactive.at(-1)?.content ?? "").not.toContain("必须出卡");
  });

  it("grants real write authority and drops all V0 write bans", () => {
    const messages = buildFoundationGapChatMessages({
      history: [],
      message: "写入吧",
      overview: minimalOverview(),
      report: minimalReport(),
      suggestions: [],
    });
    const system = messages[0]?.content ?? "";

    expect(system).not.toContain("不开放正式写入");
    expect(system).not.toContain("只能引导生成写入预览");
    expect(system).not.toContain("不能声称已经写入文件");
    expect(system).not.toContain("只展示预览和草案卡");

    expect(system).toContain("真实的资料写入和删除能力");
    expect(system).toContain("回看全部对话历史");
    expect(system).toContain("一次最多 12 条");
    expect(system).toContain("不要硬凑");
  });

  it("teaches the pre-writing methodology, proactive reminders, and richness rules", () => {
    const messages = buildFoundationGapChatMessages({
      history: [],
      message: "能开写了吗",
      overview: minimalOverview(),
      report: minimalReport(),
      suggestions: [],
    });
    const system = messages[0]?.content ?? "";

    expect(system).toContain("开写前必须有");
    expect(system).toContain("可以边写边补");
    expect(system).toContain("主动提醒");
    expect(system).toContain("只建议、永不阻止");
    expect(system).toContain("尽量填满");
    expect(system).toContain("根据设定推断");
    expect(system).toContain("delete_foundation_entry");
  });

  it("asks the model to list draft field content when users request preview details", () => {
    const messages = buildFoundationGapChatMessages({
      history: [],
      message: "给我看一下草案内容是什么",
      overview: minimalOverview(),
      report: minimalReport(),
      suggestions: [],
    });
    const system = messages[0]?.content ?? "";

    expect(system).toContain("完整列出来");
  });

  it("teaches the archiver to reuse and propose extraFields with the book's existing custom field list", () => {
    const system = buildFoundationGapChatSystemPrompt(["境界"]);

    // ① 优先复用已有自定义字段的指令
    expect(system).toContain("优先复用");
    // ② 三分法规则：进不了内置字段且会复用的属性 → 提议新增 extraFields；一次性零碎信息 → 进备注
    expect(system).toContain("extraFields");
    expect(system).toContain("备注");
    // ③ 已有字段清单出现在 prompt 中
    expect(system).toContain("境界");
    // after 可以带 extraFields 对象
    expect(system).toContain('"extraFields"');
  });

  it("renders an empty-state line for extraFields when no custom fields exist yet", () => {
    const system = buildFoundationGapChatSystemPrompt();

    expect(system).toContain("extraFields");
    // 向后兼容：不传清单时仍然渲染自定义字段规则，且不报错
    expect(system).toContain("自定义字段");
  });

  it("passes existing extraFields keys through buildFoundationGapChatMessages into the system prompt", () => {
    const messages = buildFoundationGapChatMessages({
      history: [],
      message: "记一下他的境界",
      overview: minimalOverview(),
      report: minimalReport(),
      suggestions: [],
      existingExtraFieldKeys: ["功法"],
    });
    const system = messages[0]?.content ?? "";

    expect(system).toContain("功法");
  });

  // F2: triage 直接归档模式。triage 已分诊为「待直接归档」的裸事实，
  // 走「决断式抽取」契约：强制产出 generatedSuggestions、不追问、不等写入指令。
  // 默认（不带 directArchive）的交互式资料管家「先问」体验必须保持不动。
  it("switches to a decisive extraction contract in directArchive mode", () => {
    const system = buildFoundationGapChatSystemPrompt(["境界"], { directArchive: true });

    // 决断式指令：直接抽取 + 强制产出 generatedSuggestions + 不要追问
    expect(system).toContain("已分诊");
    expect(system).toContain("直接");
    expect(system).toContain("抽取");
    expect(system).toContain("强制产出 generatedSuggestions");
    expect(system).toContain("不要追问");
    // extraFields 旗舰路径仍要讲清楚（境界 → update_character_detail.after.extraFields）
    expect(system).toContain("extraFields");
    expect(system).toContain("update_character_detail");
  });

  it("teaches pronoun resolution to the protagonist in directArchive mode (她家在城南)", () => {
    const system = buildFoundationGapChatSystemPrompt(["境界"], { directArchive: true });

    // H3：directArchive 下「她/他/主角」等指代必须先用上下文里的主角/已知角色解析到具体角色再归档，
    // 而不是因指代悬空就泛化成「没有谈妥资料点」出空卡。
    expect(system).toContain("指代消解");
    // 旗舰反例：用「她家在城南」演示「她」→主角，归到主角卡。
    expect(system).toContain("她家在城南");
    // 真有多个候选无法确定时才点名反问，仍不许出空卡。
    expect(system).toContain("反问");
  });

  it("does not let the model stall with questions in directArchive mode", () => {
    const system = buildFoundationGapChatSystemPrompt(["境界"], { directArchive: true });

    // 决断段以追加覆盖的方式压制「先问 / 等写入指令 / 还没谈妥」那套追问行为。
    expect(system).toContain("覆盖上面的追问规则");
    expect(system).toContain("不要等");
    expect(system).toContain("不要追问");
    // 锚定真实覆盖关系：base 的追问规则原文与决断段的覆盖措辞必须同时存在。
    expect(system).toContain("先问 3-5 个最关键的问题");
    expect(system).toContain("覆盖上面的追问规则");
  });

  it("keeps the original interactive (ask-first) prompt when directArchive is false or omitted", () => {
    const omitted = buildFoundationGapChatSystemPrompt(["境界"]);
    const explicitFalse = buildFoundationGapChatSystemPrompt(["境界"], { directArchive: false });

    for (const system of [omitted, explicitFalse]) {
      // 交互面板仍先问：原问答 prompt 一字不动。
      expect(system).toContain("先问 3-5 个最关键的问题");
      expect(system).toContain("不要硬出一张空卡");
      // 不混入决断式指令
      expect(system).not.toContain("强制产出 generatedSuggestions");
      expect(system).not.toContain("已分诊");
    }
  });

  it("threads directArchive through buildFoundationGapChatMessages into the system prompt", () => {
    const decisive = buildFoundationGapChatMessages({
      history: [],
      message: "林晚突破金丹期了",
      overview: minimalOverview(),
      report: minimalReport(),
      suggestions: [],
      existingExtraFieldKeys: ["境界"],
      directArchive: true,
    });
    const interactive = buildFoundationGapChatMessages({
      history: [],
      message: "林晚突破金丹期了",
      overview: minimalOverview(),
      report: minimalReport(),
      suggestions: [],
      existingExtraFieldKeys: ["境界"],
    });

    expect(decisive[0]?.content ?? "").toContain("强制产出 generatedSuggestions");
    expect(interactive[0]?.content ?? "").not.toContain("强制产出 generatedSuggestions");
  });
});

function minimalOverview(): StateOverview {
  return {
    project: { title: "测试书", genre: "都市", currentChapter: 1 },
    storyStatus: {},
    hooks: { activeCount: 0, touchedCount: 0, resolvedCount: 0, activeItems: [] },
    threads: { total: 0, open: 0, touched: 0, done: 0, openIntents: 0, cleanupVisibleCount: 0, cleanupVisibleUnresolvedCount: 0, keyOpenItems: [] },
    arcGoals: { activeCount: 0, touchedCount: 0, completedCount: 0, activeItems: [] },
    timeline: { recentEvents: [], earlierSummary: [], macroSummary: [] },
    characters: { protagonist: "林远", knownCharacters: [{ id: "guo-xu", name: "林远", role: "主角" }] },
    world: { activeLocations: [], importantFacts: [], protectedSecrets: [] },
    storyFoundation: { available: false, missingFiles: [], summary: "" },
    storyBible: { available: false, longFormGoals: [], centralConflicts: [], coreMysteries: [], forbiddenChanges: [], canonFacts: [], openQuestions: [], protectedSecrets: [] },
    writingRules: { available: false, proseStyle: [], genreRequirements: [], forbiddenContent: [], doNotDo: [], readerExperienceRules: [], antiAiPatterns: [] },
    characterBible: { available: false, characterCount: 0, keyCharacters: [] },
    characterMatrix: { available: false, characters: [], relationships: [], riskReminders: [] },
    worldBible: { available: false, ruleCount: 0, factionCount: 0, systemCount: 0, keyRules: [], keyFactions: [], resourceRules: [], authorityRules: [], socialOrder: [], conflictSources: [], fixedFacts: [], protectedSecrets: [], publicFacts: [], hiddenFacts: [], forbiddenRuleBreaks: [] },
    locationBible: { available: false, locationCount: 0, activeLocationNames: [], riskCount: 0, resourceCount: 0, keyRisks: [], keyResources: [], keyNarrativeFunctions: [] },
    assetSummary: { available: false, carriedAssets: [], ownedAssets: [], unavailableAssets: [], plotCriticalAssets: [], assetItems: [] },
    locationDetailSummary: { locations: [], floors: [], rooms: [], entrances: [], exits: [], travelRules: [], risks: [], resources: [], fixedFacts: [] },
    characterDetailSummary: { characters: [] },
    foundationCompleteness: { passed: false, readinessLevel: "warning", missingItems: [], suggestions: [] },
    maintenance: { diagnosticsAvailable: false, cleanupVisibleCount: 0, markDoneCandidateCount: 0, mergeDisabled: true, dropDisabled: true, confirmPolicy: { markDone: "manual_only", merge: "disabled", drop: "disabled" } },
    uiHints: { recommendedNextPanels: [], warnings: [], disabledActions: [] },
  };
}

function minimalReport() {
  return {
    passed: false,
    readinessLevel: "warning" as const,
    missingItems: [],
    riskyItems: [],
    conflictItems: [],
    suggestions: [],
    byCategory: {
      story: [],
      world: [],
      writingRules: [],
      characters: [],
      characterRelationships: [],
      locations: [],
      assets: [],
      hooks: [],
      threads: [],
      arcGoals: [],
      timeline: [],
      knowledgeBoundary: [],
    },
  };
}
