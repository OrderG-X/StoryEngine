import { describe, expect, it } from "vitest";
import type { FoundationGapApplyPlan, FoundationGapSkippedWrite, FoundationGapSuggestion } from "../api/types.js";
import { useWorkspaceStore } from "../stores/workspaceStore.js";
import {
  buildNoExecutableFoundationChangeFeedback,
  conversationFromWorkspaceMessages,
  foundationApplyResultText,
  foundationDeleteBlockedText,
  foundationDeleteConfirmationConflicts,
  foundationDeleteConfirmText,
  foundationSuggestionPreviewText,
  foundationWritesResultText,
  isExplicitFoundationWriteRequest,
  isFoundationDeleteRequest,
  shouldAutoApplyFoundationSuggestionsFromChat,
} from "./useChat.js";

describe("foundation write status copy", () => {
  it("treats natural-language character rename requests as explicit write requests", () => {
    expect(isExplicitFoundationWriteRequest("hey dont call the hero Lin Che anymore make it Shen Lan")).toBe(true);
    expect(isExplicitFoundationWriteRequest("这主角名字别叫林澈了，换成沈岚吧。")).toBe(true);
    expect(isExplicitFoundationWriteRequest("Lin Che is wrong name should be Shen Lan update the character card")).toBe(true);
  });

  it("does not classify ordinary story discussion as a write request", () => {
    expect(isExplicitFoundationWriteRequest("下一章要更紧张一点，先别写正文")).toBe(false);
    expect(isExplicitFoundationWriteRequest("what should happen next in the chapter?")).toBe(false);
  });

  it("does not treat bare future-oriented wording as an executable foundation write", () => {
    expect(isExplicitFoundationWriteRequest("以后角色的名字要更好听一点")).toBe(false);
    expect(isExplicitFoundationWriteRequest("以后主角的设定可以更复杂一点")).toBe(false);
  });

  it("shows no-write feedback when an explicit foundation write request has no executable suggestion", () => {
    const feedback = buildNoExecutableFoundationChangeFeedback("这主角名字别叫林澈了，换成沈岚吧。");

    expect(feedback.title).toBe("资料修改未完成");
    expect(feedback.summary).toContain("未写入任何文件");
    expect(feedback.summary).toContain("没有生成可确认的资料修改");
    expect(feedback.detail).toContain("写入状态：未写入任何文件");
    expect(feedback.detail).toContain("原因：没有生成可确认的资料修改");
    expect(feedback.detail).not.toContain("write: 无需写入");
  });

  it("recognizes foundation delete requests and explains when no target was found", () => {
    expect(isFoundationDeleteRequest("把多余的角色删掉")).toBe(true);
    expect(isFoundationDeleteRequest("删除那个占位人物资料")).toBe(true);
    expect(isFoundationDeleteRequest("清空左侧草稿")).toBe(false);

    const feedback = buildNoExecutableFoundationChangeFeedback("把多余的角色删掉");

    expect(feedback.title).toBe("没有找到可删除的资料条目");
    expect(feedback.summary).toContain("未写入任何文件");
    expect(feedback.detail).toContain("原因：没有从当前资料里找到与你描述匹配的条目。");
    expect(feedback.detail).not.toContain("暂不支持");
  });

  it("auto-applies natural-language foundation edits without requiring write/save wording", () => {
    expect(shouldAutoApplyFoundationSuggestionsFromChat(
      "hey dont call the hero Lin Che anymore make it Shen Lan",
      [foundationRenameSuggestion()],
    )).toBe(true);
    expect(shouldAutoApplyFoundationSuggestionsFromChat(
      "这主角名字别叫林澈了，换成沈岚吧。",
      [foundationRenameSuggestion()],
    )).toBe(true);
    expect(shouldAutoApplyFoundationSuggestionsFromChat(
      "以后主角都叫沈岚",
      [foundationRenameSuggestion()],
    )).toBe(true);
  });

  it("auto-applies direct agent tasks for assets, locations, world rules, and writing rules", () => {
    expect(shouldAutoApplyFoundationSuggestionsFromChat(
      "给主角加一辆黑色越野车",
      [foundationSuggestion("assets", "create_asset", "story/assets.json", "assets")],
    )).toBe(true);
    expect(shouldAutoApplyFoundationSuggestionsFromChat(
      "新增一个地点：地下诊所",
      [foundationSuggestion("locations", "create_location", "story/location-bible.json", "locations")],
    )).toBe(true);
    expect(shouldAutoApplyFoundationSuggestionsFromChat(
      "把世界观改成末日后第七年",
      [foundationSuggestion("world", "update_world_rule", "story/world-bible.json", "worldPremise")],
    )).toBe(true);
    expect(shouldAutoApplyFoundationSuggestionsFromChat(
      "以后文风更冷一点，少解释",
      [foundationSuggestion("writingRules", "update_writing_rule", "story/writing-rules.json", "proseStyle")],
    )).toBe(true);
    expect(shouldAutoApplyFoundationSuggestionsFromChat(
      "把苏晓薇当前目标改成保护主角",
      [foundationSuggestion("characters", "update_character_detail", "story/character-bible.json", "characters")],
    )).toBe(true);
  });

  it("does not auto-apply destructive foundation requests", () => {
    expect(shouldAutoApplyFoundationSuggestionsFromChat(
      "把主角资料清空重置一下",
      [foundationRenameSuggestion()],
    )).toBe(false);
  });

  it("auto-applies chat delete suggestions for delete requests", () => {
    expect(shouldAutoApplyFoundationSuggestionsFromChat(
      "删除角色苏晓薇",
      [foundationDeleteSuggestion()],
    )).toBe(true);
    expect(shouldAutoApplyFoundationSuggestionsFromChat(
      "把主角资料清空重置一下",
      [foundationDeleteSuggestion()],
    )).toBe(false);
    expect(shouldAutoApplyFoundationSuggestionsFromChat(
      "删除角色苏晓薇",
      [foundationRenameSuggestion()],
    )).toBe(false);
  });

  it("auto-applies on short write commands after a long conversation", () => {
    expect(shouldAutoApplyFoundationSuggestionsFromChat("写入吧", [foundationRenameSuggestion()])).toBe(true);
    expect(shouldAutoApplyFoundationSuggestionsFromChat("都写进去", [foundationRenameSuggestion()])).toBe(true);
    expect(shouldAutoApplyFoundationSuggestionsFromChat("都记下来", [foundationRenameSuggestion()])).toBe(true);
    expect(shouldAutoApplyFoundationSuggestionsFromChat("确认", [foundationRenameSuggestion()])).toBe(true);
    expect(shouldAutoApplyFoundationSuggestionsFromChat("就这些，写入。", [foundationRenameSuggestion()])).toBe(true);
  });

  it("keeps short-command safety boundaries", () => {
    expect(shouldAutoApplyFoundationSuggestionsFromChat("清空资料", [foundationRenameSuggestion()])).toBe(false);
    expect(shouldAutoApplyFoundationSuggestionsFromChat("写入吧", [])).toBe(false);
    expect(shouldAutoApplyFoundationSuggestionsFromChat("我们聊聊主角吧", [foundationRenameSuggestion()])).toBe(false);
  });

  it("builds the full conversation history from workspace messages", () => {
    useWorkspaceStore.setState((state) => ({
      workspace: {
        ...state.workspace,
        messages: [
          { id: "m1", role: "user", content: "主角是个破产富二代" },
          { id: "m2", role: "assistant", content: "好的，24岁，对吧？" },
          { id: "m3", role: "system", content: "系统消息不应进入历史" },
          { id: "m4", role: "user", content: "对，叫林远" },
        ],
      },
    }));

    const conversation = conversationFromWorkspaceMessages();

    expect(conversation).toEqual([
      { role: "user", content: "主角是个破产富二代" },
      { role: "assistant", content: "好的，24岁，对吧？" },
      { role: "user", content: "对，叫林远" },
    ]);
  });

  it("aggregates batch write results by category with undo notice", () => {
    const plan = {
      acceptedSuggestions: [
        { id: "s1", category: "characters" }, { id: "s2", category: "characters" },
        { id: "s3", category: "world" },
        { id: "s4", category: "writingRules" },
      ],
      rejectedSuggestionIds: [],
      deferredSuggestionIds: [],
      skippedConflicts: [],
      fileChanges: [{ targetFile: "story/character-bible.json", summary: "", suggestionIds: ["s1", "s2"] }],
    } as unknown as FoundationGapApplyPlan;
    const writes = [
      { domain: "character", action: "create_character", targetFile: "story/character-bible.json", targetName: "林晚", summary: "" },
      { domain: "character", action: "create_character", targetFile: "story/character-bible.json", targetName: "李青", summary: "" },
      { domain: "world", action: "update_world_rule", targetFile: "story/world-bible.json", summary: "" },
      { domain: "writingRules", action: "update_writing_rule", targetFile: "story/writing-rules.json", summary: "" },
    ] as const;

    const text = foundationApplyResultText(plan, writes as never);

    expect(text).toContain("已写入 4 条资料");
    expect(text).toContain("角色 2 条");
    expect(text).toContain("世界观 1 条");
    expect(text).toContain("写作规则 1 条");
    expect(text).toContain("可撤销");
  });

  it("reports plan-time skipped conflicts honestly without over-counting writes", () => {
    // accepted=2 但只有 1 条真正产生 writes（另一条规划期被冲突拦下）。诚实：报实际写入条数 2，
    // 而非凭 accepted.length 虚报。这里两条都写成了（writes 2 条），冲突是第三条独立 suggestion。
    const plan = {
      acceptedSuggestions: [
        { id: "s1", category: "characters" }, { id: "s2", category: "world" },
      ],
      rejectedSuggestionIds: [],
      deferredSuggestionIds: [],
      skippedConflicts: [{
        id: "s3:write-risk",
        category: "world",
        title: "写入需要明确覆盖确认",
        description: "这次写入会替换已有长期设定，需要用户明确覆盖。",
        targetFile: "story/world-bible.json",
        targetPath: "worldPremise",
        existingValue: "旧设定",
        suggestedValue: "新设定",
        resolutionOptions: ["keep_existing", "replace", "merge", "defer"],
      }],
      fileChanges: [
        { targetFile: "story/character-bible.json", summary: "", suggestionIds: ["s1"] },
        { targetFile: "story/world-bible.json", summary: "", suggestionIds: ["s2"] },
      ],
    } as unknown as FoundationGapApplyPlan;
    const writes = [
      { domain: "character", action: "create_character", targetFile: "story/character-bible.json", targetName: "林晚", summary: "" },
      { domain: "world", action: "update_world_rule", targetFile: "story/world-bible.json", summary: "" },
    ] as const;

    const text = foundationApplyResultText(plan, writes as never);

    expect(text).toContain("已写入 2 条资料");
    expect(text).toContain("另有 1 条这次没有写入");
  });

  it("改2: does not over-report write count when an accepted suggestion was skipped at write time", () => {
    // 多选部分写入：接受 2 条，s1(角色)写成、s2(角色)缺 targetId 在写入期被 skip。
    // 旧逻辑用 accepted.length=2 谎报「已写入 2 条」；现按真实 writes 推导，只报 1 条写入 + 1 条没写入。
    const plan = {
      acceptedSuggestions: [
        { id: "s1", category: "characters" }, { id: "s2", category: "characters" },
      ],
      rejectedSuggestionIds: [],
      deferredSuggestionIds: [],
      skippedConflicts: [],
      fileChanges: [{ targetFile: "story/character-bible.json", summary: "", suggestionIds: ["s1", "s2"] }],
    } as unknown as FoundationGapApplyPlan;
    const writes = [
      { domain: "character", action: "update_character_detail", targetFile: "story/character-bible.json", targetId: "char-lin-wan", targetName: "林晚", summary: "" },
    ] as const;
    const skippedWrites: readonly FoundationGapSkippedWrite[] = [{
      suggestionId: "s2",
      reason: "missing_target_id",
      action: "update_character_detail",
      targetName: "李青",
      summary: "没能定位到「李青」对应的角色卡片，本次未写入任何内容。",
    }];

    const text = foundationApplyResultText(plan, writes as never, skippedWrites);

    expect(text).not.toContain("已写入 2 条");
    expect(text).toContain("写入 1 条");
    expect(text).toContain("1 条没能写入");
    // 采用引擎算好的精确原因（含真实角色名），而非通用句。
    expect(text).toContain("李青");
  });

  it("改1: adopts engine skippedWrites summary (with real character name) when nothing was written", () => {
    // apply 返回 writes 为空 + skippedWrites（带角色名的精确原因）→ 文案采用 summary，
    // 不再用硬编码「没能定位到这条资料对应的卡片」的通用句。
    const plan = {
      acceptedSuggestions: [{ id: "s1", category: "characters" }],
      rejectedSuggestionIds: [],
      deferredSuggestionIds: [],
      skippedConflicts: [],
      fileChanges: [{ targetFile: "story/character-bible.json", summary: "", suggestionIds: ["s1"] }],
    } as unknown as FoundationGapApplyPlan;
    const skippedWrites: readonly FoundationGapSkippedWrite[] = [{
      suggestionId: "s1",
      reason: "target_not_found",
      action: "update_character_detail",
      targetName: "沈砚",
      summary: "没能在角色资料里找到「沈砚」，本次未写入任何内容。",
    }];

    const text = foundationApplyResultText(plan, [], skippedWrites);

    expect(text).toContain("沈砚");
    expect(text).toContain("没能在角色资料里找到");
    expect(text).not.toContain("没能定位到这条资料对应的卡片");
    expect(text).not.toContain("已修改");
    expect(text).not.toContain("可撤销");
  });

  it("does not claim success when an accepted suggestion wrote nothing (no targetId)", () => {
    // 真机 bug：update_character_detail 缺 targetId → writes:[]，但 plan.fileChanges 仍有
    // story/character-bible.json，旧逻辑据此谎报「已修改/可撤销」。
    const plan = {
      acceptedSuggestions: [{ id: "s1", category: "characters" }],
      rejectedSuggestionIds: [],
      deferredSuggestionIds: [],
      skippedConflicts: [],
      fileChanges: [{ targetFile: "story/character-bible.json", summary: "", suggestionIds: ["s1"] }],
    } as unknown as FoundationGapApplyPlan;

    const text = foundationApplyResultText(plan, []);

    expect(text).not.toContain("已修改");
    expect(text).not.toContain("已写入");
    expect(text).not.toContain("可撤销");
    expect(text).toContain("未写入任何");
  });

  it("renders concrete field lines for generated foundation suggestion previews", () => {
    const text = foundationSuggestionPreviewText([foundationCreateCharacterSuggestion()]);

    expect(text).toContain("【创建角色「林远」 — 破产富二代（主角）】");
    expect(text).toContain("名字：林远");
    expect(text).toContain("身份：破产富二代");
    expect(text).toContain("欲望：夺回家族控制权");
    expect(text).toContain("恐惧：再次失去仅剩的亲人");
  });

  it("uses concise product copy for direct non-character writes", () => {
    const text = foundationWritesResultText([
      {
        domain: "asset",
        action: "create_asset",
        targetFile: "story/assets.json",
        targetId: "asset-car",
        targetName: "黑色越野车",
        summary: "已加入资产账本",
      },
    ]);

    expect(text).toContain("已把黑色越野车加入道具与资源。");
    expect(text).toContain("可撤销本次修改");
    expect(text).not.toContain("对象：");
    expect(text).not.toContain("位置：");
    expect(text).not.toContain("story/assets.json");
  });

  it("uses concise product copy for direct character detail updates", () => {
    const text = foundationWritesResultText([
      {
        domain: "character",
        action: "update_character_detail",
        targetFile: "story/character-bible.json",
        targetId: "lin-xiaowei",
        targetName: "苏晓薇",
        summary: "已更新角色资料",
      },
    ]);

    expect(text).toContain("已更新苏晓薇的角色资料。");
    expect(text).toContain("可撤销本次修改");
    expect(text).not.toContain("对象：");
    expect(text).not.toContain("位置：");
    expect(text).not.toContain("story/character-bible.json");
  });

  it("reports new custom fields by card name when the engine created them", () => {
    const text = foundationWritesResultText([
      {
        domain: "character",
        action: "update_character_detail",
        targetFile: "story/character-bible.json",
        targetId: "lin-wan",
        targetName: "林晚",
        summary: "已更新角色资料",
        newExtraFields: ["境界", "功法"],
      },
    ]);

    expect(text).toContain("已更新林晚的角色资料。");
    expect(text).toContain("为「林晚」新增自定义字段：境界、功法");
    expect(text).toContain("可撤销本次修改");
    // 如实回报，纯中文，不暴露英文 key 或文件路径。
    expect(text).not.toContain("newExtraFields");
    expect(text).not.toContain("story/character-bible.json");
  });

  it("reports new custom fields for direct asset writes too, naming the card", () => {
    const text = foundationWritesResultText([
      {
        domain: "asset",
        action: "create_asset",
        targetFile: "story/assets.json",
        targetId: "asset-sword",
        targetName: "斩魂剑",
        summary: "已加入资产账本",
        newExtraFields: ["品阶"],
      },
    ]);

    expect(text).toContain("已把斩魂剑加入道具与资源。");
    expect(text).toContain("为「斩魂剑」新增自定义字段：品阶");
  });

  it("aggregated batch writes still report any new custom fields", () => {
    const plan = {
      acceptedSuggestions: [
        { id: "s1", category: "characters" }, { id: "s2", category: "characters" },
      ],
      rejectedSuggestionIds: [],
      deferredSuggestionIds: [],
      skippedConflicts: [],
      fileChanges: [{ targetFile: "story/character-bible.json", summary: "", suggestionIds: ["s1", "s2"] }],
    } as unknown as FoundationGapApplyPlan;
    const writes = [
      { domain: "character", action: "create_character", targetFile: "story/character-bible.json", targetName: "林晚", summary: "", newExtraFields: ["境界"] },
      { domain: "character", action: "create_character", targetFile: "story/character-bible.json", targetName: "李青", summary: "" },
    ] as const;

    const text = foundationApplyResultText(plan, writes as never);

    expect(text).toContain("已写入 2 条资料");
    expect(text).toContain("为「林晚」新增自定义字段：境界");
  });

  it("uses concise delete copy with the touched file count", () => {
    const text = foundationWritesResultText([
      {
        domain: "character",
        action: "delete_foundation_entry",
        targetFile: "story/character-bible.json",
        targetId: "lin-xiaowei",
        targetName: "苏晓薇",
        summary: "已删除角色「苏晓薇」",
      },
      {
        domain: "character",
        action: "delete_character_matrix_entry",
        targetFile: "story/character-matrix.json",
        targetId: "lin-xiaowei",
        targetName: "苏晓薇",
        summary: "已移除对应的角色矩阵条目",
      },
      {
        domain: "character",
        action: "delete_character_file",
        targetFile: "characters/lin-xiaowei/profile.json",
        targetId: "lin-xiaowei",
        targetName: "苏晓薇",
        summary: "已删除 characters/lin-xiaowei/profile.json",
      },
    ]);

    expect(text).toContain("已删除角色「苏晓薇」");
    expect(text).toContain("3 个文件");
    expect(text).toContain("可撤销本次修改");
  });

  it("detects delete confirmation conflicts in an apply plan", () => {
    const plan = {
      acceptedSuggestions: [],
      rejectedSuggestionIds: [],
      deferredSuggestionIds: [],
      skippedConflicts: [{
        id: "ai-delete-1:write-risk",
        category: "characters",
        title: "写入需要明确覆盖确认",
        description: "delete_needs_explicit_confirm:第3章、第5章",
        targetFile: "story/character-bible.json",
        targetPath: "$",
        existingValue: undefined,
        suggestedValue: null,
        resolutionOptions: ["keep_existing", "replace", "merge", "defer"],
      }],
      fileChanges: [],
    } as unknown as FoundationGapApplyPlan;

    const conflicts = foundationDeleteConfirmationConflicts(plan);
    expect(conflicts).toHaveLength(1);

    const text = foundationDeleteConfirmText(conflicts);
    expect(text).toContain("第3章、第5章");
    expect(text).toContain("确认");

    expect(foundationDeleteConfirmationConflicts(null)).toEqual([]);
  });

  it("explains blocked deletes in plain language", () => {
    const blockedPlan = {
      acceptedSuggestions: [],
      rejectedSuggestionIds: [],
      deferredSuggestionIds: [],
      skippedConflicts: [{
        id: "ai-delete-2:write-risk",
        category: "characters",
        title: "写入被保护策略拦截",
        description: "cannot_delete_protagonist",
        targetFile: "story/character-bible.json",
        targetPath: "$",
        existingValue: undefined,
        suggestedValue: null,
        resolutionOptions: ["keep_existing", "replace", "merge", "defer"],
      }],
      fileChanges: [],
    } as unknown as FoundationGapApplyPlan;

    expect(foundationDeleteBlockedText(blockedPlan)).toContain("主角不能删除");

    const notFoundPlan = {
      ...blockedPlan,
      skippedConflicts: [{ ...blockedPlan.skippedConflicts[0], description: "delete_target_not_found" }],
    } as unknown as FoundationGapApplyPlan;
    expect(foundationDeleteBlockedText(notFoundPlan)).toContain("没有找到要删除的资料条目");

    expect(foundationDeleteBlockedText(null)).toBeUndefined();
  });
});

