/**
 * POST /api/draft/generate — non-streaming draft generation.
 * POST /api/draft/stream — SSE streaming draft generation.
 * POST /api/draft/quality — draft quality check.
 * POST /api/draft/ai-review — AI review of draft.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  buildStateOverview,
  buildWritingContextPack,
  applyDraftLengthConstraint,
  buildDraftLengthReport,
  buildFastDraftRetryPrompt,
  checkDraftBeforeCommit,
  countDraftChineseCharacters,
  renderFastDraftPromptText,
  resolveDraftLengthTarget,
  requestedDraftLengthBounds,
  resolveDraftMaxOutputTokens,
  trimDraftBodyToLengthTarget,
  runFastDraft,
  fallbackDraftAIReviewReport,
  buildDraftAIReviewPrompt,
  parseDraftAIReviewReport,
  readWritingRules,
} from "@actalk/story-engine";
import type { DraftAIReviewReport, DraftLengthTarget } from "@actalk/story-engine";
import {
  assertStoryEngineProject,
  defaultDraftPath,
  extractDraftTitle,
  extractJsonObject,
  guardProjectPath,
  readDraftQualityReport,
  readJsonBody,
  readPositiveInteger,
  readString,
  readStringList,
  requireBodyString,
  requirePositiveBodyInteger,
  stripLeadingMarkdownChapterHeading,
  withUiOverviewDetails,
  writeJson,
  isRecord,
  type MiddlewareStack,
} from "../lib/project-io.js";
import { buildProviderRequestHeaders, callOpenAICompatibleChatModel, createConfiguredWriterClient, resolveConfiguredChatModel, streamOpenAICompatibleResponse, type ResolvedChatModel } from "../lib/llm-client.js";
import { appendActualWordCountToReviewPrompt } from "../agent/tools/ai-review.js";
import { countTextWords } from "../../utils/textUtils.js";
import { judgeDraftQualityWithModel } from "../lib/quality-judge.js";
import { createSnapshot } from "../lib/snapshot.js";
import { contextBudgetPayload, makeWriterRankContext, resolveWriterTokenBudget } from "../agent/context-budget/rank-writer-context.js";
import { resolveSelectedCharacterIds } from "../agent/presence/in-scene-detector.js";
import { resolveDraftContentForQualityCheck } from "../agent/tools/quality-check.js";

const DIRECT_EDIT_MODEL_FORMAT_ERROR = "修订模型返回格式不完整，请重试或换一种修改要求。";
const DRAFT_TOO_SHORT_ERROR = "草稿正文低于目标字数过多，已拒绝写入工作稿；请重试或提高模型输出上限。";
const DRAFT_TOO_LONG_ERROR = "草稿正文超出目标字数过多，压缩后仍不稳定；已拒绝写入工作稿，请重试。";
const DRAFT_TARGET_UNSATISFIED_ERROR = "模型输出无法稳定满足目标字数，已拒绝写入工作稿；请重试或换一种写法。";

export function registerDraftRoutes(middlewares: MiddlewareStack): void {
  middlewares.use(async (req, res, next) => {
    if (req.url?.startsWith("/api/draft/generate")) {
      await handleGenerateDraft(req, res);
      return;
    }
    if (req.url?.startsWith("/api/draft/stream")) {
      await handleGenerateDraftStream(req, res);
      return;
    }
    if (req.url?.startsWith("/api/draft/apply-candidate")) {
      await handleApplyDraftCandidate(req, res);
      return;
    }
    if (req.url?.startsWith("/api/draft/ai-review")) {
      await handleDraftAIReview(req, res);
      return;
    }
    if (req.url?.startsWith("/api/draft/direct-edit")) {
      await handleDraftDirectEdit(req, res);
      return;
    }
    if (req.url?.startsWith("/api/draft/quality")) {
      await handleDraftQuality(req, res);
      return;
    }
    next();
  });
}

async function handleGenerateDraft(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
  try {
    if (req.method !== "POST") {
      writeJson(res, 405, { ok: false, error: "Only POST is supported." });
      return;
    }
    const body = await readJsonBody(req);
    const projectDir = requireBodyString(body.projectPath, "Project path is required.");
    if (!guardProjectPath(res, projectDir)) return;
    const chapter = requirePositiveBodyInteger(body.chapter, "Chapter is required.");
    const rawChapterGoal = readString(body.chapterGoal) ?? `继续第 ${chapter} 章。`;
    const requestedDraftLength = readPositiveInteger(body.requestedDraftLength);
    const selectedCharacterIds = optionalStringList(body.selectedCharacterIds);
    const selectedHookIds = optionalStringList(body.selectedHookIds);
    const maxTimelineEvents = readPositiveInteger(body.maxTimelineEvents) ?? 8;
    const lengthTarget = await resolveProjectDraftLengthTarget(projectDir, rawChapterGoal, requestedDraftLength);
    const writerClient = await createConfiguredWriterClient("fastDraft");
    const characterSelection = await resolveSelectedCharacterIds({
      projectDir,
      chapter,
      chapterGoal: rawChapterGoal,
      explicit: selectedCharacterIds,
    });
    const resolvedSelectedCharacterIds = characterSelection.selectedCharacterIds.length > 0 ? characterSelection.selectedCharacterIds : undefined;
    // 抽卡候选（persist:false）：生成一版正文【不写盘、不快照】，临时返回给前端并排展示，挑中才落盘。
    if (body.persist === false) {
      const contextRanking = makeWriterRankContext({ tokenBudget: resolveWriterTokenBudget(readPositiveInteger(body.contextTokenBudget)) });
      const candidate = await runFastDraft({
        projectDir,
        chapter,
        chapterGoal: rawChapterGoal,
        writerClient,
        dryRun: false,
        persist: false,
        requestedDraftLength,
        maxOutputTokens: readPositiveInteger(body.maxOutputTokens) ?? resolveDraftMaxOutputTokens(lengthTarget),
        maxTimelineEvents,
        selectedCharacterIds: resolvedSelectedCharacterIds,
        selectedHookIds,
        rankContext: contextRanking.rankContext,
      });
      if (!candidate.passed || !candidate.draftBody) {
        writeJson(res, 422, { ok: false, error: candidate.issues?.[0] ?? "候选生成失败，请重试。" });
        return;
      }
      const candidateTitle = candidate.title ?? `第${chapter}章`;
      writeJson(res, 200, {
        ok: true,
        report: candidate,
        draftContent: `# ${candidateTitle}\n\n${candidate.draftBody.trim()}\n`,
        draftTitle: candidateTitle,
        contextBudget: contextBudgetPayload(contextRanking),
        characterSelection,
      });
      return;
    }
    const draftPath = defaultDraftPath(projectDir, chapter);
    const previousDraftContent = await readFile(draftPath, "utf-8").catch(() => undefined);
    // runFastDraft（dryRun: false）会写工作稿，写第一笔前先留可撤销快照
    await createSnapshot(projectDir, `草稿生成前快照：第${chapter}章`);
    const contextRanking = makeWriterRankContext({ tokenBudget: resolveWriterTokenBudget(readPositiveInteger(body.contextTokenBudget)) });
    const report = await runFastDraft({
      projectDir,
      chapter,
      chapterGoal: rawChapterGoal,
      writerClient,
      dryRun: false,
      requestedDraftLength,
      maxOutputTokens: readPositiveInteger(body.maxOutputTokens) ?? resolveDraftMaxOutputTokens(lengthTarget),
      maxTimelineEvents,
      selectedCharacterIds: resolvedSelectedCharacterIds,
      selectedHookIds,
      rankContext: contextRanking.rankContext,
    });
    let responseReport = report;
    const draftContent = report.draftPath ? await readFile(report.draftPath, "utf-8").catch(() => "") : "";
    if (draftContent.trim()) {
      const draftBody = stripLeadingMarkdownChapterHeading(draftContent);
      const enforced = enforceDraftLengthTarget({
        draftBody,
        lengthTarget,
        allowDeterministicTrim: true,
      });
      if (!enforced.ok) {
        await restoreDraftFile(draftPath, previousDraftContent);
        writeJson(res, 422, { ok: false, error: enforced.error });
        return;
      }
      const routeTrimmed = enforced.draftBody !== draftBody;
      if (routeTrimmed && report.draftPath) {
        const title = extractDraftTitle(draftContent) ?? report.title ?? `第${chapter}章`;
        await writeFile(report.draftPath, `# ${title}\n\n${enforced.draftBody.trim()}\n`, "utf-8");
      }
      if (routeTrimmed || !report.draftLength) {
        responseReport = {
          ...report,
          draftLength: buildDraftLengthReport({
            draftBody: enforced.draftBody,
            lengthTarget,
            finalLengthAfterTrim: countCjkChars(enforced.draftBody),
            whetherTrimmed: routeTrimmed || report.draftLength?.whetherTrimmed === true,
          }),
        };
      }
    }
    const finalDraftContent = report.draftPath ? await readFile(report.draftPath, "utf-8").catch(() => "") : "";
    const overview = await withUiOverviewDetails(projectDir, await buildStateOverview({ projectDir, chapter, maxTimelineEvents }));
    writeJson(res, 200, {
      ok: true,
      report: responseReport,
      draftContent: finalDraftContent,
      draftTitle: extractDraftTitle(finalDraftContent) ?? report.title,
      overview,
      contextBudget: contextBudgetPayload(contextRanking),
      characterSelection,
    });
  } catch (error) {
    writeJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// 抽卡「挑中落盘」（块③ part2）：把用户选中的候选正文写进工作稿，写前留可撤销快照（继承阶段一）。
// 不调模型——候选已生成好；这一步只做「快照 + 落盘」，挑错了走操作历史撤销。
async function handleApplyDraftCandidate(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
  try {
    if (req.method !== "POST") {
      writeJson(res, 405, { ok: false, error: "Only POST is supported." });
      return;
    }
    const body = await readJsonBody(req);
    const projectDir = requireBodyString(body.projectPath, "Project path is required.");
    if (!guardProjectPath(res, projectDir)) return;
    const chapter = requirePositiveBodyInteger(body.chapter, "Chapter is required.");
    const draftContent = requireBodyString(body.draftContent, "候选正文不能为空。");
    await assertStoryEngineProject(projectDir);
    const draftPath = defaultDraftPath(projectDir, chapter);
    await createSnapshot(projectDir, `抽卡选用候选前快照：第${chapter}章`);
    await mkdir(dirname(draftPath), { recursive: true });
    await writeFile(draftPath, `${draftContent.trimEnd()}\n`, "utf-8");
    const overview = await withUiOverviewDetails(projectDir, await buildStateOverview({ projectDir, chapter, maxTimelineEvents: 8 }));
    writeJson(res, 200, {
      ok: true,
      result: { applied: true, chapter, draftPath },
      draftContent: `${draftContent.trimEnd()}\n`,
      draftTitle: extractDraftTitle(draftContent) ?? `第${chapter}章`,
      overview,
    });
  } catch (error) {
    writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

async function handleGenerateDraftStream(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  if (req.method !== "POST") {
    writeJson(res, 405, { ok: false, error: "Only POST is supported." });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const projectDir = requireBodyString(body.projectPath, "Project path is required.");
    if (!guardProjectPath(res, projectDir)) return;
    const chapter = requirePositiveBodyInteger(body.chapter, "Chapter is required.");
    const rawChapterGoal = readString(body.chapterGoal) ?? `继续第 ${chapter} 章。`;
    const requestedDraftLength = readPositiveInteger(body.requestedDraftLength);
    const selectedCharacterIds = optionalStringList(body.selectedCharacterIds);
    const selectedHookIds = optionalStringList(body.selectedHookIds);
    const maxTimelineEvents = readPositiveInteger(body.maxTimelineEvents) ?? 8;
    const contextRanking = makeWriterRankContext({ tokenBudget: resolveWriterTokenBudget(readPositiveInteger(body.contextTokenBudget)) });
    const lengthTarget = await resolveProjectDraftLengthTarget(projectDir, rawChapterGoal, requestedDraftLength);
    const chapterGoal = applyDraftLengthConstraint(rawChapterGoal, lengthTarget);
    const characterSelection = await resolveSelectedCharacterIds({
      projectDir,
      chapter,
      chapterGoal: rawChapterGoal,
      explicit: selectedCharacterIds,
    });
    const resolvedSelectedCharacterIds = characterSelection.selectedCharacterIds.length > 0 ? characterSelection.selectedCharacterIds : undefined;
    await assertStoryEngineProject(projectDir);
    await createSnapshot(projectDir, `草稿生成前快照：第${chapter}章`);

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    sendEvent("status", { message: "正在读取故事状态和写作上下文。" });

    const { buildWriterContext } = await import("@actalk/story-engine");
    const builtContext = await buildWriterContext({
      projectDir,
      chapter,
      chapterGoal,
      maxTimelineEvents,
      selectedCharacterIds: resolvedSelectedCharacterIds,
      selectedHookIds,
    });
    const context = contextRanking.rankContext(builtContext);
    if (context.sections.some((section) => section.name === "previous_uncommitted_draft")) {
      sendEvent("status", { message: "已读取上一章未入库工作稿作为连续性上下文。" });
    }
    const configured = await resolveConfiguredChatModel("fastDraft");
    const prompt = renderFastDraftPromptText(context);
    sendEvent("status", { message: "正在调用底层写作模型。" });

    const response = await fetch(`${configured.provider.baseUrl.replace(/\/+$/u, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(await buildProviderRequestHeaders({
          baseUrl: configured.provider.baseUrl,
          apiKey: configured.apiKey,
          customHeaders: configured.customHeaders,
        })),
      },
      body: JSON.stringify({
        model: configured.profile.model,
        // 不传 max_tokens：正文也是推理模型写，思考(reasoning)算进 max_tokens，小额度会把章节截断/写空；
        // 长度由提示词字数约束 + 过短自动补写重试兜底，模型自然收尾（见 llm-client 注释）。
        messages: [{ role: "user", content: prompt }],
        temperature: configured.profile.temperature ?? 0.8,
        stream: true,
      }),
    });

    if (!response.ok) {
      const raw = await response.text().catch(() => "");
      sendEvent("error", { error: `模型请求失败：${response.status} ${raw.slice(0, 300)}` });
      res.end();
      return;
    }

    let { content } = await streamOpenAICompatibleResponse(response, (delta) => {
      sendEvent("delta", { text: delta });
    });
    let draftBody = stripLeadingMarkdownChapterHeading(content);
    let validationError = validateStreamedDraftBody(draftBody);
    if (validationError) {
      sendEvent("status", { message: "流式返回正文过短，正在切换非流式重试。" });
      const retry = await callOpenAICompatibleChatModel({
        configured,
        messages: [{ role: "user", content: buildFastDraftRetryPrompt(prompt, lengthTarget) }],
        temperature: configured.profile.temperature ?? 0.8,
      });
      content = retry.content;
      draftBody = stripLeadingMarkdownChapterHeading(content);
      validationError = validateStreamedDraftBody(draftBody);
    }
    if (!validationError && isDraftUnderRequestedLength(draftBody, lengthTarget)) {
      sendEvent("status", { message: "正文低于本轮字数要求，正在补写重试。" });
      const retry = await callOpenAICompatibleChatModel({
        configured,
        messages: [{ role: "user", content: buildFastDraftRetryPrompt(prompt, lengthTarget) }],
        temperature: configured.profile.temperature ?? 0.8,
      });
      content = retry.content;
      draftBody = stripLeadingMarkdownChapterHeading(content);
      validationError = validateStreamedDraftBody(draftBody);
    }
    if (validationError) {
      sendEvent("error", { error: validationError });
      res.end();
      return;
    }
    const bounded = await ensureDraftBodyWithinLengthBounds({
      configured,
      chapter,
      chapterGoal,
      draftBody,
      lengthTarget,
    });
    if (!bounded.ok) {
      sendEvent("error", { error: bounded.error });
      res.end();
      return;
    }
    const streamBodyBeforeBounds = draftBody;
    draftBody = bounded.draftBody;
    validationError = validateStreamedDraftBody(draftBody);
    if (validationError) {
      sendEvent("error", { error: validationError });
      res.end();
      return;
    }
    content = draftBody;
    sendEvent("status", { message: "正在生成章节标题。" });
    const draftTitle = await generateChapterDraftTitle({
      configured,
      chapter,
      chapterGoal,
      content,
      fallbackTitle: `第${chapter}章`,
    });
    const fileTitle = formatChapterFileTitle(chapter, draftTitle);
    const draftPath = defaultDraftPath(projectDir, chapter);
    const draftContent = `# ${fileTitle}\n\n${draftBody}\n`;
    const overview = await withUiOverviewDetails(projectDir, await buildStateOverview({ projectDir, chapter, maxTimelineEvents }));
    sendEvent("done", {
      draftPath,
      draftTitle,
      draftContent,
      overview,
      draftLength: buildDraftLengthReport({
        draftBody,
        lengthTarget,
        ...(bounded.draftBody !== streamBodyBeforeBounds
          ? {
            finalLengthAfterTrim: countCjkChars(draftBody),
            whetherTrimmed: true,
          }
          : {}),
      }),
      contextBudget: contextBudgetPayload(contextRanking),
      characterSelection,
    });
    res.end();
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });
    }
    sendEvent("error", { error: error instanceof Error ? error.message : String(error) });
    res.end();
  }
}

async function handleDraftQuality(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
  try {
    if (req.method !== "POST") {
      writeJson(res, 405, { ok: false, error: "Only POST is supported." });
      return;
    }
    const body = await readJsonBody(req);
    const projectDir = requireBodyString(body.projectPath, "Project path is required.");
    if (!guardProjectPath(res, projectDir)) return;
    const chapter = requirePositiveBodyInteger(body.chapter, "Chapter is required.");
    // 与 quality_check 工具同源的健壮取稿：真显式正文 → 文件(带重试) → workspace 原始草稿，
    // 治草稿落盘时序竞争窗口里读到空/占位符被误报「正文为空/过短」（前端可能传到瞬时占位符）。
    const resolvedDraft = await resolveDraftContentForQualityCheck({
      projectDir,
      chapter,
      // 路由由前端传【编辑器实时正文】，是用户当下看到的真稿、可能比盘新 → 可信、顶格优先（trustExplicit）。
      // 与 agent 工具路相反：agent 路不信模型给的正文（afterfix·Codex：质检读了模型臆想的正文）。
      trustExplicit: true,
      ...(readString(body.draftContent) !== undefined ? { explicitDraftContent: readString(body.draftContent)! } : {}),
    });
    const draftContent = resolvedDraft.content;
    const deterministicQuality = await checkDraftBeforeCommit({ projectDir, chapter, draftContent });
    const quality = await judgeDraftQualityWithModel({
      projectDir,
      chapter,
      draftContent,
      deterministicQuality,
    });
    writeJson(res, 200, { ok: true, quality });
  } catch (error) {
    writeJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function resolveProjectDraftLengthTarget(
  projectDir: string,
  chapterGoal: string,
  requestedDraftLength?: number,
): Promise<DraftLengthTarget> {
  const writingRules = await readWritingRules(projectDir).catch(() => null);
  return resolveDraftLengthTarget({ chapterGoal, requestedDraftLength, writingRules });
}

function optionalStringList(value: unknown): readonly string[] | undefined {
  const values = readStringList(value);
  return values.length > 0 ? values : undefined;
}

async function handleDraftDirectEdit(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
  try {
    if (req.method !== "POST") {
      writeJson(res, 405, { ok: false, error: "Only POST is supported." });
      return;
    }
    const body = await readJsonBody(req);
    const projectDir = requireBodyString(body.projectPath, "Project path is required.");
    if (!guardProjectPath(res, projectDir)) return;
    const chapter = requirePositiveBodyInteger(body.chapter, "Chapter is required.");
    const instruction = requireBodyString(body.instruction, "修改要求不能为空。");
    const draftContent = requireBodyString(body.draftContent, "当前草稿不能为空。");
    const explicitReplacement = parseExplicitReplacementInstruction(instruction);
    if (explicitReplacement && !draftContent.includes(explicitReplacement.target)) {
      writeJson(res, 409, {
        ok: false,
        error: `未找到目标文本“${explicitReplacement.target}”，请确认要修改的位置。`,
      });
      return;
    }
    const configured = await resolveConfiguredChatModel("repair");
    const overview = await buildStateOverview({ projectDir, chapter, maxTimelineEvents: 8 }).catch(() => undefined);
    const { content, raw, response } = await callOpenAICompatibleChatModel({
      configured,
      temperature: configured.profile.temperature ?? 0.25,
      messages: [
        {
          role: "system",
          content: [
            "你是 StoryEngine 的草稿直接编辑 Agent。",
            "用户已经授权你直接修改左侧写作区的工作稿。不要输出建议，不要说稍后会改。",
            "只改用户明确要求的内容，尽量保留原文结构、标题、段落顺序和叙事语气。",
            "不得写入正式状态，不得新增未要求的大段剧情。",
            "必须返回 JSON。",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            chapter,
            instruction,
            overview,
            outputSchema: {
              reply: "string, 30字以内，说明已改到工作稿",
              changeSummary: "string, 80字以内",
              draftContent: "string, 完整改后草稿，保留 Markdown 标题",
            },
            draftContent,
          }, null, 2),
        },
      ],
    });
    if (!response.ok) {
      throw new Error(`修订模型请求失败：HTTP ${response.status} ${raw.slice(0, 300)}`);
    }
    const parsed = parseDirectEditModelPayload(content);
    if (!parsed) {
      writeJson(res, 422, { ok: false, error: DIRECT_EDIT_MODEL_FORMAT_ERROR });
      return;
    }
    // 改后诚实校验（afterfix·改稿谎报根治·同 revise_draft）：模型回吐的草稿与原稿逐字一致 = 实际什么都没改，
    // 绝不回 ok:true「已直接改到写作区」骗用户。空白归一比对，容忍纯排版差异。
    if (parsed.draftContent.replace(/\s+/gu, "") === draftContent.replace(/\s+/gu, "")) {
      writeJson(res, 422, {
        ok: false,
        error: "模型没有改动草稿（改后与原稿一致），未写入。请把要改的地方说得更具体，或重试。",
      });
      return;
    }
    writeJson(res, 200, {
      ok: true,
      result: {
        draftContent: parsed.draftContent,
        reply: parsed.reply ?? "已直接改到左侧写作区。",
        changeSummary: parsed.changeSummary ?? "已按要求修改草稿。",
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
}

function parseDirectEditModelPayload(content: string): {
  readonly draftContent: string;
  readonly reply?: string;
  readonly changeSummary?: string;
} | null {
  const candidates = Array.from(new Set([
    extractJsonObject(content),
    content.trim(),
  ].filter((item): item is string => Boolean(item))));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (!isRecord(parsed)) continue;
      const draftContent = readString(parsed.draftContent);
      if (!draftContent) continue;
      return {
        draftContent,
        reply: readString(parsed.reply),
        changeSummary: readString(parsed.changeSummary),
      };
    } catch {
      // Try the next safe candidate, then return a readable no-op error.
    }
  }

  return null;
}

function parseExplicitReplacementInstruction(instruction: string): { readonly target: string; readonly replacement: string } | null {
  const normalized = instruction.replace(/\s+/gu, " ").trim();
  const patterns = [
    /(?:把|将)\s*([“"'「『]?[^，。；;,.!?！？]+?[”"'」』]?)\s*(?:改成|改为)\s*([“"'「『]?[^，。；;,.!?！？]+?[”"'」』]?)(?:[，。；;,.!?！？]|$)/u,
    /替换\s*([“"'「『]?[^，。；;,.!?！？]+?[”"'」』]?)\s*为\s*([“"'「『]?[^，。；;,.!?！？]+?[”"'」』]?)(?:[，。；;,.!?！？]|$)/u,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    const target = cleanReplacementBoundary(match?.[1]);
    const replacement = cleanReplacementBoundary(match?.[2]);
    if (target && replacement) return { target, replacement };
  }
  return null;
}

function cleanReplacementBoundary(value: string | undefined): string | null {
  const cleaned = value
    ?.trim()
    .replace(/^[“"'「『]+/u, "")
    .replace(/[”"'」』]+$/u, "")
    .trim();
  return cleaned || null;
}

async function handleDraftAIReview(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
  try {
    if (req.method !== "POST") {
      writeJson(res, 405, { ok: false, error: "Only POST is supported." });
      return;
    }
    const body = await readJsonBody(req);
    const projectDir = requireBodyString(body.projectPath, "Project path is required.");
    if (!guardProjectPath(res, projectDir)) return;
    const chapter = requirePositiveBodyInteger(body.chapter, "Chapter is required.");
    const draftContentFromBody = readString(body.draftContent);
    const draftContent = draftContentFromBody ?? await readFile(defaultDraftPath(projectDir, chapter), "utf-8");
    const deterministicQuality = isRecord(body.deterministicQuality)
      ? readDraftQualityReport(body.deterministicQuality)
      : await checkDraftBeforeCommit({ projectDir, chapter, draftContent });
    const [overview, writingContextPack] = await Promise.all([
      buildStateOverview({ projectDir, chapter, maxTimelineEvents: 8 }),
      buildWritingContextPack({
        projectDir,
        chapter,
        userDirection: readString(body.userDirection) ?? "",
        currentChapterGoal: readString(body.chapterGoal),
        maxTimelineEvents: 3,
      }).catch(() => undefined),
    ]);
    const prompt = appendActualWordCountToReviewPrompt(
      buildDraftAIReviewPrompt({
        chapter,
        draftContent,
        chapterGoal: readString(body.chapterGoal),
        userDirection: readString(body.userDirection),
        deterministicQuality,
        stateOverview: overview,
        ...(writingContextPack ? { writingContextPack } : {}),
      }),
      countTextWords(draftContent),
    );
    const configured = await resolveConfiguredChatModel("draftReview");
    const report = await callDraftAIReviewModel({ configured, prompt }).catch((error): DraftAIReviewReport =>
      fallbackDraftAIReviewReport(error instanceof Error ? error.message : String(error)));
    writeJson(res, 200, {
      ok: true,
      review: report,
      model: configured.profile.model,
      profileId: configured.profile.id,
      usedFallback: report.verdict === "blocked" && report.issues.some((issue) => issue.id === "ai-review-format-error"),
    });
  } catch (error) {
    writeJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

async function generateChapterDraftTitle(input: {
  readonly configured: ResolvedChatModel;
  readonly chapter: number;
  readonly chapterGoal: string;
  readonly content: string;
  readonly fallbackTitle: string;
}): Promise<string> {
  try {
    const response = await fetch(`${input.configured.provider.baseUrl.replace(/\/+$/u, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(await buildProviderRequestHeaders({
          baseUrl: input.configured.provider.baseUrl,
          apiKey: input.configured.apiKey,
          customHeaders: input.configured.customHeaders,
        })),
      },
      body: JSON.stringify({
        model: input.configured.profile.model,
        messages: [
          {
            role: "system",
            content: "你是中文长篇小说章节标题助手。只输出一个章节标题，不要解释，不要引号，不要 Markdown，不要带\"第X章\"。标题应贴合本章内容，6 到 14 个汉字为宜。",
          },
          {
            role: "user",
            content: [
              `章节：第${input.chapter}章`,
              `本章方向：${input.chapterGoal}`,
              "本章正文节选：",
              input.content.slice(0, 1600),
            ].join("\n"),
          },
        ],
        temperature: 0.55,
        // 不传 max_tokens：推理模型连标题也先思考，48 的小额度会被思考吃光、标题输出为空只能退回兜底；
        // 标题长度由提示词约束（6~14 字），模型自然收尾（见 llm-client 注释）。
        stream: false,
      }),
    });
    if (!response.ok) return input.fallbackTitle;
    const raw = await response.text();
    const parsed = JSON.parse(raw) as { readonly choices?: readonly { readonly message?: { readonly content?: string } }[] };
    return sanitizeChapterTitle(parsed.choices?.[0]?.message?.content, input.fallbackTitle);
  } catch {
    return input.fallbackTitle;
  }
}

function sanitizeChapterTitle(value: string | undefined, fallbackTitle: string): string {
  const cleaned = value
    ?.replace(/```[\s\S]*?```/gu, "")
    .replace(/^#+\s*/u, "")
    .replace(/^[""'']+|[""'']+$/gu, "")
    .replace(/^第[一二三四五六七八九十百\d]+章\s*[·：:、-]?\s*/u, "")
    .replace(/\s+/gu, "")
    .trim();
  if (!cleaned) return fallbackTitle;
  return cleaned.slice(0, 24);
}

