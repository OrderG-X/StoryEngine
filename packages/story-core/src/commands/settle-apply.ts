/**
 * 「定论并改齐」命令（作者档，P12）：作者在定论预览卡上点「确认」后一次写完——
 * 设定本（加定论、改栏目）、已定稿章按编号换句、这些章的账单跟着改、工作稿按编号换句。写前一个存档点，整体能撤销。
 *
 * 预览之后哪一章、哪份工作稿变了（哈希 / 版本对不上），整条不写，如实说是哪一章。
 * 定稿后正文在别处改过（账单记的哈希和盘上的对不上）的章也不改：先重新定稿，免得把「定稿后改过」的痕迹抹掉。
 *
 * 账单（只动原句落在改掉的句子里的条目，别的一条不碰）：
 *  - 事实：按 facts 里给的改法改（值 / 说明 / 原句，编号不变）；没给改法的作废——记一条「事实记错了」裁定，
 *    原条目留着，后文推翻它的还接得上；
 *  - 梗概、线索、时间：原句换成改后的那句；
 *  - 出场：改后的那句里还有这个称呼就换成它，没有就换成本章别处有这个称呼的一句，再没有这条出场去掉。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { applyCardOps, CardOp, MAX_OPS_PER_CHANGE } from "../bible/ops.js";
import { readCardsOrLegacy } from "../bible/commands.js";
import { draftVersionOf, readDraftStamp } from "../draft/draft.js";
import type { AuthorDecision } from "../schema/decisions.js";
import { ChapterLedger, entryQuote, storedShapeProblem, timeRoleOf, type LedgerEntry } from "../schema/ledger.js";
import { chapterSource, evidenceFor, relocateEvidence, relocateScenes, type ChapterSource } from "../ledger/entries.js";
import { cardsFileText, decisionsFileText, readAllLedgers, readChapterText, readDecisions, sha256 } from "../store/book.js";
import { CARDS_PATH, chapterLedgerPath, chapterTextPath, DECISIONS_PATH, draftPath } from "../store/paths.js";
import type { TxWrite } from "../store/transaction.js";
import { normalizeForQuote, quoteInText } from "../text/quote.js";
import { applyUnitEdits, type AppliedUnitEdit } from "../text/units.js";
import { fail } from "./runner.js";
import type { WriteCommandSpec } from "./types.js";

const text = z.string().trim().min(1);
const chapterNo = z.number().int().min(1);

const UnitEditArg = z.object({ id: z.number().int().min(1), from: z.string().min(1), to: text });

/** 账里一条事实跟着改成什么（只给要改的栏；编号不变）。 */
const FactPatch = z.object({ id: text, value: text.optional(), text: text.optional(), quote: text.optional() });

export const SettleApplyArgs = z.object({
  /** 存档点、操作历史里的标签（「定论：杜长顺十年前去世」）。 */
  label: z.string().trim().min(1).max(200),
  /** 设定本跟着改的（加定论、改栏目），作者档。 */
  cardOps: z.array(CardOp).max(MAX_OPS_PER_CHANGE),
  chapters: z.array(z.object({
    chapter: chapterNo,
    /** 预览时这章定稿正文的 sha256。 */
    textSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    edits: z.array(UnitEditArg).min(1),
    facts: z.array(FactPatch),
    /** 没记原句（老账）、改了以后不成立的事实：作废（原句没法替它说话）。 */
    retract: z.array(text).default([]),
  })),
  drafts: z.array(z.object({ chapter: chapterNo, baseVersion: text, edits: z.array(UnitEditArg).min(1) })),
}).refine((args) => args.cardOps.length + args.chapters.length + args.drafts.length > 0, "什么都没要改");
export type SettleApplyArgs = z.infer<typeof SettleApplyArgs>;

export interface SettledChapter {
  readonly chapter: number;
  readonly edits: number;
  /** 跟着改了的事实（给人看的说明）。 */
  readonly factsUpdated: readonly string[];
  /** 原句改了、没给改法、作废了的事实（给人看的说明）。 */
  readonly factsRetracted: readonly string[];
  /** 原句换成改后那句的条目数（梗概、线索、出场、时间）。 */
  readonly requoted: number;
  /** 改后整章再找不到这个称呼、去掉了的出场（称呼）。 */
  readonly presenceDropped: readonly string[];
}

export interface SettleApplyResult {
  /** 设定本改了什么（只有名字）。 */
  readonly cardLines: readonly string[];
  readonly chapters: readonly SettledChapter[];
  readonly drafts: readonly { readonly chapter: number; readonly edits: number; readonly version: string }[];
}

/** 只套这一处改法后，这条原句还在不在：不在 = 这一处碰了它。 */
function brokenBy(original: string, edit: AppliedUnitEdit, quote: string): boolean {
  return !quoteInText(quote, original.slice(0, edit.start) + edit.to + original.slice(edit.end));
}

