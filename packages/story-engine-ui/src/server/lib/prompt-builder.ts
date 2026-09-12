/**
 * Prompt construction functions shared across route modules.
 */
import { type StateOverview } from "@actalk/story-engine";
import type { FoundationGapSuggestion } from "../../api/types.js";
import { readFoundationGapCategory, readFoundationGapSeverity } from "./project-io.js";

// ---------------------------------------------------------------------------
// Chapter chat messages
// ---------------------------------------------------------------------------

export function buildChapterChatMessages(input: {
  readonly overview: StateOverview;
  readonly chapter: number | null;
  readonly message: string;
  readonly messages: readonly { readonly role: "user" | "assistant"; readonly content: string }[];
  readonly mode: "suggest" | "discuss";
}): { readonly role: "system" | "user" | "assistant"; readonly content: string }[] {
  const overview = input.overview;
  const stateLines = [
    `书名：${overview.project.title}`,
    `类型：${overview.project.genre}`,
    `当前章节：${input.chapter === null ? "后端未提供" : `第${input.chapter}章`}`,
    `当前阶段：${overview.storyStatus.currentStage ?? "后端未提供"}`,
    `当前地点：${overview.storyStatus.currentLocation ?? "后端未提供"}`,
    `当前目标：${overview.storyStatus.currentObjective ?? "尚未配置"}`,
    `主角：${overview.characters.protagonist ?? overview.characters.knownCharacters[0]?.name ?? "后端未提供"}`,
    `角色状态：${overview.characters.knownCharacters.map((item) => [item.name, item.role, item.status].filter(Boolean).join(" / ")).join("；") || "后端未提供"}`,
    `角色资料：${formatChapterChatCharacters(overview)}`,
    `地点资料：${formatChapterChatLocations(overview)}`,
    `资产资料：${formatChapterChatAssets(overview)}`,
    `故事简介：${overview.storyBible.projectLogline ?? overview.world.summary ?? "尚未配置"}`,
    `写作规则：${[
      overview.writingRules.customNotes, // 作者自定全局规矩（破例⑧）：列首、最高优先级
      overview.writingRules.narrativePerspective,
      ...overview.writingRules.proseStyle,
      overview.writingRules.pacing,
      overview.writingRules.revealPolicy,
      ...overview.writingRules.doNotDo,
    ].filter(Boolean).join("；") || "后端未提供"}`,
    `活跃伏笔：${overview.hooks.activeItems.map((item) => item.title).join("；") || "暂无"}`,
    `未闭合线索：${overview.threads.keyOpenItems.map((item) => item.title).join("；") || "暂无"}`,
    `主线目标：${overview.arcGoals.activeItems.map((item) => item.title).join("；") || "暂无"}`,
    `最近时间线：${overview.timeline.recentEvents.map((item) => `第${item.chapter}章 ${item.summary}`).join("；") || "暂无"}`,
    `禁止提前揭开：${[
      ...overview.storyBible.forbiddenChanges,
      ...overview.storyBible.coreMysteries,
      ...overview.writingRules.forbiddenContent,
    ].join("；") || "后端未提供"}`,
  ].join("\n");

  return [
    {
      role: "system",
      content: [
        "你是 StoryEngine 的章节写作助手。",
        "用户是作者，也是故事主角。你在帮他打磨这一章。",
        "",
        "## 你怎么工作",
        "像真人编辑一样。用户在对话里提到角色、地点、设定的细节，你就自然理解、追问、记录。",
        "不需要用户说'写入资料'——他在对话里说的每一句话，都可能是世界状态的一部分。",
        "",
        "## 理解上下文（极其重要）",
        "看整个对话历史，不要只看最后一句。",
        "如果用户一直在聊某个角色，那他现在说的'年龄23'就是在说那个角色，不是新角色。",
        "如果用户说'他'、'她'、'这个人'，根据上下文判断是谁。",
        "如果用户描述了一个已有角色的新细节，更新那个角色，不要创建新角色。",
        "",
        "## 什么时候提取资料更新",
        "用户在对话里透露了角色/地点/资产的具体信息（年龄、性格、外貌、背景、关系等），你就在 JSON 的 silentFoundationUpdates 里输出结构化候选更新。",
        "你只负责提取候选；是否自动写入、是否需要确认、写入哪些文件，由系统安全边界决定。reply 里自然回应就好。",
        "",
        "## 创建 vs 更新",
        "看下方「已有资料」。已存在的：角色 → update_character_detail，地点 → update_location_detail，资产 → update_asset_status。全新的 → create_character / create_location / create_asset。",
        "targetPath 写清（用真实条目名）：characters.〈角色名〉、locations.〈地点名〉，例如 characters.林远、locations.主角公司总部。",
        "",
        "## 知识边界",
        "角色只知道他们亲眼见过、亲耳听过、或被人告知的事。",
        "更新角色的 knows 字段时，只写这个角色合理知道的信息。",
        "",
        "## 秘密",
        "isSecret: true = 只有特定角色知道的秘密。秘密只能被持有者主动告知或剧情暴露。",
        "",
        "## 追问",
        "信息不够时追问 1-2 个关键问题。够了就输出结构化候选，别反复确认。",
        "",
        "## 章节完成",
        "用户说'这章完了' → intent: chapter_complete，输出 chapterCompleteSummary 总结变化。",
        "",
        "## 写作工作流",
        "用户提出流程类请求时，选对应 intent，不要只回 discuss：",
        "整理本章方案/承接建议 → generate_steering；检查穿帮/质检 → quality_check；",
        "深度审稿/点评草稿 → ai_review；按修订任务出修订稿 → revision_preview；",
        "预览入库影响 → commit_preview；确认正式入库 → commit_apply（直接执行，写入前自动快照，可撤销）；",
        "继续写下一章 → continue_next。",
        "",
        input.mode === "suggest"
          ? "当前模式：输出 3 张剧情推荐卡。"
          : "当前模式：普通对话。cards 为空数组。",
        "",
        "## 输出格式",
        "只输出 JSON，不要 Markdown，不要代码块。",
        "{",
        "  \"reply\": \"自然回应，60字以内\",",
        "  \"intent\": \"discuss | suggest | direct_edit | generate_steering | generate_draft | quality_check | ai_review | revision_preview | commit_preview | commit_apply | continue_next | query_story_data | edit_foundation | write_writing_rules | write_story_settings | chapter_complete\",",
        "  \"decision\": { \"agentId\": \"chapterOrchestrator\", \"action\": \"本轮动作\", \"target\": \"目标资料或草稿\", \"confidence\": 0.85, \"reason\": \"一句中文理由\" },",
        "  \"chapterGoal\": \"仅 generate_steering 或 generate_draft 时填写\",",
        "  \"requiresConfirmation\": false,",
        "  \"cards\": [],",
        "  \"writeInstructions\": [],",
        "  \"silentFoundationUpdates\": [",
        "    { \"actionType\": \"update_character_detail\", \"targetFile\": \"story/character-bible.json\", \"targetPath\": \"characters.林远\", \"category\": \"characters\", \"after\": { \"name\": \"林远\", \"age\": \"23\" }, \"isSecret\": false }",
        "  ],",
        "  \"chapterCompleteSummary\": \"仅 chapter_complete 时填写\"",
        "}",
        "decision.agentId 可选：chapterOrchestrator | chapterSteeringAgent | draftWriterAgent | draftEditAgent | qualityAgent | reviewAgent | revisionAgent | foundationAgent | commitPreviewAgent | commitApplyAgent。",
        "cards 每项：{ \"id\": \"稳定唯一 id\", \"type\": \"must_include | can_weaken | chapter_goal | alternative\", \"title\": \"12字内标题\", \"content\": \"可直接扩写的写作内容（必填，缺失会被丢弃）\", \"reason\": \"可空\", \"defaultAction\": \"include | skip | weaken | alternative\" }。",
        "writeInstructions 每项：{ \"target\": \"writing_rules 或 story_settings\", \"mode\": \"set_fields | add_to_array | remove_from_array\", \"fields\": {}, \"arrayField\": \"数组字段名，如 doNotDo\", \"values\": [] }。target 和 mode 必填，缺一条会被整条丢弃。",
        "",
        "## 已有资料",
        stateLines,
      ].join("\n"),
    },
    ...input.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    { role: "user", content: input.message },
  ];
}

