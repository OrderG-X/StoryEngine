/**
 * 核账服务（2026-10-10 引擎升级第 3 期：所有入口共用这一套；2026-10-12 编辑部 R3 起只剩核账员一路）。
 *
 * 核账按钮、对话里说「核一下」、AI 出稿后的自检都走 checkChapterBody：同一套确定性对账（账本数字）+
 * 核账员三遍（跟读窗口，带 A 自复核 + F 时间线只进自复核）、同一份核账记忆和「不是问题」批注。
 * 正文由调用方给（出稿后自检核的是还没落盘的稿子）。只读：不改正文、不写账本；只写核账记忆（作者的查错记录）。
 */
import { readFactLedgerStrict } from "../../book/fact-ledger-store.js";
import { readStoryTimeline } from "../../book/story-timeline.js";
import { type FactEntry } from "../../book/types.js";
import {
  callConfiguredBrainModel,
  catchUpReaders,
  checkChapterByReader,
  countCommittedChapters,
  DEFAULT_READER_VARIANT,
  describeReaderWait,
  type BrainCallModel,
  type ColdCoverage,
  type ReaderWaited,
} from "../index.js";
import {
  applyRelativeDayAlignment,
  issueStillPresent,
  ledgerNumberIssues,
  mergeContinuityIssues,
  settleMirroredIssues,
  settleRevisitedIssues,
  readEarlierChapters,
  snapIssueQuotes,
  type ContinuityIssueV2,
  type EarlierText,
} from "./check-chapter.js";
import { CHECK_MEMORY_VERSION, hashBody, hashEarlier, readCheckMemory, readFixLog, writeCheckMemory } from "./check-memory.js";
import { isDismissed, readDismissals, sameIssue } from "./dismissals.js";
import { readFoundationDigest, settingQuoteSource } from "../foundation-digest.js";
import { withStep } from "../../lib/token-meter.js";

export interface ChapterCheckItem {
  readonly quote: string;
  readonly earlierQuote: string;
  readonly earlierChapter: number;
  readonly reason: string;
  /** R7.3 对的是设定本（人物卡 / 地点 / 资产 / 世界规则）：earlierQuote＝设定原文，不是某一章的正文。 */
  readonly againstSetting?: { readonly label: string };
  /** R7.3 错在哪一章、按钮就改哪一章（前文章和设定不一致时指向前文那章）；缺省＝当前核的章。 */
  readonly fixChapter?: number;
  /** 这句是上一遍按核账改出来的（from＝改前那句），这遍又说不对：已降成「可能」。 */
  readonly revisited?: { readonly from: string };
}

export interface ChapterCheckResult {
  /** 核账是否跑成。 */
  readonly ok: boolean;
  readonly chapter: number;
  readonly sure: readonly ChapterCheckItem[];
  readonly maybe: readonly ChapterCheckItem[];
  /** 错在前面某章、之前核账已经报过、作者还没改的（P7 后：不再每章当新问题重报，只在结论里提一句、卡上收起）。 */
  readonly earlierOpen: readonly ChapterCheckItem[];
  readonly failures: readonly string[];
  /** 只在「还在读、这次没核」（notReady）时有：核账员已读到第 done 章、共 total 章。
   *  消费方要区分「还在读」和「出错」用这个字段，别解析 failures 的文字（R4.1）。
   *  R4.4 冷窗口起「还在读」也照核（ok:true），这个字段不再出现，保留给未来「真没核成」的情况。 */
  readonly pending?: { readonly done: number; readonly total: number };
  /** 冷窗口核账（R4.4：核账员还没读完全书也先核，不跳过）：notedThrough=已读笔记到第几章、
   *  rawFrom～rawTo=这次给了原文的章（0＝一章都没给）。summary 已如实说明对照范围。 */
  readonly coverage?: { readonly mode: "cold"; readonly notedThrough: number; readonly rawFrom: number; readonly rawTo: number };
  /** 这次核账前先当场补了笔记（R5.2）：补了第 from～to 章、花了 ms 毫秒。summary 已带「这次先等核账员读完…再核」。 */
  readonly waited?: ReaderWaited;
  /** 作者标过「不是问题」、这次没再报的条数。 */
  readonly dismissed: number;
  /** 正文、前文、账本都没改过，直接用的上次结果（没调模型）。 */
  readonly reused: boolean;
  /** 给作者看的一句话结论。 */
  readonly summary: string;
  /** summary 去掉逐条问题、只剩结论（重构 P6：问题清单在核账卡和稿纸划线上，「核账」按钮的回话只说这句）。 */
  readonly headline?: string;
}

