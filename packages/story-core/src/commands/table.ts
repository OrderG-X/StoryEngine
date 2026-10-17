/**
 * 命令表：核心认的全部写命令。按钮按名字调；对话 AI 的工具 = 这张表里它有权调的（ai-direct）+ 只读查询。
 *
 * P2 骨架只有两条（定稿、记裁定），其余按 docs/rebuild/P2-core-design.md 第四节逐条加：
 * 起草 / 改稿（ai-direct）、改账（author）、改设定卡（author）、补资料（ai-direct）、裁剪历史（author）。
 */
import { chapterCommit } from "./chapter-commit.js";
import { decisionRecord } from "./decision-record.js";
import type { AnyWriteCommandSpec, Caller } from "./types.js";

export const WRITE_COMMANDS: Readonly<Record<string, AnyWriteCommandSpec>> = {
  [chapterCommit.name]: chapterCommit,
  [decisionRecord.name]: decisionRecord,
};

/** 这个调用方能调哪些写命令（AI 只能调 ai-direct 的）。 */
export function writeCommandsFor(caller: Caller): readonly AnyWriteCommandSpec[] {
  return Object.values(WRITE_COMMANDS).filter((spec) => caller === "author" || spec.tier === "ai-direct");
}