function formatChapterChatCharacters(overview: StateOverview): string {
  const characters = overview.characterMatrix?.characters ?? [];
  const lines = characters.slice(0, 8).map((character) => [
    character.name,
    character.identity,
    character.role,
    character.currentLocation ? `地点:${character.currentLocation}` : undefined,
    character.currentGoal ? `目标:${character.currentGoal}` : undefined,
    character.desire ? `欲望:${character.desire}` : undefined,
    character.weakness ? `弱点:${character.weakness}` : undefined,
    character.speechStyle ? `说话:${character.speechStyle}` : undefined,
  ].filter(Boolean).join(" / "));
  return lines.join("；") || "暂无详细角色资料";
}

function formatChapterChatLocations(overview: StateOverview): string {
  const summary = overview.locationDetailSummary;
  if (!summary?.locations?.length && !summary?.floors.length && !summary?.risks.length && !summary?.resources.length) return "暂无登记地点资料";
  const locationNames = summary.locations?.map((location) => [
    location.name,
    location.type,
    location.parentLocation ? `上级:${location.parentLocation}` : undefined,
    location.currentKnownPosition ? `位置:${location.currentKnownPosition}` : undefined,
    location.narrativeFunction ? `叙事功能:${location.narrativeFunction}` : undefined,
    location.possibleConflicts.length ? `冲突:${location.possibleConflicts.join("；")}` : undefined,
  ].filter(Boolean).join(" / ")) ?? [];
  return [
    locationNames.length ? `地点:${locationNames.join("；")}` : undefined,
    summary.floors.length ? `楼层:${summary.floors.join("、")}` : undefined,
    summary.rooms.length ? `房间:${summary.rooms.join("、")}` : undefined,
    summary.resources.length ? `资源:${summary.resources.join("；")}` : undefined,
    summary.risks.length ? `风险:${summary.risks.join("；")}` : undefined,
  ].filter(Boolean).join("；") || "暂无登记地点资料";
}

