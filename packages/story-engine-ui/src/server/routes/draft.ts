/**
 * POST /api/draft/generate — 抽卡候选（persist:false）：生成一版正文，不写盘、不快照。
 * POST /api/draft/apply-candidate — 把挑中的候选写进工作稿（先存档，不调模型）。
 *
 * 重构 P4 删掉了这里的落盘出稿、流式出稿、审稿、硬伤检查、直接改稿五条路：
 * 出稿/审稿/硬伤检查都走对话通道（按钮发结构化动作，或 AI 调工具），只有一条路。
 */
import { buildStateOverview } from "../book/state-overview.js";
import { resolveDraftLengthTarget } from "../writing/draft-length-control.js";
import {
  assertStoryEngineProject,
  extractDraftTitle,
  guardProjectPath,
  readJsonBody,
  readPositiveInteger,
  readString,
  readStringList,
  requireBodyString,
  requirePositiveBodyInteger,
  writeJson,
  type MiddlewareStack,
} from "../lib/project-io.js";
import { withUiOverviewDetails } from "../services/ui-overview.js";
import { createConfiguredWriterClient } from "../writing/writer-client.js";
import { scrubLocalAbsolutePaths } from "../lib/local-path-scrubber.js";
import { runWithSnapshot } from "../lib/snapshot.js";
import { writeAiDraft } from "../lib/ai-draft-write.js";
import { contextBudgetPayload } from "../writing/rank-writer-context.js";
import { callConfiguredPlannerModel } from "../editorial/index.js";
import { countCjkChars, generateDraftCandidate } from "../services/draft-service.js";

export function registerDraftRoutes(middlewares: MiddlewareStack): void {
  middlewares.use(async (req, res, next) => {
    if (req.url?.startsWith("/api/draft/generate")) {
      await handleGenerateDraft(req, res);
      return;
    }
    if (req.url?.startsWith("/api/draft/apply-candidate")) {
      await handleApplyDraftCandidate(req, res);
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
    // 重构 P4：这条路只剩抽卡候选（persist:false：生成一版、不写盘）。落盘出稿只走对话通道
    // （「写这一章」按钮发结构化动作 / AI 调 generate_draft），有章纲、核账、作者档护栏，不再有第二条路。
    if (body.persist !== false) {
      writeJson(res, 410, { ok: false, error: "这条出稿路已经撤了：请点「AI 写这一章」或在对话里让 AI 写。" });
      return;
    }
    const projectDir = requireBodyString(body.projectPath, "Project path is required.");
    if (!guardProjectPath(res, projectDir)) return;
    // P1-8：非流式出稿路此前漏校验，会在任意家目录 git init/改提交身份/提交
    await assertStoryEngineProject(projectDir);
    const chapter = requirePositiveBodyInteger(body.chapter, "Chapter is required.");
    const rawChapterGoal = readString(body.chapterGoal) ?? `继续第 ${chapter} 章。`;
    const writerClient = await createConfiguredWriterClient("fastDraft");
    const baseInput = {
      projectDir,
      chapter,
      chapterGoal: rawChapterGoal,
      requestedDraftLength: readPositiveInteger(body.requestedDraftLength),
      selectedCharacters: optionalStringList(body.selectedCharacters),
      selectedHookIds: optionalStringList(body.selectedHookIds),
      maxTimelineEvents: readPositiveInteger(body.maxTimelineEvents),
      contextTokenBudget: readPositiveInteger(body.contextTokenBudget),
      maxOutputTokens: readPositiveInteger(body.maxOutputTokens),
      writerClient,
    };
    // 抽卡候选（persist:false，D5 的 HTTP 侧）：生成一版正文【不写盘、不快照】，临时返回给前端并排展示，挑中才落盘。
    const { candidate, characterSelection, contextRanking, planNote } = await generateDraftCandidate({
      ...baseInput,
      plannerCallModel: callConfiguredPlannerModel,
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
      ...(planNote ? { planNote } : {}),
    });
  } catch (error) {
    writeJson(res, 500, {
      ok: false,
      error: scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error)),
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
    // 快照与写稿同一把书锁（commit_apply 切不进「读稿与落章之间」）；写稿走 draft.write（重构 P7）。
    const { result: written } = await runWithSnapshot(projectDir, `抽卡选用候选前快照：第${chapter}章`, () =>
      writeAiDraft(projectDir, { chapter, body: draftContent }));
    const draftPath = written.path;
    const overview = await withUiOverviewDetails(projectDir, await buildStateOverview({ projectDir, chapter, maxTimelineEvents: 8 }));
    writeJson(res, 200, {
      ok: true,
      result: { applied: true, chapter, draftPath },
      draftContent: written.content,
      draftTitle: extractDraftTitle(draftContent) ?? `第${chapter}章`,
      overview,
    });
  } catch (error) {
    writeJson(res, 500, { ok: false, error: scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error)) });
  }
}

function optionalStringList(value: unknown): readonly string[] | undefined {
  const values = readStringList(value);
  return values.length > 0 ? values : undefined;
}

export const __draftRouteTest = {
  countCjkChars,
  resolveDraftLengthTarget,
};
