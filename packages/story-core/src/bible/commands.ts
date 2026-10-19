/**
 * 设定卡的三条写命令（重构 P9）：
 *
 * - `card.write`（作者档）：作者在设定本里改、或点「确认改设定」。什么都能改，写下的算作者的。
 * - `card.fill`（AI 档，可撤销）：对话 AI 补资料。碰了作者写的整批不做（needs_author），工具先用 splitForAi 拆好。
 * - `cards.import`（作者档，开书时系统调）：老格式设定文件 → `ledger/cards.json`。
 *
 * 书还没有 cards.json 时，前两条先从老格式文件拼出底子再改（不然第一次改就把没迁的老设定丢了）。
 */
import { z } from "zod";
import { emptySettingCards, type SettingCardsFile } from "../schema/cards.js";
import { cardsFileText, readCards } from "../store/book.js";
import { CARDS_PATH } from "../store/paths.js";
import { readLegacyCards, type LegacyCardsResult } from "../import/legacy-cards.js";
import { fail } from "../commands/runner.js";
import type { PlanContext, WriteCommandSpec } from "../commands/types.js";
import { applyCardOps, CardOps, type CardOp } from "./ops.js";

/** 读设定卡：有 cards.json 用它；没有就从老格式文件现拼一份（不写盘），新书是空的。 */
export async function readCardsOrLegacy(bookDir: string, at = new Date().toISOString()): Promise<SettingCardsFile> {
  const cards = await readCards(bookDir);
  if (cards) return cards;
  return (await readLegacyCards(bookDir, at)).file;
}

export const CardWriteArgs = z.object({ ops: CardOps });
export type CardWriteArgs = z.infer<typeof CardWriteArgs>;

export interface CardWriteResult {
  /** 改了什么（给人看的，只有名字）。空 = 什么都没变。 */
  readonly lines: readonly string[];
}

function labelOf(lines: readonly string[]): string {
  if (lines.length === 0) return "改设定";
  return `改设定：${lines[0]}${lines.length > 1 ? ` 等 ${lines.length} 处` : ""}`;
}

async function planOps(context: PlanContext, ops: readonly CardOp[], by: "author" | "ai") {
  const base = await readCardsOrLegacy(context.bookDir, context.now.toISOString());
  const outcome = applyCardOps(base, ops, { by, at: context.now.toISOString() });
  if (!outcome.ok) {
    const step = ops.length > 1 ? `第 ${outcome.index + 1} 步：` : "";
    return fail(outcome.code, `没改设定：${step}${outcome.message}。`);
  }
  if (outcome.lines.length === 0) return { label: labelOf([]), writes: [], changed: {}, result: { lines: [] } };
  return {
    label: labelOf(outcome.lines),
    writes: [{ path: CARDS_PATH, content: cardsFileText(outcome.file) }],
    changed: { cards: true },
    result: { lines: outcome.lines },
  };
}

export const cardWrite: WriteCommandSpec<CardWriteArgs, CardWriteResult> = {
  name: "card.write",
  tier: "author",
  summary: "作者改设定卡。",
  args: CardWriteArgs,
  snapshot: true,
  idempotent: true,
  plan: (context, args) => planOps(context, args.ops, "author"),
};

export const cardFill: WriteCommandSpec<CardWriteArgs, CardWriteResult> = {
  name: "card.fill",
  tier: "ai-direct",
  summary: "AI 补设定卡：只能建新卡、填空的、改自己补的。",
  args: CardWriteArgs,
  snapshot: true,
  idempotent: false,
  plan: (context, args) => planOps(context, args.ops, "ai"),
};

export const CardsImportArgs = z.object({}).strict();

export interface CardsImportResult {
  readonly imported: boolean;
  readonly counts: LegacyCardsResult["counts"];
  readonly skipped: LegacyCardsResult["skipped"];
}

export const cardsImport: WriteCommandSpec<z.infer<typeof CardsImportArgs>, CardsImportResult> = {
  name: "cards.import",
  tier: "author",
  summary: "把老格式设定文件搬进设定卡（只读老文件）。",
  args: CardsImportArgs,
  snapshot: true,
  idempotent: true,
  async plan(context) {
    if (await readCards(context.bookDir)) return fail("already_imported", "设定卡已经有了，不用再搬。");
    const legacy = await readLegacyCards(context.bookDir, context.now.toISOString());
    const file = legacy.found ? legacy.file : emptySettingCards();
    return {
      label: legacy.found ? "搬老设定" : "建设定卡",
      writes: [{ path: CARDS_PATH, content: cardsFileText(file) }],
      changed: { cards: true },
      result: { imported: legacy.found, counts: legacy.counts, skipped: legacy.skipped },
    };
  },
};
