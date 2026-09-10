/**
 * quality-service — draft 质检的共享 application service（双轨合一·评审簇第一波）。
 *
 * POST /api/draft/quality（routes/draft.ts handleDraftQuality）与 quality_check 工具
 * （agent/tools/quality-check.ts）此前各自进程内复刻同一编排，已实际漂移过；
 * 现在同调本 service 拿 canonical result，两侧只剩适配层投影：
 *   - 路由：HTTP 入参解析 + { ok, quality } 裸报告投影（无 refined/summary）。
 *   - 工具：ok/partialMiss/passed/refined/errorIssueCount + 用户可见 summary（D15 分层降噪输出面）。
 *
 * 编排：取真草稿 → checkDraftBeforeCommit（确定性规则）→ judge（AI 判定层）→ refined。
 * 只读：不写盘、不建快照、不带 snapshotId / refreshScope。
 *
 * 显式策略参数（原豁免清单里的分歧，收敛成参数而非暗差）：
 *   - trustExplicit（D14）：是否信任 explicitDraftContent 为权威真稿。
 *     路由传 true（前端送的是编辑器实时正文，可能比盘新）；工具默认 false（不信模型臆想的正文）。
 *   - onNoDraft（D16）：三处皆无真稿时怎么办。路由 "engine_empty_report"（把空串照常喂引擎，
 *     出 empty_draft 报告）；工具 "honest_short_circuit"（短路出 draft_not_found_for_check 诚实报告）。
 *   - judge（D6）：AI 判定层显式可注入——默认 judgeDraftQualityWithModel；单测/commit 预览等
 *     不调判定模型的调用方可注入透传桩（判定层调不调由调用方显式决定，不再是暗差）。
 */
import { readFile } from "node:fs/promises";
import { checkDraftBeforeCommit, type CommitQualityIssue, type CommitQualityReport } from "@actalk/story-engine";

import {
  chapterWorkspacePath,
  defaultDraftPath,
  hasRealDraftContent,
  isRecord,
  readStringAllowEmpty,
} from "../lib/project-io.js";
import { judgeDraftQualityWithModel } from "../lib/quality-judge.js";
import { refineQualityReport, type RefinedQualityReport } from "../lib/quality-report-refine.js";

/** AI 判定层：默认 judgeDraftQualityWithModel；调用方可注入确定性桩（不触网/不调判定模型）。 */
export type QualityJudge = (input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly draftContent: string;
  readonly deterministicQuality: CommitQualityReport;
}) => Promise<CommitQualityReport>;

/** D16 无稿策略：engine_empty_report=照常喂引擎出空稿报告；honest_short_circuit=短路出诚实「无稿」报告。 */
export type DraftQualityNoDraftPolicy = "engine_empty_report" | "honest_short_circuit";

export interface DraftQualityCheckInput {
  readonly projectDir: string;
  readonly chapter: number;
  readonly explicitDraftContent?: string;
  /** D14 显式策略：编辑器/路由传 true（实时稿顶格优先）；agent 工具路默认 false（盘稿优先）。 */
  readonly trustExplicit?: boolean;
  /** D16 显式策略：每条适配路必须声明无稿时的行为，不再各写各的。 */
  readonly onNoDraft: DraftQualityNoDraftPolicy;
  /** D6 显式策略：AI 判定层注入点（默认真判定；传透传桩=显式跳过判定模型）。 */
  readonly judge?: QualityJudge;
  readonly retries?: number;
  readonly delayMs?: number;
}

export interface DraftQualityCheckResult {
  readonly chapter: number;
  /** 三处（显式/文件/workspace）是否取到真稿；false 时 quality 按 onNoDraft 策略产出。 */
  readonly hasRealDraft: boolean;
  readonly draftContent: string;
  readonly quality: CommitQualityReport;
  /** 分层降噪（纯确定性派生）：路由不投影它（D15），工具投影成 refined/errorIssueCount/partialMiss。 */
  readonly refined: RefinedQualityReport;
}