function formatChapterFileTitle(chapter: number, title: string): string {
  const cleanTitle = sanitizeChapterTitle(title, `第${chapter}章`);
  if (cleanTitle === `第${chapter}章`) return cleanTitle;
  return `第${chapter}章 · ${cleanTitle}`;
}

function validateStreamedDraftBody(value: string): string | null {
  const body = value
    .replace(/```[\s\S]*?```/gu, "")
    .replace(/^#+\s*第[一二三四五六七八九十百\d]+章[^\n]*$/gmu, "")
    .trim();
  const cjkCount = countCjkChars(body);
  const paragraphs = body.split(/\n{2,}/u).map((item) => item.trim()).filter(Boolean);
  if (cjkCount < 200 || paragraphs.length < 3) {
    return "模型返回的正文过短，疑似只返回标题或无效草稿；已拒绝写入 drafts/fast，请重新生成。";
  }
  return null;
}

function countCjkChars(value: string): number {
  return countDraftChineseCharacters(value);
}

function isDraftOverRequestedLength(draftBody: string, lengthTarget: DraftLengthTarget): boolean {
  return countCjkChars(draftBody) > lengthTarget.upperBound;
}

function isDraftUnderRequestedLength(draftBody: string, lengthTarget: DraftLengthTarget): boolean {
  return countCjkChars(draftBody) < lengthTarget.lowerBound;
}

function enforceDraftLengthTarget(input: {
  readonly draftBody: string;
  readonly lengthTarget: DraftLengthTarget;
  readonly allowDeterministicTrim: boolean;
}): { readonly ok: true; readonly draftBody: string } | { readonly ok: false; readonly error: string } {
  const currentLength = countCjkChars(input.draftBody);
  if (currentLength < input.lengthTarget.lowerBound) {
    return { ok: false, error: DRAFT_TOO_SHORT_ERROR };
  }
  if (currentLength <= input.lengthTarget.upperBound) {
    return { ok: true, draftBody: input.draftBody.trim() };
  }
  if (!input.allowDeterministicTrim) {
    return { ok: false, error: DRAFT_TOO_LONG_ERROR };
  }
  const trimmed = trimDraftBodyToLengthTarget(input.draftBody, input.lengthTarget);
  if (!trimmed.ok || validateStreamedDraftBody(trimmed.draftBody)) {
    return { ok: false, error: DRAFT_TOO_LONG_ERROR };
  }
  return { ok: true, draftBody: trimmed.draftBody.trim() };
}

async function ensureDraftBodyWithinLengthBounds(input: {
  readonly configured: ResolvedChatModel;
  readonly chapter: number;
  readonly chapterGoal: string;
  readonly draftBody: string;
  readonly lengthTarget: DraftLengthTarget;
}): Promise<{ readonly ok: true; readonly draftBody: string } | { readonly ok: false; readonly error: string }> {
  let candidate = input.draftBody;
  if (isDraftOverRequestedLength(candidate, input.lengthTarget)) {
    candidate = await compressDraftBodyToRequestedLength(input);
  }

  if (isDraftUnderRequestedLength(candidate, input.lengthTarget)) {
    candidate = await expandDraftBodyToRequestedLength({
      ...input,
      draftBody: candidate,
    });
  }

  const finalLength = countCjkChars(candidate);
  if (finalLength < input.lengthTarget.lowerBound || finalLength > input.lengthTarget.upperBound) {
    return { ok: false, error: DRAFT_TARGET_UNSATISFIED_ERROR };
  }
  const validationError = validateStreamedDraftBody(candidate);
  if (validationError) return { ok: false, error: validationError };
  return { ok: true, draftBody: candidate.trim() };
}

async function restoreDraftFile(draftPath: string, previousContent: string | undefined): Promise<void> {
  if (previousContent !== undefined) {
    await writeFile(draftPath, previousContent, "utf-8");
    return;
  }
  await rm(draftPath, { force: true });
}

async function compressDraftBodyToRequestedLength(input: {
  readonly configured: ResolvedChatModel;
  readonly chapter: number;
  readonly chapterGoal: string;
  readonly lengthTarget: DraftLengthTarget;
  readonly draftBody: string;
}): Promise<string> {
  const { requested, lowerBound, upperBound } = input.lengthTarget;
  const originalLength = countCjkChars(input.draftBody);
  const compressed = await callOpenAICompatibleChatModel({
    configured: input.configured,
    temperature: 0.25,
    messages: [
      {
        role: "system",
        content: [
          "你是 StoryEngine 的章节草稿压缩 Agent。",
          "只压缩正文，不改核心剧情、不新增场景、不输出标题、不解释。",
          `目标长度：${lowerBound}-${upperBound} 个中文字符。超过上限必须删减细节并收束。`,
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          chapter: input.chapter,
          chapterGoal: input.chapterGoal,
          originalLength,
          targetLength: {
            requested,
            lowerBound,
            upperBound,
          },
          draftBody: input.draftBody,
        }, null, 2),
      },
    ],
  });
  const candidate = stripLeadingMarkdownChapterHeading(compressed.content).trim();
  const candidateLength = countCjkChars(candidate);
  if (!candidate || validateStreamedDraftBody(candidate) || candidateLength < Math.floor(lowerBound * 0.7) || candidateLength >= originalLength) {
    return trimDraftBodyToLengthTarget(input.draftBody, input.lengthTarget).draftBody;
  }
  if (candidateLength > upperBound) {
    return trimDraftBodyToLengthTarget(candidate, input.lengthTarget).draftBody;
  }
  return candidate;
}

