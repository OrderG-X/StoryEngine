/**
 * POST /api/draft/generate — non-streaming draft generation.
 * POST /api/draft/stream — SSE streaming draft generation.
 * POST /api/draft/apply-candidate — persist a picked draft candidate (snapshot + write, no model call).
 * POST /api/draft/ai-review — AI review of draft.
 * POST /api/draft/direct-edit — model-driven direct edit of the working draft.
 * POST /api/draft/quality — draft quality check.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  buildStateOverview,
  applyDraftLengthConstraint,
  buildDraftLengthReport,
  buildFastDraftRetryPrompt,
  renderFastDraftPromptText,
  resolveDraftLengthTarget,
  trimDraftBodyToLengthTarget,
} from "@actalk/story-engine";
import type { DraftLengthTarget } from "@actalk/story-engine";
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
import { buildProviderRequestHeaders, callOpenAICompatibleChatModel, createConfiguredWriterClient, createIdleAbort, resolveConfiguredChatModel, STREAM_IDLE_TIMEOUT_MS, streamOpenAICompatibleResponse, type ResolvedChatModel } from "../lib/llm-client.js";
import { abortOnClientDisconnect } from "./agent-chat.js";
import { createSnapshot } from "../lib/snapshot.js";
import { contextBudgetPayload, makeWriterRankContext, resolveWriterTokenBudget } from "../agent/context-budget/rank-writer-context.js";
import { resolveSelectedCharacterIds } from "../agent/presence/in-scene-detector.js";
import { snapshotBeforeDraftOverwrite } from "../agent/tools/snapshot-on-draft-overwrite.js";
import { runDraftQualityCheck } from "../services/quality-service.js";
import { runDraftAIReview } from "../services/review-service.js";
import {
  countCjkChars,
  generateDraftCandidate,
  resolveProjectDraftLengthTarget,
  runGenerateDraft,
  validateStreamedDraftBody,
} from "../services/draft-service.js";

const DIRECT_EDIT_MODEL_FORMAT_ERROR = "修订模型返回格式不完整，请重试或换一种修改要求。";
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

// 共享编排在 services/draft-service.ts（与 generate_draft 工具同调 runGenerateDraft / generateDraftCandidate）。
// 本路由只剩 HTTP 适配：入参解析 → service 调用 → 200/422 投影。本路由的显式策略（D1/D2/D4 处置）：
//   - lengthPolicy:"enforce_or_rollback"（D1 按钮路现状）：低于下限拒写+回滚旧稿 → 422；超上限确定性裁剪落盘。
//   - aiFlavorRecheck:false（D2 现状）：不给引擎传回检规则、不接 autoDeAi/beats 裁决栈（产品未给按钮路开回检）。
//   - 快照（D4 刻意收敛）：与工具路同一 helper 同一语义——仅覆盖已有非空草稿前建可撤销快照，
//     首次出稿无旧稿不建空快照（原「每次无条件 createSnapshot」收敛；覆盖写前必有撤销点一寸未让）。
//   - 引擎拒稿的 ok 契约（2026-09-11 诚实修复）：runGenerateDraft 返回 ok:false 且无 rejection 时
//     （引擎校验拒稿 passed:false / 全候选失败 / 优胜稿落盘失败），本路由如实 422 + ok:false + error，
//     不再 200 ok:true + 空 draftContent 假成功（SWE P1-3；与工具路 ok:false 同向、与 D18 收敛同先例：
//     前端 generateDraft 对 ok:false/非 2xx 都走 throw；主出稿路径是 SSE 流，本路无前端的假完成卡风险）。
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
    const writerClient = await createConfiguredWriterClient("fastDraft");
    const baseInput = {
      projectDir,
      chapter,
      chapterGoal: rawChapterGoal,
      requestedDraftLength: readPositiveInteger(body.requestedDraftLength),
      selectedCharacterIds: optionalStringList(body.selectedCharacterIds),
      selectedHookIds: optionalStringList(body.selectedHookIds),
      maxTimelineEvents: readPositiveInteger(body.maxTimelineEvents),
      contextTokenBudget: readPositiveInteger(body.contextTokenBudget),
      maxOutputTokens: readPositiveInteger(body.maxOutputTokens),
      writerClient,
    };
    // 抽卡候选（persist:false，D5 的 HTTP 侧）：生成一版正文【不写盘、不快照】，临时返回给前端并排展示，挑中才落盘。
    if (body.persist === false) {
      const { candidate, characterSelection, contextRanking } = await generateDraftCandidate(baseInput);
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
    await snapshotBeforeDraftOverwrite(projectDir, chapter, `第${chapter}章再次出稿前快照`);
    const result = await runGenerateDraft({
      ...baseInput,
      policies: { lengthPolicy: "enforce_or_rollback", aiFlavorRecheck: false },
    });
    if (result.rejection) {
      writeJson(res, 422, { ok: false, error: result.rejection.error });
      return;
    }
    // 引擎拒稿/失败（ok:false 且无 rejection）：诚实 422，error 借 canonical summary（与工具侧同一文案）；
    // report 照带——引擎 issues 里有拒稿真相，不藏。
    if (!result.ok) {
      writeJson(res, 422, {
        ok: false,
        error: result.summary,
        ...(result.http.report ? { report: result.http.report } : {}),
      });
      return;
    }
    const finalDraftContent = result.http.draftContent;
    const overview = await withUiOverviewDetails(projectDir, result.overview);
    writeJson(res, 200, {
      ok: true,
      report: result.http.report,
      draftContent: finalDraftContent,
      draftTitle: extractDraftTitle(finalDraftContent) ?? result.http.report?.title,
      overview,
      contextBudget: contextBudgetPayload(result.http.contextRanking),
      characterSelection: result.characterSelection,
      // 降级留痕（enforce 回读失败/正文未载入）：canonical http.warnings 随 200 投影带出——
      // 否则 ok:true+空稿对 HTTP 调用方零信号（形同假成功；此前警告只藏在未被投影的 summary 里）。
      ...(result.http.warnings?.length ? { warnings: [...result.http.warnings] } : {}),
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
    await createSnapshot(projectDir, `工作稿生成前快照：第${chapter}章`);

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
      sendEvent("status", { message: "已读取上一章未定稿工作稿作为连续性上下文。" });
    }
    const configured = await resolveConfiguredChatModel("fastDraft");
    const prompt = renderFastDraftPromptText(context);
    sendEvent("status", { message: "正在调用底层写作模型。" });

    // 出稿流直连上游 fetch 守同一套空闲超时铁律（同 streamChatModelToText）：有字节就续命、
    // 彻底静默超 STREAM_IDLE_TIMEOUT_MS 才判死、绝不设总时长上限；客户端断开（res close 且
    // writableEnded===false，req close 不可信——见 agent-chat）同步掐掉上游 fetch，不再白烧 token。
    const idle = createIdleAbort(STREAM_IDLE_TIMEOUT_MS);
    const disconnect = abortOnClientDisconnect(res);
    const abortUpstreamOnDisconnect = (): void => idle.controller.abort();
    disconnect.signal.addEventListener("abort", abortUpstreamOnDisconnect, { once: true });
    let gotBytes = false; // 是否收过任何字节——区分「从头零响应」与「流到一半断流」，错误文案才诚实
    let content = "";
    try {
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
        signal: idle.controller.signal,
      });

      if (!response.ok) {
        const raw = await response.text().catch(() => "");
        sendEvent("error", { error: `模型请求失败：${response.status} ${raw.slice(0, 300)}` });
        res.end();
        return;
      }

      const streamed = await streamOpenAICompatibleResponse(
        response,
        (delta) => {
          sendEvent("delta", { text: delta });
        },
        undefined,
        () => {
          gotBytes = true;
          idle.kick();
        },
      );
      content = streamed.content;
    } catch (error) {
      if (idle.controller.signal.aborted) {
        const idleSecs = Math.round(STREAM_IDLE_TIMEOUT_MS / 1000);
        sendEvent("error", {
          error: disconnect.signal.aborted
            ? "客户端已断开，已中止本次出稿生成。"
            : gotBytes
              ? `模型生成中途静默超过 ${idleSecs}s（已收到部分输出后上游断流，长内容生成时常见），请重试。`
              : `模型连接静默超过 ${idleSecs}s（一直没有任何响应），判定连接已死，请重试。`,
        });
        res.end();
        return;
      }
      throw error;
    } finally {
      disconnect.signal.removeEventListener("abort", abortUpstreamOnDisconnect);
      idle.dispose();
    }

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
    // 共享编排在 services/quality-service.ts（与 quality_check 工具同调）。本路由的显式策略：
    // trustExplicit:true（前端传【编辑器实时正文】，是用户当下看到的真稿、可能比盘新 → 顶格优先，D14；
    // 与 agent 工具路相反：agent 路不信模型给的正文）+ onNoDraft "engine_empty_report"
    // （无稿也把空串照常喂引擎，出 empty_draft 报告，D16）。
    const result = await runDraftQualityCheck({
      projectDir,
      chapter,
      trustExplicit: true,
      onNoDraft: "engine_empty_report",
      ...(readString(body.draftContent) !== undefined ? { explicitDraftContent: readString(body.draftContent)! } : {}),
    });
    writeJson(res, 200, { ok: true, quality: result.quality });
  } catch (error) {
    writeJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
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
    // 共享编排在 services/review-service.ts（与 ai_review 工具同调）。本路由的显式策略：
    // trustExplicit:true（前端传【编辑器实时正文】，可信、顶格优先，D19）+ deterministicQuality 预传通道。
    // chapterGoal/userDirection 只做类型守卫、原样透传——trim+空白→undefined 的归一收在 service 单点
    // （与工具路同口径，SWE P1-5；这里不再 readString 预 trim，避免两处各归一各的）。
    const result = await runDraftAIReview({
      projectDir,
      chapter,
      trustExplicit: true,
      ...(readString(body.draftContent) !== undefined ? { explicitDraftContent: readString(body.draftContent)! } : {}),
      ...(typeof body.chapterGoal === "string" ? { chapterGoal: body.chapterGoal } : {}),
      ...(typeof body.userDirection === "string" ? { userDirection: body.userDirection } : {}),
      ...(isRecord(body.deterministicQuality) ? { deterministicQuality: readDraftQualityReport(body.deterministicQuality) } : {}),
    });
    if (!result.ok) {
      // 失败语义已与工具对齐（同一 canonical summary）：D17 无稿 → 状态码保持 500 兼容；
      // D18 模型回退 → 200 + ok:false 诚实显红（前端 reviewDraftWithAI 对 ok:false 走 throw → 失败卡，
      // 不再渲染「审稿完成：被阻止」的假完成卡）。
      writeJson(res, result.kind === "no_draft" ? 500 : 200, { ok: false, error: result.summary });
      return;
    }
    writeJson(res, 200, {
      ok: true,
      review: result.review,
      model: result.model,
      profileId: result.profileId,
      usedFallback: result.usedFallback,
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
    // 短调用收拢到非流式 helper：自带总时长上限（死连 120s 兜底退回 fallbackTitle，不再挂住路由）、
    // Qwen 非流式思考开关翻译也一并生效；helper 结构性不传 max_tokens（见其注释）。
    const { content } = await callOpenAICompatibleChatModel({
      configured: input.configured,
      temperature: 0.55,
      timeoutMs: 120_000,
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
    });
    return sanitizeChapterTitle(content, input.fallbackTitle);
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

// countCjkChars / validateStreamedDraftBody 已迁入 services/draft-service.ts（顶部 import）——
// 出稿流特有的「过短补写重试 + 压缩/扩写兜底」编排留在本路由层（SSE 特有：直连上游 fetch 流式吐字、
// 断流重试、不落盘由前端接稿，与非流式/工具路无共享编排面，见 draft-service.ts 头注释）。

function isDraftOverRequestedLength(draftBody: string, lengthTarget: DraftLengthTarget): boolean {
  return countCjkChars(draftBody) > lengthTarget.upperBound;
}

function isDraftUnderRequestedLength(draftBody: string, lengthTarget: DraftLengthTarget): boolean {
  return countCjkChars(draftBody) < lengthTarget.lowerBound;
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

export const __draftRouteTest = {
  countCjkChars,
  resolveDraftLengthTarget,
};
