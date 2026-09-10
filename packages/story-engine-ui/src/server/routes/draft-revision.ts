/**
 * POST /api/draft/revision/preview — AI-assisted draft revision preview.
 * POST /api/draft/revision/apply — apply a revision to the draft.
 *
 * 双轨合一：编排（定位/预览/守卫/落盘/模型调用）已收编进 services/revision-service.ts，
 * 与 agent/tools/revise-draft.ts 共享同一实现；本文件只做 HTTP 适配——参数解析、confirm 契约、
 * 状态码与响应整形。守卫收编给本路带来的行为变化（D21 归一兜底 / D22 漂移守卫 / D23 精确快路 /
 * D25 no-op 诚实 / 模型调用走 llm-client 统一路）见 service 头注释与 parity/revise-draft.parity.test.ts。
 */
import {
  buildStateOverview,
  countDraftWords,
} from "@actalk/story-engine";
import {
  assertStoryEngineProject,
  guardProjectPath,
  isRecord,
  readDraftRevisionPreviewObj,
  readDraftRevisionTask,
  readJsonBody,
  readString,
  requireBodyString,
  requirePositiveBodyInteger,
  withUiOverviewDetails,
  writeJson,
  type MiddlewareStack,
} from "../lib/project-io.js";
import { createSnapshot } from "../lib/snapshot.js";
import {
  applyRevision,
  createRevisionModelChannel,
  previewRevision,
  type RevisionFailure,
} from "../services/revision-service.js";

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
    const task = readDraftRevisionTask(body.task, chapter);
    const draftContent = readString(body.draftContent);
    // D23 收编：replacementText 原属工具路独有（readDraftRevisionTask 不收此字段，这里从原始 body 直读）。
    const replacementText = isRecord(body.task) ? readString(body.task.replacementText) : undefined;
    const channel = await createRevisionModelChannel();
    const outcome = await previewRevision({
      projectDir,
      chapter,
      task,
      ...(draftContent !== undefined ? { draftContent } : {}),
      ...(replacementText !== undefined ? { replacementText } : {}),
      callModel: channel.call,
      // 前端 A.5 契约（模型失败回 200 + 安全兜底预览）与代词修复确定性预览：HTTP 路刻意保留的策略参数。
      policies: { modelErrorFallback: true, deterministicPreview: true },
    });
    if (!outcome.ok) {
      writeJson(res, 400, { ok: false, error: previewRefusalMessage(outcome) });
      return;
    }
    writeJson(res, 200, {
      ok: true,
      task: { ...outcome.task, status: "preview_generated" },
      preview: outcome.preview,
      model: channel.model,
      profileId: channel.profileId,
      usedFallback: outcome.preview.afterText === outcome.preview.beforeText && outcome.preview.warnings.includes("未应用任何修改。"),
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
    // D24 形态分歧：HTTP 两步的 apply 步必须显式确认（工具一步路由工具契约自持）。
    if (body.confirm !== true) {
      writeJson(res, 400, { ok: false, error: "应用修订到草稿需要 confirm=true。" });
      return;
    }
    await assertStoryEngineProject(projectDir);
    const preview = readDraftRevisionPreviewObj(body.preview);
    const outcome = await applyRevision({
      projectDir,
      chapter,
      preview,
      // 快照时序保持原语义：守卫全过之后、落盘之前建「修订应用前快照」。
      beforeWrite: () => createSnapshot(projectDir, "修订应用前快照"),
    });
    if (!outcome.ok) {
      writeJson(res, 400, { ok: false, error: applyRefusalMessage(outcome) });
      return;
    }
    const overview = await withUiOverviewDetails(projectDir, await buildStateOverview({ projectDir, chapter, maxTimelineEvents: 8 }));
    writeJson(res, 200, {
      ok: true,
      result: {
        applied: true,
        chapter,
        draftPath: outcome.draftPath,
        updatedWordCount: countDraftWords(outcome.updatedContent),
      },
      draftContent: `${outcome.updatedContent.trimEnd()}\n`,
      overview,
    });
  } catch (error) {
    writeJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** preview 步守卫拒绝的用户可见文案（前三个保持本路历史原文；后三个是 D22/D23 收编带来的新诚实拒）。 */
function previewRefusalMessage(failure: RevisionFailure): string {
  switch (failure.code) {
    case "target_empty":
      return "修订任务缺少原文片段，请先选择要修的段落。";
    case "target_not_found":
      return "未在当前草稿中找到原文片段，请重新选择目标段落。";
    case "target_ambiguous":
      return "原文片段在草稿中出现多次，请选择更精确的目标段落。";
    case "exact_replacement_noop":
      return "给的替换文本与原文一致，等于没改；草稿未改动。";
    case "before_text_not_found":
    case "before_text_ambiguous":
      return "模型回吐的原句没法在草稿里唯一定位，未改动草稿。请重试或把要改的片段说得更精确。";
    case "drift_rejected":
      return "模型改写的不是你选择的片段（它去动了别处），草稿未改动。请重新选择目标段落或重试。";
    default:
      return failure.detail ?? "修订预览生成失败。";
  }
}

/** apply 步守卫拒绝的用户可见文案（not_found/ambiguous 保持原引擎抛错文案；no-op 是 D25 收编的新诚实拒）。 */
function applyRefusalMessage(failure: RevisionFailure): string {
  switch (failure.code) {
    case "before_text_not_found":
      return "未在当前草稿中找到原文片段，请重新选择目标段落。";
    case "before_text_ambiguous":
      return "原文片段在草稿中出现多次，请选择更精确的目标段落。";
    case "noop":
      return "修订后内容与原文一致，等于没有任何修改；草稿未改动。";
    default:
      return failure.detail ?? "修订应用失败。";
  }
}