async function expandDraftBodyToRequestedLength(input: {
  readonly configured: ResolvedChatModel;
  readonly chapter: number;
  readonly chapterGoal: string;
  readonly lengthTarget: DraftLengthTarget;
  readonly draftBody: string;
}): Promise<string> {
  const { requested, lowerBound, upperBound } = input.lengthTarget;
  const currentLength = countCjkChars(input.draftBody);
  const expanded = await callOpenAICompatibleChatModel({
    configured: input.configured,
    temperature: 0.3,
    messages: [
      {
        role: "system",
        content: [
          "你是 StoryEngine 的章节草稿短目标兜底 Agent。",
          "只输出正文，不输出标题、不解释、不道歉。",
          "在不新增大段剧情的前提下补齐必要动作、感官细节和证据承接。",
          `目标长度：${lowerBound}-${upperBound} 个中文字符。必须高于下限，也不能超过上限。`,
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          chapter: input.chapter,
          chapterGoal: input.chapterGoal,
          currentLength,
          targetLength: {
            requested,
            lowerBound,
            upperBound,
          },
          draftBody: input.draftBody,
        }, null, 2),
      },
    ],
  });
  return stripLeadingMarkdownChapterHeading(expanded.content).trim();
}

async function callDraftAIReviewModel(input: {
  readonly configured: ResolvedChatModel;
  readonly prompt: string;
}): Promise<DraftAIReviewReport> {
  const response = await fetch(`${input.configured.provider.baseUrl.replace(/\/+$/u, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(await buildProviderRequestHeaders({
        baseUrl: input.configured.provider.baseUrl,
        apiKey: input.configured.apiKey,
        customHeaders: input.configured.customHeaders,
      })),
    },
    body: JSON.stringify({
      model: input.configured.profile.model,
      messages: [{ role: "user", content: input.prompt }],
      temperature: input.configured.profile.temperature ?? 0.35,
      // 不传 max_tokens：推理模型审稿先思考、思考吃额度会把 JSON 审稿结果截空（见 llm-client 注释）。
      response_format: { type: "json_object" },
      stream: false,
    }),
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`模型请求失败：${response.status} ${raw.slice(0, 180)}`);
  }
  const parsed = JSON.parse(raw) as { readonly choices?: readonly { readonly message?: { readonly content?: string } }[] };
  const content = parsed.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("模型返回了空内容。");
  return parseDraftAIReviewReport(content);
}

export const __draftRouteTest = {
  countCjkChars,
  resolveDraftLengthTarget,
  requestedDraftLengthBounds,
};
