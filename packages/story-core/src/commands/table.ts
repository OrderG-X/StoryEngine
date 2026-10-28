/**
 * 命令表：核心认的全部写命令。按钮按名字调；对话 AI 的工具 = 这张表里它有权调的（ai-direct）+ 只读查询。
 *
 * 现在有十二条（定稿、改已定稿的章名、记裁定、导入老书、导入已写的书、通读记账、作者存稿、AI 写稿、改设定卡、AI 补设定、搬老设定、定论并改齐），
 * 其余按 docs/rebuild/P2-core-design.md 第四节逐条加：改账（author）、裁剪历史（author）。
 */
import { chapterCommit } from "./chapter-commit.js";
import { chapterRetitle } from "./chapter-retitle.js";
import { decisionRecord } from "./decision-record.js";
import { bookImport } from "../import/command.js";
import { bookImportText } from "../import/text-import.js";
import { ledgerReread } from "./ledger-reread.js";
import { draftAdoptCandidate, draftApplyGenerated, draftSave } from "../draft/commands.js";
import { cardFill, cardsImport, cardWrite } from "../bible/commands.js";
import { settleApply } from "./settle-apply.js";
import type { AnyWriteCommandSpec, Caller } from "./types.js";

export const WRITE_COMMANDS: Readonly<Record<string, AnyWriteCommandSpec>> = {
  [chapterCommit.name]: chapterCommit,
  [chapterRetitle.name]: chapterRetitle,
  [decisionRecord.name]: decisionRecord,
  [bookImport.name]: bookImport,
  [bookImportText.name]: bookImportText,
  [ledgerReread.name]: ledgerReread,
  [draftSave.name]: draftSave,
  [draftApplyGenerated.name]: draftApplyGenerated,
  [draftAdoptCandidate.name]: draftAdoptCandidate,
  [cardWrite.name]: cardWrite,
  [cardFill.name]: cardFill,
  [cardsImport.name]: cardsImport,
  [settleApply.name]: settleApply,
};

/** 这个调用方能调哪些写命令（AI 只能调 ai-direct 的）。 */
export function writeCommandsFor(caller: Caller): readonly AnyWriteCommandSpec[] {
  return Object.values(WRITE_COMMANDS).filter((spec) => caller === "author" || spec.tier === "ai-direct");
}
