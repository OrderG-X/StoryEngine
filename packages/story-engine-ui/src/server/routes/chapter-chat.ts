/**
 * POST /api/chapter-chat — chapter-level conversation assistant.
 */
import { buildStateOverview, getAgentCapability } from "@actalk/story-engine";
import type { AgentCapabilityId, StateOverview } from "@actalk/story-engine";
import {
  guardProjectPath,
  assertStoryEngineProject,
  readJsonBody,
  readString,
  readChatMessages,
  readChapterChatMode,
  readPositiveInteger,
  writeJson,
  extractJsonObject,
  isRecord,
  readStringList,
  readWorkspaceFlowStatus,
  type MiddlewareStack,
} from "../lib/project-io.js";
import { resolveConfiguredChatModel, callOpenAICompatibleChatModel } from "../lib/llm-client.js";
import { buildChapterChatMessages } from "../lib/prompt-builder.js";
import type { ChapterAgentCard } from "../../api/types.js";

export function registerChapterChatRoutes(middlewares: MiddlewareStack): void {
  middlewares.use(async (req, res, next) => {
    if (!req.url?.startsWith("/api/chapter-chat")) {
      next();
      return;
    }

    try {
      if (req.url === "/api/chapter-chat/stream" && req.method === "POST") {
        await handleChapterChatStream(req, res);
        return;
      }
      if (req.method !== "POST") {
        writeJson(res, 405, { ok: false, error: "Only POST is supported." });
        return;
      }

      const body = await readJsonBody(req);
      const projectDir = readString(body.projectPath);
      const message = readString(body.message);
      if (!projectDir) {
        writeJson(res, 400, { ok: false, error: "Project path is required." });
        return;
      }
      if (!guardProjectPath(res, projectDir)) return;
      if (!message) {
        writeJson(res, 400, { ok: false, error: "章节对话内容不能为空。" });
        return;
      }

      await assertStoryEngineProject(projectDir);
      const chapter = readPositiveInteger(body.chapter);
      const mode = readChapterChatMode(body.mode);
      const overview = await buildStateOverview({
        projectDir,
        ...(chapter !== undefined ? { chapter } : {}),
        maxTimelineEvents: 8,
      });
      const configured = await resolveConfiguredChatModel("chapterSteering");
      const modelMessages = buildChapterChatMessages({
        overview,
        chapter: chapter ?? overview.project.currentChapter ?? null,
        message,
        messages: readChatMessages(body.messages).slice(-8),
        mode,
      });

      const { content: reply, raw } = await callOpenAICompatibleChatModel({
        configured,
        messages: modelMessages,
        temperature: configured.profile.temperature ?? 0.7,
        stream: false,
      });

      if (!reply) {
        writeJson(res, 500, { ok: false, error: "模型返回了空内容。" });
        return;
      }

      const structured = sanitizeChapterChatWriteStatusForDisplay(parseChapterChatPayload(reply));
      const agentCards = buildAgentCardsForIntent(structured.intent, message, structured.decision);
      const safeReply = structured.reply;
      writeJson(res, 200, {
        ok: true,
        result: {
          reply: safeReply,
          cards: mode === "suggest" ? structured.cards : [],
          agentCards,
          intent: structured.intent,
          decision: structured.decision,
          chapterGoal: structured.chapterGoal,
          requiresConfirmation: structured.requiresConfirmation,
          writeInstructions: structured.writeInstructions,
          silentFoundationUpdates: structured.silentFoundationUpdates,
          chapterCompleteSummary: structured.chapterCompleteSummary,
          toolOutput: [
            `buildStateOverview: 已读取《${overview.project.title}》第${chapter ?? overview.project.currentChapter ?? "未知"}章上下文`,
            `chapterChat mode: ${mode}`,
            `router decision: ${formatRouterDecision(structured.decision)}`,
            `model profile: ${configured.profile.id} / ${configured.profile.model}`,
            `context: 伏笔 ${overview.hooks.activeItems.length} 条，线索 ${overview.threads.keyOpenItems.length} 条，主线目标 ${overview.arcGoals.activeItems.length} 条`,
            `model output: ${mode === "suggest" ? structured.cards.length : 0} 张卡片，回复 ${safeReply.length} 字`,
            ...(structured.silentFoundationUpdates.length > 0
              ? [`silentFoundationUpdates: ${structured.silentFoundationUpdates.length} 条资料更新候选`]
              : []),
            ...(structured.chapterCompleteSummary
              ? [`chapterCompleteSummary: ${structured.chapterCompleteSummary}`]
              : []),
          ],
          model: configured.profile.model,
          profileId: configured.profile.id,
        },
      });
    } catch (error) {
      writeJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

type ChapterAdviceCardAction = "include" | "skip" | "weaken" | "alternative";
type ChapterAdviceCardType = "must_include" | "can_weaken" | "avoid" | "risk" | "chapter_goal" | "forbidden_info" | "alternative";
type ChapterChatIntent =
  | "discuss"
  | "suggest"
  | "direct_edit"
  | "generate_steering"
  | "generate_draft"
  | "quality_check"
  | "ai_review"
  | "revision_preview"
  | "commit_preview"
  | "commit_apply"
  | "continue_next"
  | "edit_foundation"
  | "query_story_data"
  | "write_writing_rules"
  | "write_story_settings"
  | "chapter_complete";

type ParsedChapterChatPayload = {
  readonly reply: string;
  readonly intent: ChapterChatIntent;
  readonly decision: {
    readonly agentId: string;
    readonly action: string;
    readonly target: string;
    readonly confidence: number;
    readonly reason: string;
  };
  readonly chapterGoal: string;
  readonly requiresConfirmation: boolean;
  readonly cards: readonly {
    readonly id: string;
    readonly type: ChapterAdviceCardType;
    readonly title: string;
    readonly content: string;
    readonly reason?: string;
    readonly defaultAction: ChapterAdviceCardAction;
  }[];
  readonly writeInstructions: readonly {
    readonly target: string;
    readonly mode: string;
    readonly fields?: Record<string, unknown>;
    readonly arrayField?: string;
    readonly values?: readonly string[];
  }[];
  readonly silentFoundationUpdates: readonly {
    readonly actionType: string;
    readonly targetFile: string;
    readonly targetPath: string;
    readonly category: string;
    readonly after: Record<string, unknown>;
    readonly isSecret?: boolean;
  }[];
  readonly chapterCompleteSummary: string;
};
type ParsedWriteInstruction = ParsedChapterChatPayload["writeInstructions"][number];
type ParsedSilentFoundationUpdate = ParsedChapterChatPayload["silentFoundationUpdates"][number];

type SanitizableChapterChatWriteStatusPayload = {
  readonly reply: string;
  readonly intent: ChapterChatIntent;
  readonly decision: ParsedChapterChatPayload["decision"];
  readonly requiresConfirmation: boolean;
  readonly writeInstructions: readonly unknown[];
};

export function sanitizeChapterChatWriteStatusForDisplay<T extends SanitizableChapterChatWriteStatusPayload>(payload: T): T {
  const hasExecutableWriteInstructions = payload.writeInstructions.length > 0;
  const hasPrematureClaim = hasPrematureWriteSuccessClaim(payload.reply);
  const decisionLooksWritable = isWritableRouterDecision(payload.decision);

  if (payload.intent === "commit_apply" && hasPrematureClaim) {
    return withSanitizedReply(
      payload,
      "已识别定稿请求。本轮对话尚未写入文件；定稿会直接执行，写入前自动创建快照，可随时撤销。",
    );
  }

  if ((payload.intent === "write_writing_rules" || payload.intent === "write_story_settings") && !hasExecutableWriteInstructions) {
    return withSanitizedReply(
      payload,
      "未完成资料修改：模型没有给出可执行写入指令，当前未写入任何文件。请把要写入的规则或设定说得再具体一点。",
    );
  }

  if (payload.intent === "write_writing_rules" || payload.intent === "write_story_settings") {
    return withSanitizedReply(
      payload,
      "已生成可执行的资料修改指令。我会直接修改当前书籍资料，完成后显示结果和撤销入口。",
    );
  }

  if (payload.intent === "edit_foundation" && (payload.requiresConfirmation || hasPrematureClaim) && (hasPrematureClaim || decisionLooksWritable)) {
    return withSanitizedReply(
      payload,
      "我已识别到这是资料修改请求。当前未写入任何文件；需要先生成可确认的资料修改预览。",
    );
  }

  if (payload.intent === "discuss" && decisionLooksWritable && hasPrematureClaim) {
    return withSanitizedReply(
      payload,
      "我识别到你想修改资料。当前未写入任何文件；需要先生成可确认的资料修改预览。",
    );
  }

  return payload;
}

function withSanitizedReply<T extends SanitizableChapterChatWriteStatusPayload>(payload: T, reply: string): T {
  return {
    ...payload,
    reply,
  };
}

function hasPrematureWriteSuccessClaim(reply: string): boolean {
  return /(?:已(?:经)?[^，。！？\n]{0,16}(?:改为|改成|修改|更新|保存|写入|记录|提交|入库|删除|删掉|移除|清除)|[^，。！？\n]{0,16}已(?:改为|改成|修改|更新|保存|写入|记录|提交|入库|删除|删掉|移除|清除)|我(?:已经|已)?帮你[^，。！？\n]{0,16}(?:改|修改|更新|保存|写入|记录|删除|删掉|移除|清除)|\b(?:changed|updated|saved|wrote|written|renamed|deleted|removed)\b)/iu.test(reply);
}

function isWritableRouterDecision(decision: ParsedChapterChatPayload["decision"]): boolean {
  const value = `${decision.agentId} ${decision.action} ${decision.target}`.toLowerCase();
  return /(?:\b(?:write|edit|apply|commit)\b|write_|edit_|apply_|commit_|formal_|foundation_|character_bible|character_profile|world_bible|profile\.json|bible\.json|matrix\.json|story\/|characters\/|world\/|timeline\/|memory\/)/u.test(value);
}

function parseChapterChatPayload(raw: string): ParsedChapterChatPayload {
  const emptyPayload = { reply: "", intent: "discuss" as const, decision: defaultRouterDecision("discuss"), chapterGoal: "", requiresConfirmation: false, cards: [], writeInstructions: [], silentFoundationUpdates: [], chapterCompleteSummary: "" };
  const jsonText = extractJsonObject(raw);
  if (!jsonText) {
    return { ...emptyPayload, reply: raw };
  }

  try {
    const parsed = JSON.parse(jsonText) as unknown;
    if (!isRecord(parsed)) return { ...emptyPayload, reply: raw };
    const reply = readString(parsed.reply) ?? raw;
    const intent = normalizeChapterChatIntent(readString(parsed.intent));
    const decision = normalizeRouterDecision(parsed.decision, intent);
    const chapterGoal = readString(parsed.chapterGoal) ?? "";
    const requiresConfirmation = parsed.requiresConfirmation === true;
    const rawCards = Array.isArray(parsed.cards) ? parsed.cards : [];
    const cards = rawCards
      .map((item, index) => normalizeChapterAdviceCard(item, index))
      .filter((item): item is NonNullable<ReturnType<typeof normalizeChapterAdviceCard>> => Boolean(item))
      .slice(0, 8);
    const rawWriteInstructions = Array.isArray(parsed.writeInstructions) ? parsed.writeInstructions : [];
    const writeInstructions = rawWriteInstructions
      .map(normalizeWriteInstructionPayload)
      .filter((item): item is ParsedWriteInstruction => Boolean(item));
    const rawSilentUpdates = Array.isArray(parsed.silentFoundationUpdates) ? parsed.silentFoundationUpdates : [];
    const silentFoundationUpdates = rawSilentUpdates
      .map(normalizeSilentFoundationUpdate)
      .filter((item): item is ParsedSilentFoundationUpdate => Boolean(item));
    const chapterCompleteSummary = readString(parsed.chapterCompleteSummary) ?? "";
    return { reply, intent, decision, chapterGoal, requiresConfirmation, cards, writeInstructions, silentFoundationUpdates, chapterCompleteSummary };
  } catch {
    return parseChapterChatPayloadLenient(jsonText, raw);
  }
}

function parseChapterChatPayloadLenient(jsonText: string, raw: string): ParsedChapterChatPayload {
  const intent = normalizeChapterChatIntent(extractJsonStringField(jsonText, "intent"));
  if (intent === "discuss") {
    return { reply: raw, intent: "discuss", decision: defaultRouterDecision("discuss"), chapterGoal: "", requiresConfirmation: false, cards: [], writeInstructions: [], silentFoundationUpdates: [], chapterCompleteSummary: "" };
  }
  const writeInstructions = parseJsonArrayField(jsonText, "writeInstructions")
    .map(normalizeWriteInstructionPayload)
    .filter((item): item is ParsedWriteInstruction => Boolean(item));
  const reply = extractJsonStringField(jsonText, "reply") ?? agentTitleForIntent(intent);
  const requiresConfirmation = /"requiresConfirmation"\s*:\s*true/u.test(jsonText);
  const silentFoundationUpdates = parseJsonArrayField(jsonText, "silentFoundationUpdates")
    .map(normalizeSilentFoundationUpdate)
    .filter((item): item is ParsedSilentFoundationUpdate => Boolean(item));
  return {
    reply,
    intent,
    decision: defaultRouterDecision(intent),
    chapterGoal: extractJsonStringField(jsonText, "chapterGoal") ?? "",
    requiresConfirmation,
    cards: [],
    writeInstructions,
    silentFoundationUpdates,
    chapterCompleteSummary: extractJsonStringField(jsonText, "chapterCompleteSummary") ?? "",
  };
}

function normalizeWriteInstructionPayload(item: unknown): ParsedWriteInstruction | undefined {
  if (!isRecord(item)) return undefined;
  const target = readString(item.target);
  const mode = readString(item.mode);
  if (!target || !mode) return undefined;
  return {
    target,
    mode,
    ...(isRecord(item.fields) ? { fields: item.fields } : {}),
    ...(readString(item.arrayField) ? { arrayField: readString(item.arrayField) } : {}),
    ...(readStringList(item.values).length ? { values: readStringList(item.values) } : {}),
  };
}

function normalizeSilentFoundationUpdate(item: unknown): ParsedSilentFoundationUpdate | undefined {
  if (!isRecord(item)) return undefined;
  const actionType = readString(item.actionType);
  const targetFile = readString(item.targetFile);
  const targetPath = readString(item.targetPath);
  const category = readString(item.category);
  if (!actionType || !targetFile || !targetPath || !category) return undefined;
  const after = isRecord(item.after) ? item.after : {};
  const isSecret = item.isSecret === true;
  return { actionType, targetFile, targetPath, category, after, ...(isSecret ? { isSecret: true } : {}) };
}

function extractJsonStringField(jsonText: string, field: string): string | undefined {
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const nextField = /,\s*"[^"]+"\s*:/gu;
  const startMatch = new RegExp(`"${escapedField}"\\s*:\\s*"`, "u").exec(jsonText);
  if (!startMatch) return undefined;
  const valueStart = startMatch.index + startMatch[0].length;
  nextField.lastIndex = valueStart;
  const next = nextField.exec(jsonText);
  const fallbackEnd = jsonText.indexOf("\n", valueStart);
  const valueEnd = next ? next.index : fallbackEnd >= 0 ? fallbackEnd : jsonText.length;
  const rawValue = jsonText.slice(valueStart, valueEnd);
  const value = rawValue.replace(/"\s*$/u, "").replace(/\\"/gu, "\"").trim();
  return value || undefined;
}

function parseJsonArrayField(jsonText: string, field: string): unknown[] {
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`"${escapedField}"\\s*:\\s*\\[`, "u").exec(jsonText);
  if (!match) return [];
  const start = match.index + match[0].lastIndexOf("[");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < jsonText.length; index += 1) {
    const char = jsonText[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
    } else if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(jsonText.slice(start, index + 1)) as unknown;
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      }
    }
  }
  return [];
}