const toItem = (issue: ContinuityIssueV2): ChapterCheckItem => ({
  quote: issue.quote,
  earlierQuote: issue.earlierQuote,
  earlierChapter: issue.earlierChapter,
  reason: issue.reason,
  ...(issue.againstSetting ? { againstSetting: { ...issue.againstSetting } } : {}),
  ...(issue.fixChapter !== undefined ? { fixChapter: issue.fixChapter } : {}),
  ...(issue.revisited ? { revisited: { ...issue.revisited } } : {}),
});

/** 这条错在哪一章：对设定本的条目原句在前文某章时是那章（fixChapter），其余是核的这一章。 */
const homeChapterOf = (issue: Pick<ContinuityIssueV2, "fixChapter">, chapter: number): number =>
  issue.fixChapter !== undefined && issue.fixChapter > 0 ? issue.fixChapter : chapter;

/**
 * 错在前面某章的条目，之前核账报过没有：从它所在那章到上一章，哪章的核账记忆里有同一条（sameIssue）就算报过。
 * 报过的不再当这一章的新问题（作者没改就每章重报一遍，吵）；没报过的（那章没核过、设定后来改了）照常报一次。
 */
async function reportedBefore(projectDir: string, chapter: number, issues: readonly ContinuityIssueV2[]): Promise<ReadonlySet<ContinuityIssueV2>> {
  const earlier = issues.filter((issue) => homeChapterOf(issue, chapter) < chapter);
  if (earlier.length === 0) return new Set();
  const from = Math.min(...earlier.map((issue) => homeChapterOf(issue, chapter)));
  const memories = await Promise.all(
    Array.from({ length: chapter - from }, (_, index) => readCheckMemory(projectDir, from + index).catch(() => undefined)),
  );
  return new Set(earlier.filter((issue) => memories.some((memory) =>
    memory !== undefined
    && memory.chapter >= homeChapterOf(issue, chapter)
    && memory.issues.some((told) => sameIssue(told, issue)))));
}

/** 「第 3、5 章还有 2 处之前报过、还没改。」 */
function earlierOpenNote(chapter: number, items: readonly ChapterCheckItem[]): string {
  if (items.length === 0) return "";
  const chapters = [...new Set(items.map((item) => homeChapterOf(item, chapter)))].sort((a, b) => a - b);
  return `第 ${chapters.join("、")} 章还有 ${items.length} 处之前报过、还没改。`;
}

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
}): Promise<{ readonly issues: readonly ContinuityIssueV2[]; readonly failures: readonly string[]; readonly coverage?: ColdCoverage; readonly waited?: ReaderWaited }> {
  const reader = await checkChapterByReader({
    projectDir: input.projectDir,
    chapter: input.chapter,
    draftBody: input.body,
    callModel: input.callModel,
    maxCatchUp: READER_MAX_CATCH_UP,
    earlier: input.earlier,
    variant: DEFAULT_READER_VARIANT,
  });
  const ledger = await withStep("账本对账", () => ledgerNumberIssues({
    projectDir: input.projectDir,
    chapter: input.chapter,
    draftBody: input.body,
    ...(input.ledgerFacts ? { ledgerFacts: input.ledgerFacts } : {}),
  }));
  // R7.3 相对日子换算（确定性，不调模型）：两句里都有「今天 / 明天 / 后天 / 大后天 / 昨天 / 前天」时按时间线的
  // 故事日换算成绝对第几天再比——同一天不报；换算不了（缺可靠故事日）最多「可能」。时间线读不了当没有，只降档不删条。
  const timeline = await readStoryTimeline(input.projectDir).then((read) => read.timeline).catch(() => undefined);
  const issues = settleMirroredIssues(applyRelativeDayAlignment(mergeContinuityIssues(snapIssueQuotes([...ledger.issues, ...input.carryOver, ...reader.issues], input.chapter, input.body, input.earlier)), input.chapter, timeline)
    .map((issue) => ({ ...issue, confidence: issue.confidence ?? "maybe" as const })), input.chapter)
    .sort((a, b) => (a.confidence === b.confidence ? 0 : a.confidence === "sure" ? -1 : 1));
  return { issues, failures: [...ledger.failures, ...reader.failures], ...(reader.cold ? { coverage: { ...reader.cold } } : {}), ...(reader.waited ? { waited: reader.waited } : {}) };
}

