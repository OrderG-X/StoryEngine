/**
 * 核账服务（2026-10-10 引擎升级第 3 期：所有入口共用这一套；2026-10-12 编辑部 R3 起只剩核账员一路）。
 *
 * 核账按钮、对话里说「核一下」、AI 出稿后的自检都走 checkChapterBody：同一套确定性对账（账本数字）+
 * 核账员三遍（跟读窗口，带 A 自复核 + F 时间线只进自复核）、同一份核账记忆和「不是问题」批注。
 * 正文由调用方给（出稿后自检核的是还没落盘的稿子）。只读：不改正文、不写账本；只写核账记忆（作者的查错记录）。
 */
import { readFactLedgerStrict, type FactEntry } from "@actalk/story-engine";
import {
  callConfiguredBrainModel,
  catchUpReaders,
  checkChapterByReader,
  DEFAULT_READER_VARIANT,
  type BrainCallModel,
} from "../../brain/index.js";
import {
  issueStillPresent,
  ledgerNumberIssues,
  mergeContinuityIssues,
  readEarlierChapters,
  type ContinuityIssueV2,
  type EarlierText,
} from "./check-chapter.js";
import { CHECK_MEMORY_VERSION, hashBody, hashEarlier, readCheckMemory, writeCheckMemory } from "./check-memory.js";
import { isDismissed, readDismissals } from "./dismissals.js";
import { withStep } from "../../lib/token-meter.js";

export interface ChapterCheckItem {
  readonly quote: string;
  readonly earlierQuote: string;
  readonly earlierChapter: number;
  readonly reason: string;
}

export interface ChapterCheckResult {
  /** 核账是否跑成。 */
  readonly ok: boolean;
  readonly chapter: number;
  readonly sure: readonly ChapterCheckItem[];
  readonly maybe: readonly ChapterCheckItem[];
  readonly failures: readonly string[];
  /** 作者标过「不是问题」、这次没再报的条数。 */
  readonly dismissed: number;
  /** 正文、前文、账本都没改过，直接用的上次结果（没调模型）。 */
  readonly reused: boolean;
  /** 给作者看的一句话结论。 */
  readonly summary: string;
}

const toItem = (issue: ContinuityIssueV2): ChapterCheckItem => ({
  quote: issue.quote,
  earlierQuote: issue.earlierQuote,
  earlierChapter: issue.earlierChapter,
  reason: issue.reason,
});

/** 核账员那一路最多当场补多少章笔记；超过就如实说「还在读前文」，笔记在后台补（T5），这次不硬核。 */
const READER_MAX_CATCH_UP = 10;

export interface ChapterCheckOptions {
  /** 正文没改也重新核。 */
  readonly fresh?: boolean;
  /** 核账员的模型调用（测试注入）；缺省走配置的 qualityCheck 模型。 */
  readonly readerCallModel?: BrainCallModel;
}

/**
 * 核账：账本数字对账（确定性层）+ 核账员三遍，合并去重（账本的排前面）。
 * 上次的问题两边原句还在的照带，把握沿用上次；不再单独复核（核账员自己给把握，A 自复核在它那轮里）。
 */
async function checkByReader(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly body: string;
  readonly earlier: EarlierText;
  readonly carryOver: readonly ContinuityIssueV2[];
  readonly ledgerFacts?: readonly FactEntry[];
  readonly callModel: BrainCallModel;
}): Promise<{ readonly issues: readonly ContinuityIssueV2[]; readonly failures: readonly string[] } | { readonly notReady: { readonly done: number; readonly total: number } }> {
  const reader = await checkChapterByReader({
    projectDir: input.projectDir,
    chapter: input.chapter,
    draftBody: input.body,
    callModel: input.callModel,
    maxCatchUp: READER_MAX_CATCH_UP,
    earlier: input.earlier,
    variant: DEFAULT_READER_VARIANT,
  });
  if (reader.skipped === "not_ready") return { notReady: reader.pending ?? { done: 0, total: input.chapter - 1 } };
  const ledger = await withStep("账本对账", () => ledgerNumberIssues({
    projectDir: input.projectDir,
    chapter: input.chapter,
    draftBody: input.body,
    ...(input.ledgerFacts ? { ledgerFacts: input.ledgerFacts } : {}),
  }));
  const issues = mergeContinuityIssues([...ledger.issues, ...input.carryOver, ...reader.issues])
    .map((issue) => ({ ...issue, confidence: issue.confidence ?? "maybe" as const }))
    .sort((a, b) => (a.confidence === b.confidence ? 0 : a.confidence === "sure" ? -1 : 1));
  return { issues, failures: [...ledger.failures, ...reader.failures] };
}