function normalizeChapterChatIntent(value: string | undefined): ChapterChatIntent {
  if (
    value === "discuss"
    || value === "suggest"
    || value === "direct_edit"
    || value === "generate_steering"
    || value === "generate_draft"
    || value === "quality_check"
    || value === "ai_review"
    || value === "revision_preview"
    || value === "commit_preview"
    || value === "commit_apply"
    || value === "continue_next"
    || value === "edit_foundation"
    || value === "query_story_data"
    || value === "write_writing_rules"
    || value === "write_story_settings"
    || value === "chapter_complete"
  ) {
    return value;
  }
  return "discuss";
}

function normalizeRouterDecision(value: unknown, intent: ChapterChatIntent): {
  readonly agentId: string;
  readonly action: string;
  readonly target: string;
  readonly confidence: number;
  readonly reason: string;
} {
  const fallback = defaultRouterDecision(intent);
  if (!isRecord(value)) return fallback;
  const confidenceValue = typeof value.confidence === "number" ? value.confidence : Number(value.confidence);
  return {
    agentId: readString(value.agentId) ?? fallback.agentId,
    action: readString(value.action) ?? fallback.action,
    target: readString(value.target) ?? fallback.target,
    confidence: Number.isFinite(confidenceValue) ? Math.max(0, Math.min(1, confidenceValue)) : fallback.confidence,
    reason: readString(value.reason) ?? fallback.reason,
  };
}