/** 这章这份正文能不能直接用上次的核账结果（正文、前文、账本都没改）：只读盘、不调模型（P11：AI 出稿后补核账卡用）。 */
export async function canReuseCheck(projectDir: string, chapter: number, body: string): Promise<boolean> {
  const memory = await readCheckMemory(projectDir, chapter);
  if (!memory || memory.version !== CHECK_MEMORY_VERSION || memory.bodyHash !== hashBody(body)) return false;
  const earlier = await readEarlierChapters(projectDir, chapter);
  const ledgerFacts = await readFactLedgerStrict(projectDir).then((ledger) => ledger.facts).catch(() => undefined);
  const foundation = await readFoundationDigest(projectDir).catch(() => undefined);
  return memory.earlierHash === hashEarlier(earlier, ledgerFacts ?? [], foundation?.text);
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
  // 设定本也只读一次：记忆的键带上它（改了设定要重核），上次对设定本的条目也按它判还在不在。
  const foundation = await readFoundationDigest(projectDir).catch(() => undefined);
  const bodyHash = hashBody(body);
  const earlierHash = hashEarlier(earlier, ledgerFacts ?? [], foundation?.text);
  // 核账记忆：正文和前文都没改 → 直接给上次的结果（同样的输入同样的输出）；改过 → 上次没改掉的问题带上一起复核。
  const memory = await readCheckMemory(projectDir, chapter);
  const reused = !options.fresh
    && Boolean(memory && memory.version === CHECK_MEMORY_VERSION && memory.bodyHash === bodyHash && memory.earlierHash === earlierHash);
  // 旧版本查错留下的记忆不带（版本号加一 = 那时的结果不可信）。
  const settingStillSays = (settingQuote: string): boolean => foundation !== undefined && settingQuoteSource(foundation, settingQuote) !== undefined;
  const carryOver = memory && !reused && memory.version === CHECK_MEMORY_VERSION
    ? memory.issues.filter((issue) => issueStillPresent(issue, chapter, body, earlier, memory.body, settingStillSays))
    : [];
  let result: { readonly issues: readonly ContinuityIssueV2[]; readonly failures: readonly string[]; readonly coverage?: ColdCoverage; readonly waited?: ReaderWaited };
  let coldTotal: number | undefined;
  if (reused) {
    // R7.3：复用上次结果也照过一遍相对日子换算（纯确定性、不调模型）——作者后来改了故事日时，
    // 旧缓存里「明天 / 后天」那类条目按新时间线重新换算，不会把该收掉的误报又端出来。
    const timeline = await readStoryTimeline(projectDir).then((read) => read.timeline).catch(() => undefined);
    // 方向相反的一对同理照过一遍（纯确定性）：这道收口上线前存下的记忆也不会把成对的「确定」端出来。
    result = { issues: settleMirroredIssues(applyRelativeDayAlignment(memory!.issues, chapter, timeline), chapter), failures: [] };
  } else {
    result = await withStep("核账", () => checkByReader({ projectDir, chapter, body, earlier, carryOver, ...(ledgerFacts ? { ledgerFacts } : {}), callModel: readerCallModel }));
    // 上一遍按核账改过的句子这遍又被报「确定」：两遍说法相反，降成「可能」（不再自动来回改）。
    const fixes = await readFixLog(projectDir, chapter);
    result = { ...result, issues: settleRevisitedIssues(result.issues, chapter, body, fixes) };
    if (result.coverage) {
      // 冷窗口（R4.4）：核账员还没读完全书也照核（不跳过、不装核过——范围如实说），笔记后台接着补（点名 checker）。
      // 读完后作者再点一次「核账」，就是按读完全书来核的；冷窗口没写任何笔记，两边不会混。
      // 分母统一（R4.3 验收 3.3）：回执和界面进度行同一个口径——共 y 章（已定稿）取已定稿章数。
      coldTotal = Math.max(result.coverage.rawTo, await countCommittedChapters(projectDir));
      void catchUpReaders(projectDir, coldTotal, { callModel: readerCallModel, roles: ["checker"] });
    }
  }
  // 核账记忆：冷窗口的结果不写盘（它对照的范围小，不该被当成全书核过缓存起来；下次点「核账」重核，
  // 那时笔记多半已读齐，就是全书的核账）。正常结果照旧缓存。
  if (!reused && !result.coverage && (result.failures.length === 0 || result.issues.length > 0)) {
    await writeCheckMemory(projectDir, { chapter, bodyHash, body, earlierHash, issues: result.issues }).catch((error) => {
      console.warn("[check_continuity] 核账记忆没存上（不影响这次结果）", error);
    });
  }
  // 作者点过「不是问题」的不再报（两边原句都对得上的）。按错所在那章认：前文那章的错在哪章标过都算；
  // 也认核的这一章（以前「不是问题」都记在核的那章上）。
  const dismissals = await readDismissals(projectDir);
  const shown = result.issues.filter((issue) =>
    !isDismissed(chapter, issue, dismissals) && !isDismissed(homeChapterOf(issue, chapter), issue, dismissals));
  const dismissed = result.issues.length - shown.length;
  const told = await reportedBefore(projectDir, chapter, shown);
  const current = shown.filter((issue) => !told.has(issue));
  const sure = current.filter((issue) => issue.confidence === "sure").map(toItem);
  const maybe = current.filter((issue) => issue.confidence !== "sure").map(toItem);
  const earlierOpen = shown.filter((issue) => told.has(issue)).map(toItem);
  const earlierNote = earlierOpenNote(chapter, earlierOpen);
  const ok = result.failures.length === 0 || result.issues.length > 0;
  // 回执里一句问题的措辞：对设定本的写清「第 N 章那句和设定（人物卡）对不上」（错在那章就指那章），其余照旧「和第 N 章」。
  const issueLine = (issue: Readonly<Pick<ChapterCheckItem, "quote" | "earlierQuote" | "earlierChapter" | "reason" | "againstSetting" | "fixChapter">>): string => issue.againstSetting
    ? `${issue.fixChapter !== undefined && issue.fixChapter !== chapter ? `第 ${issue.fixChapter} 章那句` : "本章那句"}「${issue.quote.slice(0, 40)}」和设定（${issue.againstSetting.label}）「${issue.earlierQuote.slice(0, 40)}」对不上：${issue.reason}`
    : `「${issue.quote.slice(0, 40)}」和${issue.earlierChapter === chapter ? "本章前文" : `第 ${issue.earlierChapter} 章`}「${issue.earlierQuote.slice(0, 40)}」：${issue.reason}`;
  const dismissedNote = dismissed > 0 ? `（另有 ${dismissed} 处你标过「不是问题」，没再报。）` : "";
  const reusedNote = reused ? "这一章和前文都没改过，结果同上次。" : "";
  // 等读那一句（R5.2 必做 2）：这次核账前先等核账员当场补了笔记，如实说补了哪几章、花了多久。
  const waitedNote = !reused && result.waited ? `${describeReaderWait("checker", result.waited, "核")}。` : "";
  // 冷窗口的对照范围（R4.4）：如实说「已读笔记 + 第 a～b 章原文 + 账本，更早的细节可能漏」，绝不装作核了全书。
  // （R5.2 试过「缺 3～8 章不等、直接冷窗口」并把缺口补全时的措辞改成「还差 N 章笔记、直接对照原文」——
  //   大考卷比分输了（33.3%/43.9% 查全、46.6s>30s，见 scripts/eval/results/r52-cold-gap-*.json），已删，只留等读标注。）
  const coldNote = result.coverage
    ? `核账员还没读完全书（第 ${result.coverage.notedThrough} / ${coldTotal ?? result.coverage.rawTo} 章），这次对照的是${
      [
        ...(result.coverage.notedThrough > 0 ? [`已读笔记（到第 ${result.coverage.notedThrough} 章）`] : []),
        ...(result.coverage.rawTo > 0 ? [`第 ${result.coverage.rawFrom}～${result.coverage.rawTo} 章原文`] : []),
        "账本",
      ].join(" + ")
    }，更早的细节可能漏。`
    : "";
  const headline = !ok
    ? `${waitedNote}第 ${chapter} 章核账没跑成：${result.failures[0] ?? "原因不明"}。可以再点一次「核账」。${coldNote}`
    : sure.length + maybe.length === 0
      ? `${reusedNote}${waitedNote}核了第 ${chapter} 章，没发现和前文对不上的地方。${earlierNote}${dismissedNote}${coldNote}${result.failures.length > 0 ? `（有一步没跑成：${result.failures[0]}）` : ""}`
      : `${reusedNote}${waitedNote}核了第 ${chapter} 章：确定对不上 ${sure.length} 处${maybe.length > 0 ? `，可能有问题 ${maybe.length} 处` : ""}。${earlierNote}${dismissedNote}${coldNote}`;
  const baseSummary = ok && sure.length > 0
    ? [headline, ...sure.slice(0, 3).map((issue) => `· ${issueLine(issue)}`)].join("\n")
    : headline;
  return {
    ok,
    chapter,
    sure,
    maybe,
    earlierOpen,
    failures: [...result.failures],
    ...(result.coverage ? { coverage: { mode: "cold" as const, ...result.coverage } } : {}),
    ...(!reused && result.waited ? { waited: result.waited } : {}),
    dismissed,
    reused,
    summary: baseSummary,
    headline,
  };
}