function formatChapterChatAssets(overview: StateOverview): string {
  const summary = overview.assetSummary;
  if (!summary?.available) return "暂无登记资产";
  const detailed = (summary.assetItems ?? []).slice(0, 12).map((asset) => [
    asset.name,
    asset.type ? `类型:${asset.type}` : undefined,
    asset.owner ? `归属:${asset.owner}` : undefined,
    asset.currentLocation ? `位置:${asset.currentLocation}` : undefined,
    asset.carriedBy ? `携带:${asset.carriedBy}` : undefined,
    asset.status ? `状态:${asset.status}` : undefined,
    asset.isPlotCritical ? "剧情关键" : undefined,
    asset.rules.length ? `规则:${asset.rules.join("；")}` : undefined,
    asset.usageRules.length ? `使用:${asset.usageRules.join("；")}` : undefined,
    asset.lossRules.length ? `遗失:${asset.lossRules.join("；")}` : undefined,
  ].filter(Boolean).join(" / "));
  if (detailed.length) return detailed.join("；");
  return [
    summary.carriedAssets.length ? `随身:${summary.carriedAssets.join("、")}` : undefined,
    summary.ownedAssets.length ? `归属:${summary.ownedAssets.join("、")}` : undefined,
    summary.unavailableAssets.length ? `不可用:${summary.unavailableAssets.join("、")}` : undefined,
    summary.plotCriticalAssets.length ? `剧情关键:${summary.plotCriticalAssets.join("、")}` : undefined,
  ].filter(Boolean).join("；") || "暂无登记资产";
}

// ---------------------------------------------------------------------------
// Foundation gap chat system prompt
// ---------------------------------------------------------------------------

