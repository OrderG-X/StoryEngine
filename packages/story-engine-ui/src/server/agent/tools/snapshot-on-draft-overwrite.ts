/**
 * 出稿/改稿写盘前的可撤销存档点（M6 + R4.2）。
 *
 * generate_draft / revise_draft 用 createTool（非 writeTool）刻意不走 runWithSnapshot——草稿是「待保存」的工作稿。
 * M6 起的规则：**覆盖**已有非空草稿前建快照（旧稿无撤销点就再也找不回）。
 * R4.2（验收 3.2）补上另一半：**首次出稿也建**——作者眼里「AI 出了第 N 章首稿」就是一步，撤销必须能撤它；
 * 此前首稿无存档点，撤销会跳到更早一步、把首稿之后新增的草稿一并删掉。存档点记的是写稿之前的状态，
 * 撤销用得上，不算无意义提交。带 firstDraftLabel 的调用（两条出稿适配层）无旧稿时用它建点；
 * 不带（revise_draft / 质量环节：都要有稿才动得了）维持 M6 语义：无旧稿不建。
 * 返回 snapshotId，由工具并入 output（ok 时）→ agentChatClient 透传 → recordTurnEffects 据此挂「撤销到此回合」。
 *
 * 读稿 fail-closed（P2-5）：ENOENT=真无旧稿（按上述规则决定建不建）；其余读错误按 FS 抖动重试（L1 口径 3×60ms），
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

/** 这一章的工作稿有没有正文（去掉章标题后非空）。读不到（非 ENOENT）照样抛错，不当「没稿」。 */
export async function hasWorkingDraftText(projectDir: string, chapter: number): Promise<boolean> {
  const existing = await readExistingDraftWithRetry(defaultDraftPath(projectDir, chapter));
  return stripLeadingMarkdownChapterHeading(existing).trim().length > 0;
}

export async function snapshotBeforeDraftOverwrite(
  projectDir: string,
  chapter: number,
  label: string,
  /** 无旧稿（首次出稿）时也建存档点用的标签（如「出稿：第5章」）；缺省=首次不建（M6 语义，revise/质量环节用）。 */
  firstDraftLabel?: string,
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
  if (stripLeadingMarkdownChapterHeading(existing).trim().length === 0) {
    // 首次出稿：有 firstDraftLabel 就建「出稿：第N章」存档点（R4.2：首稿也是可撤销的一步）。
    if (!firstDraftLabel) return undefined;
    const snapshot = await createSnapshot(projectDir, firstDraftLabel);
    return snapshot.id;
  }
  const snapshot = await createSnapshot(projectDir, label);
  return snapshot.id;
}
