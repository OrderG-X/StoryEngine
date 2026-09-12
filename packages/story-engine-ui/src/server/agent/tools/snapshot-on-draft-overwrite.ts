/**
 * 覆盖现有非空草稿前建一次轻量快照（M6）。
 *
 * generate_draft / revise_draft 用 createTool（非 writeTool）刻意不建 git 快照——草稿是「待保存」的工作稿。
 * 但「再写一版」或局部修订会**覆盖**已有草稿，没快照则旧稿既无「撤销到此」也无快照历史、不可恢复
 * （存档面板还写「每次 AI 写入前自动存档」打脸）。
 *
 * 本 helper：当前章已有非空草稿才建快照（首次出稿无旧稿可丢，不建、不留无意义提交）；返回 snapshotId，
 * 由工具并入 output（ok 时）→ agentChatClient 透传 → recordTurnEffects 据此挂「撤销到此」。
 *
 * 读稿 fail-closed（P2-5）：ENOENT=真无旧稿（不建快照）；其余读错误按 FS 抖动重试（L1 口径 3×60ms），
 * 仍失败则抛错——绝不能把「旧稿存在但读不到」当「无旧稿」跳过快照：紧接的覆盖写会让旧稿从此
 * 无撤销点、不可恢复。抛错由调用方如实上报（工具 → 工具错误；路由 → 500 JSON），旧稿分毫不动。
 */
import { readFile } from "node:fs/promises";

import { createSnapshot } from "../../lib/snapshot.js";
import { defaultDraftPath, stripLeadingMarkdownChapterHeading } from "../../lib/project-io.js";
import { scrubLocalAbsolutePaths } from "../../lib/local-path-scrubber.js";

/** 读现有草稿判定「是否有旧稿可丢」：ENOENT 是确定答案（无旧稿）不重试；其余错误重试后仍失败抛原始错误。 */
async function readExistingDraftWithRetry(draftPath: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await readFile(draftPath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 60));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function snapshotBeforeDraftOverwrite(
  projectDir: string,
  chapter: number,
  label: string,
): Promise<string | undefined> {
  const draftPath = defaultDraftPath(projectDir, chapter);
  let existing: string;
  try {
    existing = await readExistingDraftWithRetry(draftPath);
  } catch (error) {
    // errno 原文内嵌绝对路径（如 open '/abs/.../0001.md'）——抛给工具错误/路由 500 直达用户，先消毒（铁律④）。
    throw new Error(
      `第${chapter}章工作稿读取失败（${scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error))}），` +
      "为避免无快照覆盖旧稿，本次操作已中止；请检查该文件后重试。",
    );
  }
  if (stripLeadingMarkdownChapterHeading(existing).trim().length === 0) return undefined;
  const snapshot = await createSnapshot(projectDir, label);
  return snapshot.id;
}