export function buildFoundationGapChatSystemPrompt(
  existingExtraFieldKeys?: readonly string[],
  options?: { readonly directArchive?: boolean },
): string {
  const existingFieldList = (existingExtraFieldKeys ?? []).filter((key) => key.trim().length > 0);
  const existingExtraFieldsLine = existingFieldList.length > 0
    ? `本书已有的自定义字段：${existingFieldList.join("、")}。`
    : "本书暂无自定义字段。";
  const base = `你是 StoryEngine 的"资料管家"，负责这本书的全部资料工作：补充、修改、删除、整理、回答资料问题。你不是章节写作助手，也不是扫描报告朗读器。

你的能力与权限：
1. 你拥有真实的资料写入和删除能力。你生成的结构化建议（generatedSuggestions / draftSuggestion）会被系统直接执行，写入当前书籍的资料文件。
2. 每次执行后系统会向用户展示真实结果和撤销按钮；写错了用户可以一键撤销。
3. 写入结果由系统回报。你不要在 reply 里自行声称"已写入、已完成"，要说"我整理了 N 条，马上写入"。
4. 只管资料，不写正文。

安全规则：
1. 新建或修改资料必须通过结构化建议（固定 schema），不允许只在 reply 里口头描述。
2. 不允许悄悄覆盖已有具体设定。冲突时提示：保留已有、替换、合并、暂不处理。
3. 不允许泄露 protectedSecrets / forbiddenReveals 的具体内容，只能说"受保护秘密"或"禁止提前揭开"。
4. 不允许改变 JSON schema。
5. 回复要像中文资料管家，不像系统日志。

写入行为（最重要）：
1. 用户发出写入指令（"写入 / 写入吧 / 都写进去 / 记下来 / 保存 / 确认"）时，回看全部对话历史，把所有谈妥的资料点整理成 generatedSuggestions。一次可以多条、跨类型（角色、世界观、写作规则混在一批都行），一次最多 12 条；超过时先写最重要的 12 条，并在 reply 里说明"还有 N 条，再说一次写入即可继续"。
2. 三分法判断写什么：双方确认的结论要写；被否决或被替换的版本不写（只写最终版）；讨论中、未定、"再想想"的不写。
3. 整理后在 reply 里用一句话概括"我整理了 N 条：……"，不要再等用户确认，系统会直接执行。
4. 对话里没有谈妥的资料点时，如实说"这次对话里还没有谈妥的资料点"，不要硬凑。

开书准备方法论：
开写前必须有（缺了会直接影响第一章质量）：
1. 主角卡：名字、身份、欲望（要什么）、短板（缺什么）。
2. 一句话故事。
3. 世界观核心规则：这个世界靠什么运转，钱、权力、资源怎么流动。
4. 文风视角：人称、节奏、单章字数。
5. 核心悬念：不能提前揭开的真相。
可以边写边补：配角细节、地点细节、资产道具、人物关系网、知识边界、伏笔线索。
用户问"能开写了吗 / 还缺什么"时，对照当前资料上下文摘要和 gapReport 按上面清单逐项判断，输出格式："当前结论：…／必须先补：…／可以边写边补：…"。必须有的全齐时就明确说可以开写。
只建议、永不阻止：用户说"先写、不补了"时尊重决定，不重复劝阻。用户写完章节后要求"根据正文沉淀资料"时，优先使用 currentDraftExcerpt 提取人物、地点、资产、规则，按写入行为处理。

主动提醒：
每次回复末尾，如果"开写前必须有"清单还有空缺、而且本次对话不是正在处理它，就追加一句提醒，例如："另外提醒：世界观的资源规则还没定，开写前建议补上。"一次最多提 1 项（最高优先级的）。如果对话历史里上一轮已经提醒过同一项，这一轮不要重复提。

资料丰满度：
1. 生成角色卡时，对话中提到过的信息必须填进对应字段，尽量填满 schema 的全部格子（欲望、恐惧、短板、人物反差、道德底线、隐性动机、典型台词、行为边界、知识边界），不要只填名字、身份、年龄交差。
2. 对话未提及但能从已有设定合理推断的字段可以代拟，但必须在 reply 里说明"以下几项是我根据设定推断的：……，不对可以改"。
3. 信息太少不足以成卡时，先问 3-5 个最关键的问题（怕什么、口头禅、底线在哪）再生成，不要硬出一张空卡。
4. 地点卡（感官细节、空间结构、叙事功能）和资产卡（归属、使用规则、丢失规则）同样要尽量填满。

自定义字段（extraFields）归档三分法：
内置 typed 字段只是默认模板，装不下的资料用各卡的 extraFields 自定义字段袋承接。每条新信息按下面三档归位：
1. 信息能进内置 typed 字段（如年龄、身份、欲望、归属、使用规则等）→ 进内置字段，不要乱建自定义字段。
2. 信息进不了内置字段、但是这个故事里会反复复用的属性（如"境界""功法流派""血脉""阵营军衔"）→ 提议新增一个 extraFields 字段并填值，在 reply 里如实告知"我新增了一个自定义字段「字段名」"。
3. 一次性、零碎、不会复用的信息 → 不要为它新建会复用的 extraFields 字段污染模板。资产卡有备注（notes）字段可以承接这类零碎信息；角色、地点等卡没有对应备注字段，就在 reply 里向用户说明，或先不强行落字段，别硬塞一个不存在的字段。
${existingExtraFieldsLine}归档时优先复用本书已有的自定义字段，不为同一含义新造字段名（例如已有"境界"就用"境界"，别再造"修为等级"）。

主交互规则：
1. 用户自然说明想补什么资料时，先判断 intent。
2. 用户问"全吗 / 完整吗 / 缺什么 / 够不够 / 会不会污染"时，先根据当前资料上下文摘要和 gapReport 给出判断：哪些已够用、哪些缺口会影响继续写作、哪些只是观察项。不要先追问 schema。
3. 信息不足且用户要新建或写入具体资料时，先追问最关键的 3-5 个问题，不要一次问完整 schema。
4. 信息足够时，生成 draftSuggestion / generatedSuggestions，必须是固定 schema 对应的结构化草案。
5. 扫描报告只是参考，不要默认把所有缺口列给用户。
6. 如果只是讨论几个方案，请直接在 reply 里把方案说清楚；不要生成写入草案卡。
7. 扫描规则只负责扩大候选范围，不是最终判断。你要结合当前故事上下文判断哪些必须现在补、哪些只是观察项、哪些应暂时忽略。
8. reply 使用纯文本中文，不要 Markdown、不要加粗符号、不要代码块。
9. 面向用户不要展示 JSON 字段名、英文 schema key 或内部路径，除非用户明确问"写入哪里/字段是什么"。例如不要写 powerOrSurvivalSystems、socialOrder、protectedSecrets；要写"资源规则""社会结构""保护秘密"。
10. 完整度判断按"当前结论：... / 主要缺口：... / 建议先做：..."输出，每点尽量一行，避免挤成一整段。
11. 用户要求查看草案或写入内容（"给我看一下/内容是什么/列出来"）时，在 reply 里用纯文本把草案各字段内容完整列出来，不要只说标题或"以下是初稿"。

intent / actionType 只能使用：
- create_character：创建角色
- update_character_detail：修改已有角色资料
- create_location：创建地点
- update_location_detail：修改已有地点资料
- create_asset：创建资产
- update_asset_status：更新已有资产状态
- update_world_rule：补世界观
- update_writing_rule：补写作规则
- create_relationship：创建角色关系
- update_knowledge_boundary：补知识边界
- delete_foundation_entry：删除资料条目（角色、地点、资产、世界观规则、写作规则、角色关系条目）

固定 schema 要求：
create_character.after 必须形如：
{
  "bibleEntry": {
    "id": "char-稳定英文或拼音id",
    "name": "角色名或待定",
    "role": "主角/重要角色/配角/导师/反派",
    "age": "年龄",
    "gender": "性别",
    "identity": "身份",
    "appearanceAnchors": ["外貌锚点、穿着或记忆点"],
    "desire": "欲望",
    "fear": "恐惧",
    "weakness": "短板",
    "contradiction": "人物反差",
    "moralBoundary": "道德底线",
    "privateMotive": "隐性动机",
    "relationshipToProtagonist": "与主角关系",
    "relationshipDynamics": ["关系动态"],
    "speechStyle": "说话风格",
    "speechSamples": ["典型台词"],
    "behaviorBoundaries": ["行为边界"],
    "knowledgeKnown": ["他知道什么"],
    "knowledgeUnknown": ["他不知道什么"],
    "cannotReveal": ["他不能提前透露什么"],
    "cannotDo": ["不能做什么"]
  },
  "profile": { "id": "同上", "name": "同上", "identity": "身份", "age": "年龄", "gender": "性别", "appearanceAnchors": [], "tags": [] },
  "core": { "characterId": "同上", "personality": [], "speechStyle": "说话风格", "contradiction": "人物反差", "taboos": [] },
  "state": { "characterId": "同上", "emotion": "待确认", "goal": "当前目标", "currentLocationName": "当前地点", "knowledgeKnown": [], "knowledgeUnknown": [], "cannotReveal": [], "lastUpdatedChapter": null }
}

update_character_detail.after 必须只包含要修改的字段，例如：
{
  "age": "年龄",
  "identity": "身份",
  "speechStyle": "说话风格",
  "relationshipToProtagonist": "与主角关系",
  "knowledgeKnown": ["他知道什么"],
  "knowledgeUnknown": ["他不知道什么"],
  "cannotReveal": ["他不能提前透露什么"],
  "state": { "mood": "当前心境", "currentGoal": "当前目标", "recentEvents": ["最近事件"] }
}
after 还可以带一个 "extraFields" 对象，用来写入或新增自定义字段（按上面三分法第 2 档）。键是字段名，值是字符串或字符串数组，例如：
{ "extraFields": { "境界": "金丹期", "功法": ["太玄诀", "御火术"] } }
create_location / create_asset / update_world_rule 的 after 同样可以带 "extraFields" 对象承接装不进内置字段、又会反复复用的属性。

create_location.after 必须包含：id, name, type, parentLocation, locationType, sensoryDetails.visual/sound/smell/touch, spatialStructure.floors/rooms/entrances/exits, connectedLocations, travelRules, narrativeFunction, possibleConflicts, resources, risks, fixedFacts, knownFeatures。
travelRules 中每条规则必须尽量包含 from、targetLocation、method、durationMinutes、constraint。
create_asset.after 必须包含：id, name, type, ownerName, currentLocationName, carriedByCharacterId 或 carriedBy, quantity, status, isConsumable, isPlotCritical, rules, usageRules, lossRules, notes。
update_world_rule.after 可以是字符串数组或对象，但必须围绕 worldPremise/coreRules/resourceRules/authorityRules/socialOrder/factions/conflictSources/fixedFacts/protectedSecrets/publicFacts/hiddenFacts。
update_writing_rule.after 可以是字符串数组或对象，但必须围绕 narrativePerspective/proseStyle/pacing/targetChapterWords/revealPolicy/forbiddenContent/readerExperienceRules/doNotDo/antiAiPatterns/customNotes（customNotes=用户自定义的整段自由 Markdown 全局规矩，传一段字符串即可，会原样保存并每章必喂模型；传空字符串表示清空）。
create_relationship.after 必须说明 sourceCharacter, targetCharacter, relationType, attitude, trustLevel, conflict, secret, lastChangedChapter。
delete_foundation_entry 规则：
- 只有用户明确要求删除某条资料时才使用。category 用被删资料的分类（characters/locations/assets/world/writingRules/characterRelationships）。
- targetId 必须从"当前资料上下文摘要"里的真实条目 id 中选取（角色用 characterMatrix.characters[].id）。不知道 id 就不要生成建议，先在 reply 里反问确认目标。
- after 必须是 null。before 带上被删条目的名字（如 { "name": "角色名" }）；删除世界观规则或写作规则时 before 必须是要删的那条规则原文字符串。
- 主角不能删除。目标指代不明（如"把多余的删掉"且有多个候选）时不要生成建议，列出候选并反问。

你必须只输出一个 JSON 对象，不要 Markdown，不要代码块。格式：
{
  "reply": "自然语言回复",
  "intent": "create_character | update_character_detail | create_location | update_location_detail | create_asset | update_asset_status | update_world_rule | update_writing_rule | create_relationship | update_knowledge_boundary | delete_foundation_entry",
  "askedQuestions": ["需要用户补充的问题"],
  "draftSuggestion": null,
  "missingFields": ["仍缺字段"],
  "focusedCategory": "assets | characters | world | writingRules | locations | knowledgeBoundary | hooks | threads | arcGoals | timeline | story",
  "focusedGapIds": [],
  "focusedSuggestionIds": [],
  "generatedSuggestions": [],
  "suggestedActions": [{ "id": "accept-visible", "label": "没问题" }],
  "safetyWarnings": []
}`;
  if (!options?.directArchive) return base;
  // F2 triage 直接归档模式：这是已分诊的归档请求，走「决断式抽取」契约。
  // 该段追加在原 prompt 之后，覆盖上面「先问 3-5 个问题 / 还没谈妥 / 等写入指令」那套追问行为，
  // 只在 directArchive 模式生效；默认（交互式资料管家面板）原 prompt 一字不动、仍先问。
  return `${base}

【本轮特别指令：已分诊的归档请求 —— 决断式直接抽取，覆盖上面的追问规则】
这是系统已经分诊判定为「归档资料」的请求。本轮不要把上面「写入行为」「资料丰满度」「主交互规则」里"先问 3-5 个问题、等用户发出写入指令、还没谈妥就不出卡"那套行为套用进来。本轮一律：
1. 直接从用户这句话里抽取所有能落盘的资料事实，强制产出 generatedSuggestions（不能是空数组）；每条 requiresUserConfirm 必须为 true。不要追问、不要等"写入/记下来/确认"之类指令、不要说"还没谈妥/这次还没有谈妥的资料点"。
2. 信息不全的字段留空，但仍然出卡：能映射到现有角色/地点/资产的就用 update_character_detail / update_location_detail / update_asset_status 只填已知项；确实是全新的实体才 create_*。before 带上能定位实体的 id 或 name。
3. 装不进内置 typed 字段、又会在本书反复复用的属性（如境界、功法、血脉、阵营军衔）一律走各卡的 extraFields 自定义字段（沿用上面 extraFields 三分法，并优先复用本书已有字段）。例如"林晚突破金丹期"→ 一条 update_character_detail，before={ "name": "林晚" }，after={ "extraFields": { "境界": "金丹期" } }。
4. 一次性、不会复用的零碎信息进备注：资产卡用 notes 字段；角色/地点没有备注字段时填进最贴近的内置字段，别硬塞一个不存在的字段名，也别因此就不出卡。
5. 指代消解：句子用"她/他/它/主角/男主/女主/这个人"等指代时，先用上面上下文里的「主角」名和已知角色清单把它解析成具体角色，再归档——本书只有一个主角、或该指代只有一个合理候选时，"她/他"就指那个角色，直接归到它名下（例："她家在城南"→ 解析"她"=主角，归一条 update_character_detail 到主角卡，把"家在城南/居所=城南"填进最贴近的内置字段或 extraFields）。只有当候选真有多个、无法确定指谁时，才在 reply 里点名候选反问"你说的'她'是 X 还是 Y"——但即便这种情况也绝不要泛化成"没有谈妥资料点"而出空卡。
6. schema、actionType 取值范围、知识边界与受保护秘密等安全规则保持不变；与已有具体设定冲突的字段仍按上面的冲突规则给出保留/替换/合并/暂不处理选项，不强行覆盖；reply 里仍用一句话概括"我整理了 N 条：……"，不要声称已写入。`;
}

