/**
 * 这一章的工作稿有没有正文（去掉章标题后非空）：出稿定存档点叫「出稿」还是「再次出稿前」、有稿的章要不要先问作者，都看它。
 *
 * 读稿 fail-closed（P2-5）：ENOENT = 真没稿；其余读错误按 FS 抖动重试（3×60ms），仍失败就抛错——
 * 绝不能把「旧稿在但读不到」当「没稿」：有稿的章就会被当成空章直接整章重写。
 */
import { readFile } from "node:fs/promises";
import { defaultDraftPath, stripLeadingMarkdownChapterHeading } from "./project-io.js";

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

export async function hasWorkingDraftText(projectDir: string, chapter: number): Promise<boolean> {
  const existing = await readExistingDraftWithRetry(defaultDraftPath(projectDir, chapter));
  return stripLeadingMarkdownChapterHeading(existing).trim().length > 0;
}
