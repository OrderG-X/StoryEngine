/**
 * 取「这章要检查的真草稿」（审稿用）。硬伤检查本身（checkDraftBeforeCommit + refined）在 inspect-service 的 runQualityCheck，
 * 写作版本 P2a 起对话、按钮都交 inspect.run，原来的 quality_check 工具和它的编排一起删了。只读：不写盘、不建快照。
 */
import { readFile } from "node:fs/promises";

import {
  defaultDraftPath,
  hasRealDraftContent,
} from "../lib/project-io.js";

/**
 * 健壮解析「这章要质检的真草稿」——治真机 QA bug：新书写完立刻质检误报「正文为空/过短」。
 * 根因：草稿落盘有时序竞争窗口，裸 readFile 会读到空（FS 抖动）或显示用占位符（约50字→误报过短），
 * 把用户在编辑器/写作区明明看得见的真稿当没写。按可靠度取真稿：
 *   ① 显式正文（仅当是真稿；空串/占位符不算，治 generate_draft 偶发回空被透传当空稿）
 *   ② 工作稿文件 drafts/fast/*.md（带 FS 抖动重试：刚写盘偶发读空/读到占位符，重试即得真稿）
 *   ③ 不可信显式正文（agent 路）末位兜底
 *   ④ 都没有真稿 → hasRealDraft=false，上层诚实回报「还没正文可质检」（不喂占位符给引擎误报）。
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
   *   只在盘上无真稿（FS 抖动）时才作末位兜底。质检/审稿评的必须是「真要入库的盘上正文」。
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

  // explicitDraftContent 末位兜底（不可信源/agent 路）：仅盘上无真稿时才用，绝不盖过盘上真稿。
  // 不再回落旧版写作台缓存（chapter-workspaces/*.json）：重构 P5 起稿子只有草稿文件一份，那份缓存不再更新，读它就是读过期稿。
  if (input.explicitDraftContent !== undefined && hasRealDraftContent(input.explicitDraftContent)) {
    return { content: input.explicitDraftContent, hasRealDraft: true };
  }

  return { content: fileContent, hasRealDraft: false };
}