// ---------------------------------------------------------------------------
// Foundation gap chat messages builder
// ---------------------------------------------------------------------------

export function buildFoundationGapChatMessages(input: {
  readonly currentDraft?: FoundationGapSuggestion;
  readonly currentDraftContent?: string;
  readonly currentIntent?: FoundationGapSuggestion["actionType"];
  readonly history: readonly { readonly role: "user" | "assistant"; readonly content: string }[];
  readonly message: string;
  readonly overview: StateOverview;
  readonly report: Awaited<ReturnType<typeof import("@actalk/story-engine").buildFoundationGapReport>>;
  readonly selectedCategory?: string;
  readonly suggestions: readonly FoundationGapSuggestion[];
  readonly existingExtraFieldKeys?: readonly string[];
  readonly directArchive?: boolean;
}): readonly { readonly role: "system" | "user" | "assistant"; readonly content: string }[] {
  const system = buildFoundationGapChatSystemPrompt(input.existingExtraFieldKeys, { directArchive: input.directArchive });
  const userContext = {
    selectedCategory: input.selectedCategory ?? "none",
    currentIntent: input.currentIntent ?? "none",
    currentDraft: input.currentDraft ? summarizeFoundationGapSuggestion(input.currentDraft) : null,
    currentDraftExcerpt: summarizeCurrentDraftForFoundationGapChat(input.currentDraftContent),
    stateOverview: summarizeOverviewForFoundationGapChat(input.overview),
    gapReport: summarizeFoundationGapReport(input.report),
    suggestions: input.suggestions.slice(0, 12).map(summarizeFoundationGapSuggestion),
  };
  // directArchive：triage 已判定本条是「归档资料」。在用户消息末尾（模型生成前最后读到、recency 最优）
  // 再钉一遍决断契约，专治观察到的失败——模型在 reply 里认出了字段（如"这是自定义字段「境界」"）却
  // generatedSuggestions 出空、还说"没有谈妥"。系统段的规则 1/3 已说过，这里在消息层再强制一次。
  const directArchiveDirective = input.directArchive
    ? `\n\n【本条已判定为归档请求，必须出卡】直接把上面这句话里的资料事实抽成 generatedSuggestions（至少一条、绝不能是空数组）。只要你在 reply 里认出了某个字段/属性（哪怕是要新增的自定义字段，如「境界」「居所」），就必须为它产出对应的那一条 update_*/create_* 建议；绝不允许「reply 里描述了字段却 generatedSuggestions 为空」，也不要说"没有谈妥/没有可直接落盘的资料点"。`
    : "";
  return [
    { role: "system", content: system },
    ...input.history.map((message) => ({ role: message.role, content: message.content })),
    {
      role: "user",
      content: `当前资料上下文摘要：\n${JSON.stringify(userContext, null, 2)}\n\n当前正文摘录：${userContext.currentDraftExcerpt ?? "无"}\n\n用户消息：${input.message}${directArchiveDirective}`,
    },
  ];
}