const containsName = (sentence: string, name: string): boolean => normalizeForQuote(sentence).includes(normalizeForQuote(name));

type ChapterOutcome =
  | { readonly ok: true; readonly ledger: ChapterLedger; readonly text: string; readonly retract: readonly string[]; readonly summary: SettledChapter }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** 换成改后正文里的这一句：核得上就按新一版算证据；太短核不了的（「嗯。」）照原样记这句（它确实在新正文里），不给句号。 */
function requote(entry: LedgerEntry, sentence: string, source: ChapterSource): LedgerEntry {
  const proof = evidenceFor(sentence, source) ?? {
    evidence: [{ resource: { kind: "chapter" as const, chapter: source.chapter }, revision: source.revision, quote: sentence }],
    evidenceStatus: "quoted" as const,
  };
  return { ...entry, ...proof };
}

function settleLedger(
  ledger: ChapterLedger,
  original: string,
  next: string,
  applied: readonly AppliedUnitEdit[],
  patches: readonly z.infer<typeof FactPatch>[],
  retractIds: readonly string[],
): ChapterOutcome {
  const chapter = ledger.chapter;
  const patchById = new Map(patches.map((patch) => [patch.id, patch]));
  const retractSet = new Set(retractIds);
  const source = chapterSource(chapter, next);
  const entries: LedgerEntry[] = [];
  const factsUpdated: string[] = [];
  const factsRetracted: string[] = [];
  const presenceDropped: string[] = [];
  const retract: string[] = [];
  let requoted = 0;
  for (const entry of ledger.entries) {
    const patch = entry.kind === "fact" ? patchById.get(entry.id) : undefined;
    if (patch && entry.kind === "fact") {
      const quote = patch.quote ?? entryQuote(entry);
      const proof = quote === undefined ? undefined : evidenceFor(quote, source);
      const updated = {
        ...entry,
        ...(patch.value ? { value: patch.value } : {}),
        ...(patch.text ? { text: patch.text } : {}),
        ...proof,
      };
      if (!proof || proof.evidenceStatus === "none" || storedShapeProblem(updated, ledger.timeModel)) {
        return { ok: false, code: "fact_patch_invalid", message: `第 ${chapter} 章账里「${entry.text}」的改法核不上改后的正文` };
      }
      entries.push(updated);
      factsUpdated.push(updated.text);
      continue;
    }
    if (entry.kind === "fact" && retractSet.has(entry.id)) {
      entries.push(entry);
      retract.push(entry.id);
      factsRetracted.push(entry.text);
      continue;
    }
    const quote = entryQuote(entry);
    if (!quote || quoteInText(quote, next) || !quoteInText(quote, original)) {
      entries.push(relocateEvidence(entry, source));
      continue;
    }
    const edit = applied.find((item) => brokenBy(original, item, quote)) ?? applied[0];
    if (entry.kind === "fact") {
      entries.push(entry);
      retract.push(entry.id);
      factsRetracted.push(entry.text);
      continue;
    }
    if (entry.kind === "presence") {
      const sentence = edit && containsName(edit.to, entry.nameUsed)
        ? edit.to
        : source.units.find((unit) => containsName(unit.text, entry.nameUsed))?.text;
      if (!sentence) {
        presenceDropped.push(entry.nameUsed);
        continue;
      }
      entries.push(requote(entry, sentence, source));
      requoted += 1;
      continue;
    }
    if (!edit) {
      entries.push(entry);
      continue;
    }
    entries.push(requote(entry, edit.to, source));
    // 一条时间声明存成好几条（开头、同一天、换天、段），按本章开头那条算一条。
    if (!(entry.kind === "time" && timeRoleOf(entry) !== "start")) requoted += 1;
  }
  const unknown = [...patches.map((patch) => patch.id), ...retractIds].find((id) => !ledger.entries.some((entry) => entry.kind === "fact" && entry.id === id));
  if (unknown) return { ok: false, code: "unknown_fact", message: `第 ${chapter} 章账里没有要改的那条事实了` };
  // 段跟着改后的正文重新对回句号，对不回的标 stale（按「段未知」处理，设计第 6 节）。
  const replaced = (quote: string): string => (quoteInText(quote, next) || !quoteInText(quote, original) ? quote : (applied.find((item) => brokenBy(original, item, quote))?.to ?? quote));
  const parsed = ChapterLedger.safeParse({ ...ledger, textSha256: sha256(next), entries, scenes: relocateScenes(ledger.scenes, source, replaced) });
  if (!parsed.success) return { ok: false, code: "ledger_invalid", message: `第 ${chapter} 章的账单没拼成` };
  return {
    ok: true,
    ledger: parsed.data,
    text: next,
    retract,
    summary: { chapter, edits: applied.length, factsUpdated, factsRetracted, requoted, presenceDropped },
  };
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export const settleApply: WriteCommandSpec<SettleApplyArgs, SettleApplyResult> = {
  name: "settle.apply",
  tier: "author",
  summary: "记下定论并把前文改齐：设定本、已定稿章正文和账单、工作稿一次写完。",
  args: SettleApplyArgs,
  snapshot: true,
  idempotent: true,
  async plan(context, args) {
    const at = context.now.toISOString();
    const writes: TxWrite[] = [];
    let cardLines: readonly string[] = [];
    if (args.cardOps.length > 0) {
      const base = await readCardsOrLegacy(context.bookDir, at);
      const outcome = applyCardOps(base, args.cardOps, { by: "author", at });
      if (!outcome.ok) return fail(outcome.code, `没改：设定本那一步不成（${outcome.message}）。`);
      cardLines = outcome.lines;
      if (outcome.lines.length > 0) writes.push({ path: CARDS_PATH, content: cardsFileText(outcome.file) });
    }

    const [ledgers, decisions] = await Promise.all([readAllLedgers(context.bookDir), readDecisions(context.bookDir)]);
    const seen = new Set<number>();
    const chapters: SettledChapter[] = [];
    const retracts: string[] = [];
    for (const item of args.chapters) {
      if (seen.has(item.chapter)) return fail("invalid_args", `第 ${item.chapter} 章给了两份改法。`);
      seen.add(item.chapter);
      const ledger = ledgers.find((entry) => entry.chapter === item.chapter);
      const original = await readChapterText(context.bookDir, item.chapter);
      if (!ledger || original === undefined) return fail("not_committed", `第 ${item.chapter} 章还没定稿，没改。`);
      const hash = sha256(original);
      if (hash !== item.textSha256) return fail("chapter_moved", `第 ${item.chapter} 章在预览之后改过，这次一处都没改，重新查一遍。`);
      if (hash !== ledger.textSha256) return fail("edited_since_commit", `第 ${item.chapter} 章定稿后正文在别处改过，先把它重新定稿再改齐。`);
      const applied = applyUnitEdits(original, item.edits);
      if (!applied.ok) return fail(applied.code, `第 ${item.chapter} 章没改成：${applied.message}。`);
      if (applied.applied.length === 0) continue;
      const outcome = settleLedger(ledger, original, applied.text, applied.applied, item.facts, item.retract);
      if (!outcome.ok) return fail(outcome.code, `没改：${outcome.message}。`);
      writes.push(
        { path: chapterTextPath(item.chapter), content: outcome.text },
        { path: chapterLedgerPath(item.chapter), content: `${JSON.stringify(outcome.ledger, null, 2)}\n` },
      );
      retracts.push(...outcome.retract);
      chapters.push(outcome.summary);
    }

    if (retracts.length > 0) {
      let max = 0;
      for (const decision of decisions) {
        const seq = Number(decision.id.slice(2));
        if (decision.id.startsWith("d-") && Number.isInteger(seq) && seq > max) max = seq;
      }
      const added: AuthorDecision[] = retracts.map((fact) => ({ type: "fact.retract", fact, note: "定论改齐：原句改了", id: `d-${(max += 1)}`, at }));
      writes.push({ path: DECISIONS_PATH, content: decisionsFileText([...decisions, ...added]) });
    }

    const drafts: { chapter: number; edits: number; version: string }[] = [];
    const draftSeen = new Set<number>();
    for (const item of args.drafts) {
      if (draftSeen.has(item.chapter)) return fail("invalid_args", `第 ${item.chapter} 章的工作稿给了两份改法。`);
      draftSeen.add(item.chapter);
      const stamp = await readDraftStamp(context.bookDir, item.chapter);
      const raw = await readOptional(join(context.bookDir, draftPath(item.chapter)));
      if (raw === undefined) return fail("draft_missing", `第 ${item.chapter} 章的工作稿不在了，没改。`);
      if (draftVersionOf(raw, stamp) !== item.baseVersion) return fail("draft_moved", `第 ${item.chapter} 章的工作稿在预览之后改过，这次一处都没改，重新查一遍。`);
      const applied = applyUnitEdits(raw, item.edits);
      if (!applied.ok) return fail(applied.code, `第 ${item.chapter} 章工作稿没改成：${applied.message}。`);
      if (applied.applied.length === 0) continue;
      writes.push({ path: draftPath(item.chapter), content: applied.text });
      drafts.push({ chapter: item.chapter, edits: applied.applied.length, version: draftVersionOf(applied.text, { epoch: stamp.epoch, gen: context.draftGen }) });
    }

    const changedChapters = chapters.map((item) => item.chapter);
    return {
      label: args.label,
      writes,
      changed: {
        ...(changedChapters.length > 0 ? { chapters: changedChapters, ledgers: changedChapters } : {}),
        ...(retracts.length > 0 ? { decisions: true } : {}),
        ...(cardLines.length > 0 ? { cards: true } : {}),
        ...(drafts.length > 0 ? { drafts: drafts.map((item) => item.chapter) } : {}),
      },
      result: { cardLines, chapters, drafts },
    };
  },
};
