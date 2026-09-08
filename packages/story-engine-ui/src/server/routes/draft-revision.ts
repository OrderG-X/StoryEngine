/**
 * POST /api/draft/revision/preview — AI-assisted draft revision preview.
 * POST /api/draft/revision/apply — apply a revision to the draft.
 */
import { readFile, writeFile } from "node:fs/promises";
import {
  buildStateOverview,
  buildWritingContextPack,
  buildDraftRevisionPrompt,
  fallbackDraftRevisionPreview,
  applyDraftRevisionToContent,
  buildDeterministicRevisionPreview,
  countDraftWords,
  parseDraftRevisionPreview,
} from "@actalk/story-engine";
import type { DraftRevisionPreview, DraftRevisionTask } from "@actalk/story-engine";
import {
  assertStoryEngineProject,
  defaultDraftPath,
  extractDraftTitle,
  guardProjectPath,
  readDraftRevisionTask,
  readDraftRevisionPreviewObj,
  readJsonBody,
  readString,
  requireBodyString,
  requirePositiveBodyInteger,
  withUiOverviewDetails,
  writeJson,
  type MiddlewareStack,
} from "../lib/project-io.js";
import { buildProviderRequestHeaders, resolveConfiguredChatModel, type ResolvedChatModel } from "../lib/llm-client.js";
import { createSnapshot } from "../lib/snapshot.js";

export function registerDraftRevisionRoutes(middlewares: MiddlewareStack): void {
  middlewares.use(async (req, res, next) => {
    if (req.url?.startsWith("/api/draft/revision/preview")) {
      await handleDraftRevisionPreview(req, res);
      return;
    }
    if (req.url?.startsWith("/api/draft/revision/apply")) {
      await handleDraftRevisionApply(req, res);
      return;
    }
    next();
  });
}

async function handleDraftRevisionPreview(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
  try {
    if (req.method !== "POST") {
      writeJson(res, 405, { ok: false, error: "Only POST is supported." });
      return;
    }
    const body = await readJsonBody(req);
    const projectDir = requireBodyString(body.projectPath, "Project path is required.");
    if (!guardProjectPath(res, projectDir)) return;
    const chapter = requirePositiveBodyInteger(body.chapter, "Chapter is required.");
    await assertStoryEngineProject(projectDir);
    const draftContent = readString(body.draftContent) ?? await readFile(defaultDraftPath(projectDir, chapter), "utf-8");
    const task = readDraftRevisionTask(body.task, chapter);
    if (!task.targetText.trim()) {
      writeJson(res, 400, { ok: false, error: "修订任务缺少原文片段，请先选择要修的段落。" });
      return;
    }
    if (!draftContent.includes(task.targetText.trim())) {
      writeJson(res, 400, { ok: false, error: "未在当前草稿中找到原文片段，请重新选择目标段落。" });
      return;
    }
    if (draftContent.indexOf(task.targetText.trim(), draftContent.indexOf(task.targetText.trim()) + task.targetText.trim().length) >= 0) {
      writeJson(res, 400, { ok: false, error: "原文片段在草稿中出现多次，请选择更精确的目标段落。" });
      return;
    }
    const [overview, writingContextPack] = await Promise.all([
      buildStateOverview({ projectDir, chapter, maxTimelineEvents: 8 }),
      buildWritingContextPack({
        projectDir,
        chapter,
        userDirection: "",
        currentChapterGoal: task.revisionGoal,
        maxTimelineEvents: 3,
      }).catch(() => undefined),
    ]);
    const prompt = buildDraftRevisionPrompt({
      task,
      draftContent,
      stateOverview: overview,
      ...(writingContextPack ? { writingContextPack } : {}),
    });
    const configured = await resolveConfiguredChatModel("repair");
    const modelPreview = await callDraftRevisionModel({ configured, prompt, task }).catch((error): DraftRevisionPreview =>
      fallbackDraftRevisionPreview(task, error instanceof Error ? error.message : String(error)));
    const deterministicPreview = buildDeterministicRevisionPreview(task);
    const preview = deterministicPreview && modelPreview.afterText.trim() === task.targetText.trim()
      ? deterministicPreview
      : modelPreview;
    writeJson(res, 200, {
      ok: true,
      task: { ...task, status: "preview_generated" },
      preview,
      model: configured.profile.model,
      profileId: configured.profile.id,
      usedFallback: preview.afterText === preview.beforeText && preview.warnings.includes("未应用任何修改。"),
    });
  } catch (error) {
    writeJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleDraftRevisionApply(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
  try {
    if (req.method !== "POST") {
      writeJson(res, 405, { ok: false, error: "Only POST is supported." });
      return;
    }
    const body = await readJsonBody(req);
    const projectDir = requireBodyString(body.projectPath, "Project path is required.");
    if (!guardProjectPath(res, projectDir)) return;
    const chapter = requirePositiveBodyInteger(body.chapter, "Chapter is required.");
    if (body.confirm !== true) {
      writeJson(res, 400, { ok: false, error: "应用修订到草稿需要 confirm=true。" });
      return;
    }
    await assertStoryEngineProject(projectDir);
    const preview = readDraftRevisionPreviewObj(body.preview);
    const draftPath = defaultDraftPath(projectDir, chapter);
    const draftContent = await readFile(draftPath, "utf-8");
    const updatedContent = applyDraftRevisionToContent({
      draftContent,
      beforeText: preview.beforeText,
      afterText: preview.afterText,
    });
    await createSnapshot(projectDir, "修订应用前快照");
    await writeFile(draftPath, `${updatedContent.trimEnd()}\n`, "utf-8");
    const overview = await withUiOverviewDetails(projectDir, await buildStateOverview({ projectDir, chapter, maxTimelineEvents: 8 }));
    writeJson(res, 200, {
      ok: true,
      result: {
        applied: true,
        chapter,
        draftPath,
        updatedWordCount: countDraftWords(updatedContent),
      },
      draftContent: `${updatedContent.trimEnd()}\n`,
      overview,
    });
  } catch (error) {
    writeJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function callDraftRevisionModel(input: {
  readonly configured: ResolvedChatModel;
  readonly prompt: string;
  readonly task: DraftRevisionTask;
}): Promise<DraftRevisionPreview> {
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
      temperature: input.configured.profile.temperature ?? 0.45,
      // 不传 max_tokens：推理模型改写先思考、思考吃额度会把 JSON 改写结果截空（见 llm-client 注释）。
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
  return parseDraftRevisionPreview(content, input.task);
}