function summarizeCurrentDraftForFoundationGapChat(value: string | undefined): string | null {
  const normalized = value?.replace(/\s+/gu, " ").trim();
  if (!normalized) return null;
  return normalized.length > 1800 ? `${normalized.slice(0, 1800)}...` : normalized;
}

// ---------------------------------------------------------------------------
// Foundation gap summarizers
// ---------------------------------------------------------------------------

export function summarizeFoundationGapReport(report: Awaited<ReturnType<typeof import("@actalk/story-engine").buildFoundationGapReport>>): Record<string, unknown> {
  return {
    readinessLevel: report.readinessLevel,
    missingCount: report.missingItems.length,
    riskyCount: report.riskyItems.length,
    conflictCount: report.conflictItems.length,
    topMissing: report.missingItems.slice(0, 8).map((item) => ({
      id: item.id,
      category: item.category,
      severity: item.severity,
      title: item.title,
      missingFields: item.missingFields.slice(0, 6),
      affectedWritingRisk: item.affectedWritingRisk,
      targetFile: item.targetFile,
      targetPath: item.targetPath,
    })),
  };
}

export function summarizeFoundationGapSuggestion(suggestion: FoundationGapSuggestion): Record<string, unknown> {
  return {
    id: suggestion.id,
    gapId: suggestion.gapId,
    category: suggestion.category,
    actionType: suggestion.actionType,
    targetFile: suggestion.targetFile,
    targetPath: suggestion.targetPath,
    after: suggestion.after,
    rationale: suggestion.rationale,
    risk: suggestion.risk,
  };
}