export async function checkChapterBody(
  projectDir: string,
  chapter: number,
  body: string,
  options: ChapterCheckOptions = {},
): Promise<ChapterCheckResult> {
  const earlier = await readEarlierChapters(projectDir, chapter);
  // 账本只读一次：数字对账用它，核账记忆的键也带上它。读不了就不传，核账那边会如实记「账本读不了」。
  const ledgerFacts = await readFactLedgerStrict(projectDir).then((ledger) => ledger.facts).catch(() => undefined);
  const readerCallModel = options.readerCallModel ?? callConfiguredBrainModel;
  const bodyHash = hashBody(body);
  const earlierHash = hashEarlier(earlier, ledgerFacts ?? []);
  // 核账记忆：正文和前文都没改 → 直接给上次的结果（同样的输入同样的输出）；改过 → 上次没改掉的问题带上一起复核。
  const memory = await readCheckMemory(projectDir, chapter);
  const reused = !options.fresh
    && Boolean(memory && memory.version === CHECK_MEMORY_VERSION && memory.bodyHash === bodyHash && memory.earlierHash === earlierHash);
  // 旧版本查错留下的记忆不带（版本号加一 = 那时的结果不可信）。
  const carryOver = memory && !reused && memory.version === CHECK_MEMORY_VERSION
    ? memory.issues.filter((issue) => issueStillPresent(issue, chapter, body, earlier))
    : [];
  let result: { readonly issues: readonly ContinuityIssueV2[]; readonly failures: readonly string[] };
  if (reused) {
    result = { issues: memory!.issues, failures: [] };
  } else {
    const viaReader = await withStep("核账", () => checkByReader({ projectDir, chapter, body, earlier, carryOver, ...(ledgerFacts ? { ledgerFacts } : {}), callModel: readerCallModel }));
    if ("notReady" in viaReader) {
      // 核账员还没读完前文（T5 后台补读）：如实说读到第几章、这次没核，不装作核过。
      // 笔记在后台按顺序补（走三个角色共用的补读队列、点名 checker；补不成只记一笔，下次接着补），
      // 读完后作者再点一次「核账」就是读完全书的核账员。
      const { done, total } = viaReader.notReady;
      void catchUpReaders(projectDir, chapter - 1, { callModel: readerCallModel, roles: ["checker"] });
      return {
        ok: false,
        chapter,
        sure: [],
        maybe: [],
        failures: [`核账员还在读前文（第 ${done} / ${total} 章），这次没核`],
        dismissed: 0,
        reused: false,
        summary: `核账员还在读这本书的前文：第 ${done} / ${total} 章。这次没有核（不糊弄）；它读完后你再点一次「核账」，就是按读完全书来核的。`,
      };
    }
    result = viaReader;
  }
  if (!reused && (result.failures.length === 0 || result.issues.length > 0)) {
    await writeCheckMemory(projectDir, { chapter, bodyHash, earlierHash, issues: result.issues }).catch((error) => {
      console.warn("[check_continuity] 核账记忆没存上（不影响这次结果）", error);
    });
  }
  // 作者点过「不是问题」的不再报（只认同一章、两边原句都对得上的）。
  const dismissals = await readDismissals(projectDir);
  const shown = result.issues.filter((issue) => !isDismissed(chapter, issue, dismissals));
  const dismissed = result.issues.length - shown.length;
  const sure = shown.filter((issue) => issue.confidence === "sure").map(toItem);
  const maybe = shown.filter((issue) => issue.confidence !== "sure").map(toItem);
  const ok = result.failures.length === 0 || result.issues.length > 0;
  const where = (issue: { readonly earlierChapter: number }) => (issue.earlierChapter === chapter ? "本章前文" : `第 ${issue.earlierChapter} 章`);
  const dismissedNote = dismissed > 0 ? `（另有 ${dismissed} 处你标过「不是问题」，没再报。）` : "";
  const reusedNote = reused ? "这一章和前文都没改过，结果同上次。" : "";
  const baseSummary = !ok
    ? `第 ${chapter} 章核账没跑成：${result.failures[0] ?? "原因不明"}。可以再点一次「核账」。`
    : sure.length + maybe.length === 0
      ? `${reusedNote}核了第 ${chapter} 章，没发现和前文对不上的地方。${dismissedNote}${result.failures.length > 0 ? `（有一步没跑成：${result.failures[0]}）` : ""}`
      : [
        `${reusedNote}核了第 ${chapter} 章：确定对不上 ${sure.length} 处${maybe.length > 0 ? `，可能有问题 ${maybe.length} 处` : ""}。${dismissedNote}`,
        ...sure.slice(0, 3).map((issue) => `· 「${issue.quote.slice(0, 40)}」和${where(issue)}「${issue.earlierQuote.slice(0, 40)}」：${issue.reason}`),
      ].join("\n");
  return { ok, chapter, sure, maybe, failures: [...result.failures], dismissed, reused, summary: baseSummary };
}
