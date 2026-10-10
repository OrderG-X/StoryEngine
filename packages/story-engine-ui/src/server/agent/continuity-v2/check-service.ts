/**
 * 核账服务（2026-10-10 引擎升级第 3 期：所有入口共用这一套）。
 *
 * 核账按钮、对话里说「核一下」、AI 出稿后的自检都走 checkChapterBody：同一套确定性对账（账本数字）+ 模型查错
 * （通读 + 拆说法全书检索 + 复核）、同一份核账记忆和「不是问题」批注。正文由调用方给（出稿后自检核的是还没落盘的稿子）。
 * 只读：不改正文、不写账本；只写核账记忆（作者的查错记录）。
 */
import { describeTimelineForChapter, readFactLedgerStrict, readStoryTimeline } from "@actalk/story-engine";
import {
  callConfiguredCheckerModel,
  checkChapterContinuity,
  issueStillPresent,
  readEarlierChapters,
  type CheckCallModel,
  type ContinuityIssueV2,
} from "./check-chapter.js";
import { CHECK_MEMORY_VERSION, hashBody, hashEarlier, readCheckMemory, writeCheckMemory } from "./check-memory.js";
import { isDismissed, readDismissals } from "./dismissals.js";

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

export async function checkChapterBody(
  projectDir: string,
  chapter: number,
  body: string,
  callModel: CheckCallModel = callConfiguredCheckerModel,
  options: { readonly fresh?: boolean } = {},
): Promise<ChapterCheckResult> {
  const earlier = await readEarlierChapters(projectDir, chapter);
  // 故事时间线对照表（引擎排好的日子），附给通读和复核：判「前天 / 周几」照表，不让模型自己算。
  const timeline = await readStoryTimeline(projectDir).then((read) => read.timeline).catch(() => undefined);
  const timelineTable = timeline ? describeTimelineForChapter(timeline, chapter) : undefined;
  // 账本只读一次：数字对账用它，核账记忆的键也带上它。读不了就不传，核账那边会如实记「账本读不了」。
  const ledgerFacts = await readFactLedgerStrict(projectDir).then((ledger) => ledger.facts).catch(() => undefined);
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
  const result = reused
    ? { issues: memory!.issues, failures: [] as readonly string[] }
    : await checkChapterContinuity({ projectDir, chapter, draftBody: body, callModel, earlier, carryOver, ...(ledgerFacts ? { ledgerFacts } : {}), ...(timelineTable ? { timelineTable } : {}) });
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
  const summary = !ok
    ? `第 ${chapter} 章核账没跑成：${result.failures[0] ?? "原因不明"}。可以再点一次「核账」。`
    : sure.length + maybe.length === 0
      ? `${reusedNote}核了第 ${chapter} 章，没发现和前文对不上的地方。${dismissedNote}${result.failures.length > 0 ? `（有一步没跑成：${result.failures[0]}）` : ""}`
      : [
        `${reusedNote}核了第 ${chapter} 章：确定对不上 ${sure.length} 处${maybe.length > 0 ? `，可能有问题 ${maybe.length} 处` : ""}。${dismissedNote}`,
        ...sure.slice(0, 3).map((issue) => `· 「${issue.quote.slice(0, 40)}」和${where(issue)}「${issue.earlierQuote.slice(0, 40)}」：${issue.reason}`),
      ].join("\n");
  return { ok, chapter, sure, maybe, failures: [...result.failures], dismissed, reused, summary };
}