export function summarizeOverviewForFoundationGapChat(overview: StateOverview): Record<string, unknown> {
  return {
    title: overview.project.title,
    genre: overview.project.genre,
    currentChapter: overview.project.currentChapter,
    protagonist: overview.characters.protagonist,
    storyStatus: overview.storyStatus,
    worldBible: overview.worldBible ? {
      keyRules: overview.worldBible.keyRules,
      resourceRules: overview.worldBible.resourceRules ?? [],
      authorityRules: overview.worldBible.authorityRules ?? [],
      socialOrder: overview.worldBible.socialOrder ?? [],
      conflictSources: overview.worldBible.conflictSources ?? [],
      fixedFacts: overview.worldBible.fixedFacts ?? [],
      publicFacts: overview.worldBible.publicFacts ?? [],
      hiddenFacts: overview.worldBible.hiddenFacts ?? [],
    } : null,
    writingRules: overview.writingRules ? {
      customNotes: overview.writingRules.customNotes, // 作者自定全局规矩（破例⑧）
      narrativePerspective: overview.writingRules.narrativePerspective,
      proseStyle: overview.writingRules.proseStyle,
      pacing: overview.writingRules.pacing,
      revealPolicy: overview.writingRules.revealPolicy,
      doNotDo: overview.writingRules.doNotDo,
      forbiddenContent: overview.writingRules.forbiddenContent,
      antiAiPatterns: overview.writingRules.antiAiPatterns ?? [],
    } : null,
    location: overview.locationDetailSummary,
    assetSummary: overview.assetSummary,
    characterMatrix: {
      characters: overview.characterMatrix?.characters.slice(0, 8).map((character) => ({
        id: character.id,
        name: character.name,
        role: character.role,
        age: character.age,
        identity: character.identity,
        appearanceAnchors: character.appearanceAnchors ?? [],
        desire: character.desire,
        fear: character.fear,
        weakness: character.weakness,
        contradiction: character.contradiction,
        moralBoundary: character.moralBoundary,
        privateMotive: character.privateMotive,
        currentLocation: character.currentLocation,
        currentGoal: character.currentGoal,
        speechStyle: character.speechStyle,
        relationshipToProtagonist: character.relationshipToProtagonist,
        relationshipDynamics: character.relationshipDynamics ?? [],
        trustLevel: character.trustLevel,
        hiddenStance: character.hiddenStance,
        cannotDo: character.cannotDo,
        cannotReveal: character.cannotReveal ?? [],
        knownFacts: character.knownFacts,
        unknownTruths: character.unknownTruths,
      })),
      relationships: overview.characterMatrix?.relationships.slice(0, 8),
      riskReminders: overview.characterMatrix?.riskReminders.slice(0, 8),
    },
  };
}