function defaultRouterDecision(intent: ChapterChatIntent): {
  readonly agentId: string;
  readonly action: string;
  readonly target: string;
  readonly confidence: number;
  readonly reason: string;
} {
  return {
    agentId: agentNameForIntent(intent),
    action: intent,
    target: targetForIntent(intent),
    confidence: intent === "discuss" || intent === "suggest" ? 0.6 : 0.8,
    reason: "模型未提供 decision，后端按 intent 补全。",
  };
}

function formatRouterDecision(decision: {
  readonly agentId: string;
  readonly action: string;
  readonly target: string;
  readonly confidence: number;
  readonly reason: string;
}): string {
  return `${decision.agentId} / ${decision.action} / ${decision.target} / confidence ${decision.confidence.toFixed(2)}`;
}

function buildAgentCardsForIntent(
  intent: ChapterChatIntent,
  sourceMessage: string,
  decision: ReturnType<typeof defaultRouterDecision>,
): readonly ChapterAgentCard[] {
  if (intent === "discuss" || intent === "suggest") return [];
  const capabilityId = agentCapabilityIdForIntent(intent);
  const capability = capabilityId ? getAgentCapability(capabilityId) : undefined;
  const base = {
    id: `agent-${intent}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    agentName: capability?.id ?? decision.agentId ?? agentNameForIntent(intent),
    status: "queued" as const,
    title: agentTitleForIntent(intent),
    summary: agentSummaryForIntent(intent, sourceMessage),
  };
  const audit = routeAuditDetails(decision);
  if (intent === "query_story_data") {
    return [{
      ...base,
      kind: "foundation",
      status: "completed",
      title: "资料查询完成",
      summary: "已读取当前书籍资料，并按现有设定回答。",
      detail: [...audit, "本轮只读取资料，不写入任何文件。"],
      permission: "safe_read",
    }];
  }
  if (intent === "direct_edit") {
    return [{
      ...base,
      kind: "draft",
      detail: [...audit, "会生成左侧工作稿改动。", "改动会自动保存，可在操作历史中恢复。"],
      permission: ["model_call", "draft_write"] as const,
    }];
  }
  if (intent === "edit_foundation" || intent === "write_writing_rules" || intent === "write_story_settings") {
    return [{
      ...base,
      kind: "foundation",
      detail: [...audit, "会先整理资料草案。", "正式写入前需要确认。"],
      permission: intent === "edit_foundation" ? ["model_call", "project_config_write"] as const : "project_config_write",
    }];
  }
  if (intent === "generate_draft") {
    return [{
      ...base,
      kind: "draft",
      detail: [...audit, "会生成当前章节工作稿。", "不会写入正式故事状态。"],
      permission: ["model_call", "draft_write"] as const,
    }];
  }
  if (intent === "generate_steering") {
    return [{
      ...base,
      kind: "steering",
      detail: [...audit, "会读取当前故事状态。", "只生成本章方案预览。"],
      permission: "model_call",
    }];
  }
  if (intent === "quality_check") {
    return [{
      ...base,
      kind: "quality",
      detail: [...audit, "会检查当前工作稿。", "只生成质检结果，不改正文。"],
      permission: ["safe_read", "model_call"] as const,
    }];
  }
  if (intent === "ai_review" || intent === "revision_preview") {
    return [{
      ...base,
      kind: intent === "ai_review" ? "review" : "revision",
      detail: [...audit, "会读取当前工作稿。", intent === "ai_review" ? "只给内容审阅建议，不自动改正文。" : "只生成修订预览，应用前可确认。"],
      permission: ["safe_read", "model_call"] as const,
    }];
  }
  if (intent === "commit_preview" || intent === "commit_apply") {
    return [{
      ...base,
      kind: "commit",
      detail: [...audit, intent === "commit_apply" ? "直接执行定稿，写入前自动快照，可撤销。" : "只生成定稿预览，不写正式状态。"],
      permission: intent === "commit_apply" ? "formal_state_write" : "safe_read",
    }];
  }
  return [{
    ...base,
    kind: "project",
    detail: [...audit, "只处理当前章节工作区。"],
    permission: "safe_read",
  }];
}

function routeAuditDetails(decision: ReturnType<typeof defaultRouterDecision>): string[] {
  return [
    `route: ${decision.agentId}`,
    `action: ${decision.action}`,
    `target: ${decision.target}`,
    `confidence: ${decision.confidence.toFixed(2)}`,
    `reason: ${decision.reason}`,
  ];
}

function agentNameForIntent(intent: ChapterChatIntent): string {
  const names: Record<ChapterChatIntent, string> = {
    discuss: "chapterOrchestrator",
    suggest: "chapterOrchestrator",
    direct_edit: "draftEditAgent",
    generate_steering: "chapterSteeringAgent",
    generate_draft: "draftWriterAgent",
    quality_check: "qualityAgent",
    ai_review: "reviewAgent",
    revision_preview: "revisionAgent",
    commit_preview: "commitPreviewAgent",
    commit_apply: "commitApplyAgent",
    continue_next: "chapterNavigator",
    edit_foundation: "foundationAgent",
    query_story_data: "stateOverviewReader",
    write_writing_rules: "writingRulesWriter",
    write_story_settings: "storySettingsWriter",
    chapter_complete: "chapterOrchestrator",
  };
  return names[intent];
}

function targetForIntent(intent: ChapterChatIntent): string {
  const targets: Record<ChapterChatIntent, string> = {
    discuss: "chat",
    suggest: "chapter_advice_cards",
    direct_edit: "current_draft",
    generate_steering: "chapter_steering",
    generate_draft: "drafts/fast/current_chapter",
    quality_check: "draft_quality_report",
    ai_review: "draft_review_report",
    revision_preview: "draft_revision_preview",
    commit_preview: "formal_state_preview",
    commit_apply: "formal_story_state",
    continue_next: "chapter_navigation",
    edit_foundation: "foundation_files",
    query_story_data: "StateOverview",
    write_writing_rules: "story/writing-rules.json",
    write_story_settings: "story/bible.json",
    chapter_complete: "foundation_files",
  };
  return targets[intent];
}

function agentCapabilityIdForIntent(intent: ChapterChatIntent): AgentCapabilityId | undefined {
  const ids: Partial<Record<ChapterChatIntent, AgentCapabilityId>> = {
    direct_edit: "draftEditAgent",
    generate_steering: "chapterSteeringAgent",
    generate_draft: "draftWriterAgent",
    quality_check: "qualityAgent",
    ai_review: "reviewAgent",
    revision_preview: "revisionAgent",
    commit_preview: "commitPreviewAgent",
    commit_apply: "commitApplyAgent",
    edit_foundation: "foundationAgent",
    query_story_data: "foundationAgent",
    write_writing_rules: "foundationAgent",
    write_story_settings: "foundationAgent",
  };
  return ids[intent];
}

function agentTitleForIntent(intent: ChapterChatIntent): string {
  const titles: Record<ChapterChatIntent, string> = {
    discuss: "写作助手",
    suggest: "剧情建议",
    direct_edit: "工作稿修改",
    generate_steering: "剧情方案",
    generate_draft: "正文生成",
    quality_check: "工作稿质检",
    ai_review: "审稿建议",
    revision_preview: "修订预览",
    commit_preview: "定稿预览",
    commit_apply: "定稿",
    continue_next: "进入下一章",
    edit_foundation: "资料助手",
    query_story_data: "资料查询完成",
    write_writing_rules: "写作规则",
    write_story_settings: "故事设定",
    chapter_complete: "章节完成",
  };
  return titles[intent];
}

function agentSummaryForIntent(intent: ChapterChatIntent, sourceMessage: string): string {
  const target = sourceMessage.trim().slice(0, 60);
  if (intent === "direct_edit") return `按你的要求修改左侧工作稿：${target}`;
  if (intent === "generate_draft") return `按你的方向写当前章节草稿：${target}`;
  if (intent === "generate_steering") return `整理这一章的剧情推进方向：${target}`;
  if (intent === "quality_check") return "检查当前草稿的连续性、穿帮和设定冲突。";
  if (intent === "ai_review") return "从编辑视角给出审稿建议，不自动改正文。";
  if (intent === "revision_preview") return "根据明确问题生成修订预览，应用前可确认。";
  if (intent === "commit_preview") return "生成定稿预览，先看会写入什么。";
  if (intent === "commit_apply") return "直接执行定稿，写入前自动快照，可撤销。";
  if (intent === "edit_foundation") return `读取当前书籍资料并整理补全建议：${target}`;
  if (intent === "write_writing_rules") return `整理要写入的写作规则：${target}`;
  if (intent === "write_story_settings") return `整理要写入的故事设定：${target}`;
  if (intent === "query_story_data") return "读取当前书籍资料并直接回答。";
  if (intent === "continue_next") return "准备切到下一章工作区。";
  return "写作助手正在处理这条请求。";
}

function looksLikeDraftBody(text: string): boolean {
  const normalized = text.trim();
  if (normalized.length > 700) return true;
  const paragraphs = normalized.split(/\n\s*\n/u).filter((item) => item.trim().length > 0);
  if (paragraphs.length >= 3 && normalized.length > 360) return true;
  return /^(第[一二三四五六七八九十百\d]+章|章节正文|正文如下|以下是正文)/u.test(normalized);
}

function normalizeChapterAdviceCard(item: unknown, index: number): {
  readonly id: string;
  readonly type: ChapterAdviceCardType;
  readonly title: string;
  readonly content: string;
  readonly reason?: string;
  readonly defaultAction: ChapterAdviceCardAction;
} | null {
  if (!isRecord(item)) return null;
  const content = readString(item.content);
  if (!content) return null;
  const type = normalizeChapterAdviceCardType(readString(item.type));
  const defaultAction = normalizeChapterAdviceCardAction(readString(item.defaultAction));
  const title = readString(item.title) ?? chapterAdviceTypeTitle(type);
  return {
    id: readString(item.id) ?? `advice-${index + 1}`,
    type,
    title,
    content,
    ...(readString(item.reason) ? { reason: readString(item.reason) } : {}),
    defaultAction,
  };
}

function normalizeChapterAdviceCardType(value: string | undefined): ChapterAdviceCardType {
  if (
    value === "must_include"
    || value === "can_weaken"
    || value === "avoid"
    || value === "risk"
    || value === "chapter_goal"
    || value === "forbidden_info"
    || value === "alternative"
  ) {
    return value;
  }
  return "alternative";
}

function normalizeChapterAdviceCardAction(value: string | undefined): ChapterAdviceCardAction {
  if (value === "include" || value === "skip" || value === "weaken" || value === "alternative") {
    return value;
  }
  return "include";
}

function chapterAdviceTypeTitle(type: ChapterAdviceCardType): string {
  const labels: Record<ChapterAdviceCardType, string> = {
    must_include: "必须承接",
    can_weaken: "可以弱化",
    avoid: "暂时避开",
    risk: "风险提醒",
    chapter_goal: "章节目标",
    forbidden_info: "禁止信息",
    alternative: "换一种方式",
  };
  return labels[type];
}

// ---------------------------------------------------------------------------
// SSE streaming chapter chat
// ---------------------------------------------------------------------------

async function handleChapterChatStream(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
): Promise<void> {
  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const body = await readJsonBody(req);
    const projectDir = readString(body.projectPath);
    const message = readString(body.message);
    if (!projectDir) {
      writeJson(res, 400, { ok: false, error: "Project path is required." });
      return;
    }
    if (!guardProjectPath(res, projectDir)) return;
    if (!message) {
      writeJson(res, 400, { ok: false, error: "章节对话内容不能为空。" });
      return;
    }

    await assertStoryEngineProject(projectDir);
    const chapter = readPositiveInteger(body.chapter);
    const mode = readChapterChatMode(body.mode);

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    sendEvent("tool:start", { id: "state-overview", label: "读取当前故事状态" });

    const overview = await buildStateOverview({
      projectDir,
      ...(chapter !== undefined ? { chapter } : {}),
      maxTimelineEvents: 8,
    });
    sendEvent("tool:end", { id: "state-overview", status: "completed" });

    const configured = await resolveConfiguredChatModel("chapterSteering");

    const modelMessages = buildChapterChatMessages({
      overview,
      chapter: chapter ?? overview.project.currentChapter ?? null,
      message,
      messages: readChatMessages(body.messages).slice(-8),
      mode,
    });

    sendEvent("thinking:delta", { text: "已读取当前章节、角色、世界观、写作规则和最近时间线，正在让总控模型判断是否需要调用底层 Agent。\n" });
    sendEvent("tool:start", { id: "chapter-orchestrator", label: "调用章节总控模型" });

    const { content: fullContent, raw, response } = await callOpenAICompatibleChatModel({
      configured,
      messages: modelMessages,
      temperature: configured.profile.temperature ?? 0.7,
      stream: false,
    });

    if (!response.ok) {
      sendEvent("tool:end", { id: "chapter-orchestrator", status: "failed" });
      sendEvent("error", { error: `模型请求失败：${response.status} ${raw.slice(0, 300)}` });
      res.end();
      return;
    }
    if (!fullContent) {
      sendEvent("tool:end", { id: "chapter-orchestrator", status: "failed" });
      sendEvent("error", { error: "模型返回了空内容。" });
      res.end();
      return;
    }

    const structured = sanitizeChapterChatWriteStatusForDisplay(parseChapterChatPayload(fullContent));
    const agentCards = buildAgentCardsForIntent(structured.intent, message, structured.decision);
    sendEvent("tool:end", { id: "chapter-orchestrator", status: "completed" });
    sendEvent("done", {
      reply: structured.reply,
      cards: mode === "suggest" ? structured.cards : [],
      agentCards,
      intent: structured.intent,
      decision: structured.decision,
      chapterGoal: structured.chapterGoal,
      requiresConfirmation: structured.requiresConfirmation,
      writeInstructions: structured.writeInstructions,
      silentFoundationUpdates: structured.silentFoundationUpdates,
      chapterCompleteSummary: structured.chapterCompleteSummary,
      toolOutput: [
        `buildStateOverview: 已读取《${overview.project.title}》第${chapter ?? overview.project.currentChapter ?? "未知"}章上下文`,
        `chapterChat mode: ${mode} (streaming)`,
        `router decision: ${formatRouterDecision(structured.decision)}`,
        `model profile: ${configured.profile.id} / ${configured.profile.model}`,
        `context: 伏笔 ${overview.hooks.activeItems.length} 条，线索 ${overview.threads.keyOpenItems.length} 条，主线目标 ${overview.arcGoals.activeItems.length} 条`,
        `model output: ${mode === "suggest" ? structured.cards.length : 0} 张卡片，回复 ${structured.reply.length} 字`,
        ...(structured.silentFoundationUpdates.length > 0
          ? [`silentFoundationUpdates: ${structured.silentFoundationUpdates.length} 条资料更新候选`]
          : []),
        ...(structured.chapterCompleteSummary
          ? [`chapterCompleteSummary: ${structured.chapterCompleteSummary}`]
          : []),
      ],
    });
    res.end();
  } catch (error) {
    try {
      sendEvent("error", {
        error: error instanceof Error ? error.message : String(error),
      });
    } catch {
      writeJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    res.end();
  }
}