function foundationRenameSuggestion(): FoundationGapSuggestion {
  return {
    id: "suggestion-character-rename",
    gapId: "gap-character-rename",
    category: "characters",
    actionType: "rename_character",
    targetFile: "story/character-bible.json",
    targetPath: "characters.name",
    targetId: "lin-che",
    before: "林澈",
    after: { name: "沈岚" },
    rationale: "用户要求修改角色名字。",
    risk: "info",
    requiresUserConfirm: true,
    sourceUserMessage: "这主角名字别叫林澈了，换成沈岚吧。",
  };
}

function foundationDeleteSuggestion(): FoundationGapSuggestion {
  return {
    id: "suggestion-delete-character",
    gapId: "gap-delete-character",
    category: "characters",
    actionType: "delete_foundation_entry",
    targetFile: "story/character-bible.json",
    targetPath: "$",
    targetId: "lin-xiaowei",
    before: { name: "苏晓薇" },
    after: null,
    rationale: "用户要求删除角色。",
    risk: "warning",
    requiresUserConfirm: true,
    sourceUserMessage: "删除角色苏晓薇",
    extractedEntityName: "苏晓薇",
  };
}

function foundationCreateCharacterSuggestion(): FoundationGapSuggestion {
  return {
    id: "suggestion-create-guoxu",
    gapId: "gap-create-guoxu",
    category: "characters",
    actionType: "create_character",
    targetFile: "story/character-bible.json",
    targetPath: "characters",
    targetId: "guo-xu",
    before: undefined,
    after: {
      bibleEntry: {
        id: "guo-xu",
        name: "林远",
        role: "主角",
        identity: "破产富二代",
        desire: "夺回家族控制权",
        fear: "再次失去仅剩的亲人",
      },
    },
    rationale: "用户要求生成主角设定。",
    risk: "info",
    requiresUserConfirm: true,
  };
}

function foundationSuggestion(
  category: FoundationGapSuggestion["category"],
  actionType: FoundationGapSuggestion["actionType"],
  targetFile: string,
  targetPath: string,
): FoundationGapSuggestion {
  return {
    id: `suggestion-${actionType}`,
    gapId: `gap-${actionType}`,
    category,
    actionType,
    targetFile,
    targetPath,
    targetId: `${actionType}-1`,
    before: undefined,
    after: actionType === "update_world_rule" || actionType === "update_writing_rule" ? ["规则文本"] : { id: `${actionType}-1`, name: "测试项" },
    rationale: "用户明确要求修改资料。",
    risk: "info",
    requiresUserConfirm: true,
  };
}