export async function runDraftQualityCheck(input: DraftQualityCheckInput): Promise<DraftQualityCheckResult> {
  const { projectDir, chapter } = input;
  const resolved = await resolveDraftContentForQualityCheck({
    projectDir,
    chapter,
    ...(input.explicitDraftContent !== undefined ? { explicitDraftContent: input.explicitDraftContent } : {}),
    ...(input.trustExplicit !== undefined ? { trustExplicit: input.trustExplicit } : {}),
    ...(input.retries !== undefined ? { retries: input.retries } : {}),
    ...(input.delayMs !== undefined ? { delayMs: input.delayMs } : {}),
  });

  if (!resolved.hasRealDraft && input.onNoDraft === "honest_short_circuit") {
    // 三处皆无真稿 → 诚实短路：明确「还没正文可质检」，不把空/占位符喂引擎误报「正文为空/过短」（铁律④）。
    const issue: CommitQualityIssue = {
      severity: "error",
      type: "draft_not_found_for_check",
      message: "No draft body found to check for this chapter yet.",
    };
    const quality: CommitQualityReport = { passed: false, issues: [issue] };
    return { chapter, hasRealDraft: false, draftContent: resolved.content, quality, refined: refineQualityReport(quality) };
  }

  const draftContent = resolved.content;
  const deterministicQuality = await checkDraftBeforeCommit({ projectDir, chapter, draftContent });
  const judge = input.judge ?? judgeDraftQualityWithModel;
  const quality = await judge({ projectDir, chapter, draftContent, deterministicQuality });
  return { chapter, hasRealDraft: resolved.hasRealDraft, draftContent, quality, refined: refineQualityReport(quality) };
}

/**
 * 健壮解析「这章要质检的真草稿」——治真机 QA bug：新书写完立刻质检误报「正文为空/过短」。
 * 根因：草稿落盘有时序竞争窗口，裸 readFile 会读到空（FS 抖动）或显示用占位符（约50字→误报过短），
 * 把用户在编辑器/写作区明明看得见的真稿当没写。按可靠度取真稿：
 *   ① 显式正文（仅当是真稿；空串/占位符不算，治 generate_draft 偶发回空被透传当空稿）
 *   ② 工作稿文件 drafts/fast/*.md（带 FS 抖动重试：刚写盘偶发读空/读到占位符，重试即得真稿）
 *   ③ workspace 原始 draftContent（编辑器看到的就是它；文件暂空/占位时它常已有真稿）
 *   ④ 三处皆无真稿 → hasRealDraft=false，上层诚实回报「还没正文可质检」（不喂占位符给引擎误报）。
 * retries/delayMs 仅为单测可注入（默认 3×60ms，与 generate_draft 的 readDraftBodyWithRetry 同源）。
 */
export async function resolveDraftContentForQualityCheck(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly explicitDraftContent?: string;
  /**
   * 是否信任 explicitDraftContent 为权威真稿（afterfix·Codex 真机：质检读了模型臆想的正文）。
   * - true：编辑器/路由传的【用户实时正文】，可能比盘新 → 顶格优先（draft.ts 路由用）。
   * - false（默认）：**agent 工具路**——模型给的正文不可信（可能臆想/过期），一律不盖过磁盘真稿，
   *   只在磁盘+workspace 都无真稿（FS 抖动）时才作末位兜底。质检/审稿评的必须是「真要入库的盘上正文」。
   */
  readonly trustExplicit?: boolean;
  readonly retries?: number;
  readonly delayMs?: number;
}): Promise<{ readonly content: string; readonly hasRealDraft: boolean }> {
  // 可信显式正文（编辑器实时稿）→ 顶格优先。
  if (input.trustExplicit && input.explicitDraftContent !== undefined && hasRealDraftContent(input.explicitDraftContent)) {
    return { content: input.explicitDraftContent, hasRealDraft: true };
  }

  const retries = input.retries ?? 3;
  const delayMs = input.delayMs ?? 60;
  const draftPath = defaultDraftPath(input.projectDir, input.chapter);
  let fileContent = "";
  for (let attempt = 0; attempt < retries; attempt++) {
    fileContent = await readFile(draftPath, "utf-8").catch(() => "");
    if (hasRealDraftContent(fileContent)) return { content: fileContent, hasRealDraft: true };
    if (attempt < retries - 1 && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  const workspaceDraft = await readWorkspaceDraftContent(input.projectDir, input.chapter);
  if (hasRealDraftContent(workspaceDraft)) return { content: workspaceDraft!, hasRealDraft: true };

  // explicitDraftContent 末位兜底（不可信源/agent 路）：仅磁盘+workspace 都无真稿时才用，绝不盖过盘上真稿。
  if (input.explicitDraftContent !== undefined && hasRealDraftContent(input.explicitDraftContent)) {
    return { content: input.explicitDraftContent, hasRealDraft: true };
  }

  return { content: fileContent, hasRealDraft: false };
}

/** 直读 workspace 记录的原始 draftContent 字段（编辑器/写作区显示用的草稿，绕开 readChapterWorkspaceSnapshot 的文件优先解析）。 */
async function readWorkspaceDraftContent(projectDir: string, chapter: number): Promise<string | undefined> {
  const parsed = await readFile(chapterWorkspacePath(projectDir, chapter), "utf-8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => null);
  return isRecord(parsed) ? readStringAllowEmpty(parsed.draftContent) : undefined;
}
