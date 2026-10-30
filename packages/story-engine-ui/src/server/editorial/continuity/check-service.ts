/**
 * 核账服务（2026-10-10 引擎升级第 3 期：所有入口共用这一套；2026-10-12 编辑部 R3 起只剩核账员一路）。
 *
 * 核账按钮、对话里说「核一下」、AI 出稿后的自检都走 checkChapterBody：同一套确定性对账（账本数字）+
 * 核账员三遍（跟读窗口，带 A 自复核 + F 时间线只进自复核）、同一份核账记忆和「不是问题」批注。
 * 正文由调用方给（出稿后自检核的是还没落盘的稿子）。只读：不改正文、不写账本；只写核账记忆（作者的查错记录）。
 */
import { describeTimelineForChapter, type StoryTimeline } from "../../book/story-timeline.js";
import { readStoryViews } from "../../book/story-views.js";
import { type FactEntry } from "../../book/types.js";
import {
  callConfiguredBrainModel,
  checkChapterByReader,
  checkerRoleFor,
  coldPausedNote,
  countCommittedChapters,
  DEFAULT_READER_VARIANT,
  describeReaderWait,
  ensureReaderWindow,
  readerWaitingHandlers,
  recheckChangesByReader,
  type BrainCallModel,
  type ChangedSentence,
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
import { CHECK_MEMORY_VERSION, hashBody, hashEarlier, readCheckMemory, writeCheckMemory, type CheckMemory } from "./check-memory.js";
import { readFixLog, type FixRecord } from "../../lib/fix-log.js";
import { isDismissed, readDismissals, sameIssue } from "./dismissals.js";
import { readFoundationDigest, settingQuoteSource, type FoundationDigest } from "../foundation-digest.js";
import { prepareReaderNotes, type ReaderNotesOutcome } from "../prepare-notes.js";
import { withStep } from "../../lib/token-meter.js";
import { requestReaderBackfill } from "../../lib/reader-backfill.js";
import { rethrowIfStopped } from "../../lib/operations/context.js";
import { readTruthBasisToCompare, readWithStableBasisForWork } from "../../book/truth-basis.js";

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
  readonly coverage?: { readonly mode: "cold"; readonly notedThrough: number; readonly rawFrom: number; readonly rawTo: number; readonly pausedBackfill?: string };
  /** 这次核账前先当场补了笔记（R5.2）：补了第 from～to 章、花了 ms 毫秒。summary 已带「这次先等核账员读完…再核」。 */
  readonly waited?: ReaderWaited;
  /** 作者标过「不是问题」、这次没再报的条数。 */
  readonly dismissed: number;
  /** 正文、前文、账本都没改过，直接用的上次结果（没调模型）。 */
  readonly reused: boolean;
  /** 上一遍核过的稿只按核账改了几句：这次只核了改过的这几句，别的沿用上一遍（外部审查 2026-10-28）。 */
  readonly rechecked?: { readonly changed: number };
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
export const READER_MAX_CATCH_UP = 10;
/** 核账员那一路当场最多新生成几个卷节点（写作版本 P2a 4.5 额度按它算）；到了也走冷窗口、剩下的后台补。 */
export const READER_MAX_VOLUME_BUILDS = 2;

export interface ChapterCheckOptions {
  /** 正文没改也重新核；改过也整章重核（不只核改过的句子）。 */
  readonly fresh?: boolean;
  /** 这份正文是上一遍核过的稿按核账改了这几句（出稿流程里按核账改后）。缺省按改句记录找。 */
  readonly afterFix?: readonly ChangedSentence[];
  /** 核账员的模型调用（测试注入）；缺省走配置的 qualityCheck 模型。 */
  readonly readerCallModel?: BrainCallModel;
  /** 前文笔记已经在前一步补过（`prepareCheckerNotes`）：核的时候不再当场补，缺了照冷窗口核。 */
  readonly notesReady?: { readonly waited?: ReaderWaited };
}

/** 还缺几份（超过当场上限、卷节点到了上限）：缺就照冷窗口核。 */
export type CheckerNotesOutcome = ReaderNotesOutcome;

/**
 * 核第 chapter 章之前先让核账员读完前文（写作版本 P2a inspect.run 的 notes 步）：当场最多补 READER_MAX_CATCH_UP 章、
 * READER_MAX_VOLUME_BUILDS 个卷节点；缺得更多就不补（0 次调用，之后照冷窗口核、交后台补读）。补到一半模型调用失败照实抛。
 */
export function prepareCheckerNotes(projectDir: string, chapter: number, callModel: BrainCallModel = callConfiguredBrainModel): Promise<CheckerNotesOutcome> {
  return prepareReaderNotes({
    projectDir,
    role: checkerRoleFor(DEFAULT_READER_VARIANT.structuredNotes),
    chapter,
    callModel,
    maxCatchUp: READER_MAX_CATCH_UP,
    maxVolumeBuilds: READER_MAX_VOLUME_BUILDS,
    waitingAs: "核账",
  });
}

/**
 * 核账：账本数字对账（确定性层）+ 核账员三遍，合并去重（账本的排前面）。
 * 上次的问题两边原句还在的交给核账员，和这次的候选一起进自复核：判 no 的去掉（错在别处改好了），其余照带、把握沿用上次。
 */
async function checkByReader(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly body: string;
  readonly earlier: EarlierText;
  readonly carryOver: readonly ContinuityIssueV2[];
  readonly ledgerFacts?: readonly FactEntry[];
  readonly callModel: BrainCallModel;
  /** 只核改过的这几句：上一遍的结果（carryOver）已复核过，原样带上，排在新核出的前面。 */
  readonly changes?: readonly ChangedSentence[];
  readonly notesReady?: { readonly waited?: ReaderWaited };
}): Promise<{ readonly issues: readonly ContinuityIssueV2[]; readonly failures: readonly string[]; readonly coverage?: ColdCoverage; readonly waited?: ReaderWaited }> {
  const common = {
    projectDir: input.projectDir,
    chapter: input.chapter,
    draftBody: input.body,
    callModel: input.callModel,
    maxCatchUp: READER_MAX_CATCH_UP,
    maxVolumeBuilds: READER_MAX_VOLUME_BUILDS,
    earlier: input.earlier,
    variant: DEFAULT_READER_VARIANT,
    ...(input.notesReady ? { notesReady: input.notesReady } : {}),
  };
  const reader = input.changes
    ? await recheckChangesByReader({ ...common, changes: input.changes }).then((focused) => ({ ...focused, issues: [...input.carryOver, ...focused.issues] }))
    : await checkChapterByReader({ ...common, carryOver: input.carryOver });
  const ledger = await withStep("账本对账", () => ledgerNumberIssues({
    projectDir: input.projectDir,
    chapter: input.chapter,
    draftBody: input.body,
    ...(input.ledgerFacts ? { ledgerFacts: input.ledgerFacts } : {}),
  }));
  // R7.3 相对日子换算（确定性，不调模型）：两句里都有「今天 / 明天 / 后天 / 大后天 / 昨天 / 前天」时按时间线的
  // 故事日换算成绝对第几天再比——同一天不报；换算不了（缺可靠故事日）最多「可能」。时间线读不了当没有，只降档不删条。
  const timeline = await readStoryViews(input.projectDir).then((views) => views.timeline).catch(() => undefined);
  const issues = settleMirroredIssues(applyRelativeDayAlignment(mergeContinuityIssues(snapIssueQuotes([...ledger.issues, ...reader.issues], input.chapter, input.body, input.earlier)), input.chapter, timeline)
    .map((issue) => ({ ...issue, confidence: issue.confidence ?? "maybe" as const })), input.chapter)
    .sort((a, b) => (a.confidence === b.confidence ? 0 : a.confidence === "sure" ? -1 : 1));
  return { issues, failures: [...ledger.failures, ...reader.failures], ...(reader.cold ? { coverage: { ...reader.cold } } : {}), ...(reader.waited ? { waited: reader.waited } : {}) };
}

/**
 * 核账的输入读一次：前文、账本、设定本、时间线。核账记忆的键从这份算——核账员看得到的都进键（时间线表也进，
 * 作者改了哪天要重核）。有一样读不了，键就是 undefined：不复用上次的，这次的结果也不存（读不了时核出来的不算全）。
 * 材料夹在两次读依据之间读（readWithStableBasisForWork，两次都在书锁里取）：中途书上有写（哪怕又改回原样），键也是 undefined。
 */
export async function readCheckInputs(projectDir: string, chapter: number): Promise<{
  readonly earlier: EarlierText;
  readonly ledgerFacts?: readonly FactEntry[];
  readonly foundation?: FoundationDigest;
  readonly timeline?: StoryTimeline;
  readonly earlierHash?: string;
  /** 读材料那会儿书的依据摘要（带写入代次）：核完存记忆前再核一遍，核的途中书变了就不存。 */
  readonly basisDigest?: string;
}> {
  const { value, basis } = await readWithStableBasisForWork(projectDir, async () => {
    const earlier = await readEarlierChapters(projectDir, chapter);
    const views = await readStoryViews(projectDir).catch(() => undefined);
    const ledgerFacts = views?.facts.facts;
    let foundationRead = true;
    const foundation = await readFoundationDigest(projectDir).catch(() => {
      foundationRead = false;
      return undefined;
    });
    const timeline = views?.timeline;
    return { earlier, ledgerFacts, foundationRead, foundation, timeline };
  });
  const { earlier, ledgerFacts, foundationRead, foundation, timeline } = value;
  const earlierHash = basis && ledgerFacts && foundationRead && timeline
    ? hashEarlier(basis, chapter, { ledger: ledgerFacts, ...(foundation ? { setting: foundation.text } : {}), timeline: describeTimelineForChapter(timeline, chapter) })
    : undefined;
  return {
    earlier,
    ...(ledgerFacts ? { ledgerFacts } : {}),
    ...(foundation ? { foundation } : {}),
    ...(timeline ? { timeline } : {}),
    ...(earlierHash ? { earlierHash } : {}),
    ...(basis ? { basisDigest: basis.digest } : {}),
  };
}

/**
 * 这份正文是不是上一遍核过的那份只改了这几句：上一遍那份按改前 → 改后逐句换（各换第一处）后和这份一样（不计空白）。
 * 一句换不上、换完对不上（作者另外动过）都不算——那就整章重核。
 */
export function changesExplain(previous: string, changes: readonly ChangedSentence[], body: string): boolean {
  let text = previous;
  for (const change of changes) {
    const at = change.from ? text.indexOf(change.from) : -1;
    if (at < 0) return false;
    text = text.slice(0, at) + change.to + text.slice(at + change.from.length);
  }
  return hashBody(text) === hashBody(body);
}

/** 改句记录里最近这几次改动（最近 1 条、2 条……）能不能把上一遍核过的那份换成现在这份；能就是这几句。 */
const FIX_LOG_LOOKBACK = 12;
function changesFromFixLog(previous: string, body: string, log: readonly FixRecord[]): readonly ChangedSentence[] | undefined {
  for (let count = 1; count <= Math.min(log.length, FIX_LOG_LOOKBACK); count += 1) {
    const recent = log.slice(-count);
    if (changesExplain(previous, recent, body)) return recent;
  }
  return undefined;
}

/**
 * 这章的核账记忆，前文、账本、设定、时间线都还是那时的才给（正文可以不同）；对不上、读不了都是 undefined。
 * 拿核账记忆当材料用（重写时交给写手的「上一稿核出的错」）一律走这里（第 7 轮复核 U4：前文改过了，旧记忆还在让写手照旧前文写）。
 */
export async function readCurrentCheckMemory(projectDir: string, chapter: number): Promise<CheckMemory | undefined> {
  const memory = await readCheckMemory(projectDir, chapter).catch(() => undefined);
  if (!memory || memory.version !== CHECK_MEMORY_VERSION) return undefined;
  const { earlierHash } = await readCheckInputs(projectDir, chapter);
  return earlierHash !== undefined && memory.earlierHash === earlierHash ? memory : undefined;
}

/** 这章这份正文能不能直接用上次的核账结果（正文、前文、账本、设定、时间线都没改）：只读盘、不调模型（P11：AI 出稿后补核账卡用）。 */
export async function canReuseCheck(projectDir: string, chapter: number, body: string): Promise<boolean> {
  const memory = await readCurrentCheckMemory(projectDir, chapter);
  return memory !== undefined && memory.bodyHash === hashBody(body);
}

export async function checkChapterBody(
  projectDir: string,
  chapter: number,
  body: string,
  options: ChapterCheckOptions = {},
): Promise<ChapterCheckResult> {
  // 账本只读一次：数字对账用它，核账记忆的键也带上它。读不了就不传，核账那边会如实记「账本读不了」。
  // 设定本也只读一次：上次对设定本的条目按它判还在不在。
  const { earlier, ledgerFacts, foundation, timeline, earlierHash, basisDigest } = await readCheckInputs(projectDir, chapter);
  const readerCallModel = options.readerCallModel ?? callConfiguredBrainModel;
  const bodyHash = hashBody(body);
  // 核账记忆：正文和前文都没改 → 直接给上次的结果（同样的输入同样的输出）；改过 → 上次没改掉的问题带上一起复核。
  const memory = await readCheckMemory(projectDir, chapter);
  const reused = !options.fresh && earlierHash !== undefined
    && Boolean(memory && memory.version === CHECK_MEMORY_VERSION && memory.bodyHash === bodyHash && memory.earlierHash === earlierHash);
  // 旧版本查错留下的记忆不带（版本号加一 = 那时的结果不可信）。
  const settingStillSays = (settingQuote: string): boolean => foundation !== undefined && settingQuoteSource(foundation, settingQuote) !== undefined;
  const carryOver = memory && !reused && memory.version === CHECK_MEMORY_VERSION
    ? memory.issues.filter((issue) => issueStillPresent(issue, chapter, body, earlier, memory.body, settingStillSays))
    : [];
  // 改后按改动重核（外部审查 2026-10-28）：上一遍整章核全了（记忆是同一份前文下存的），这份只是按核账改了几句 →
  // 只核改过的句子，别的沿用上一遍。换不上、前文改过、作者要「再细核一遍」都整章重核。
  const fixes = await readFixLog(projectDir, chapter);
  const changes = !reused && !options.fresh && memory && memory.version === CHECK_MEMORY_VERSION && earlierHash !== undefined && memory.earlierHash === earlierHash
    ? options.afterFix && options.afterFix.length > 0
      ? changesExplain(memory.body, options.afterFix, body) ? options.afterFix : undefined
      : changesFromFixLog(memory.body, body, fixes)
    : undefined;
  let result: { readonly issues: readonly ContinuityIssueV2[]; readonly failures: readonly string[]; readonly coverage?: ColdCoverage; readonly waited?: ReaderWaited };
  let coldTotal: number | undefined;
  if (reused) {
    // R7.3：复用上次结果也照过一遍相对日子换算（纯确定性、不调模型）——作者后来改了故事日时，
    // 旧缓存里「明天 / 后天」那类条目按新时间线重新换算，不会把该收掉的误报又端出来。
    // 方向相反的一对同理照过一遍（纯确定性）：这道收口上线前存下的记忆也不会把成对的「确定」端出来。
    result = { issues: settleMirroredIssues(applyRelativeDayAlignment(memory!.issues, chapter, timeline), chapter), failures: [] };
  } else {
    result = await withStep("核账", () => checkByReader({ projectDir, chapter, body, earlier, carryOver, ...(ledgerFacts ? { ledgerFacts } : {}), callModel: readerCallModel, ...(changes ? { changes } : {}), ...(options.notesReady ? { notesReady: options.notesReady } : {}) }));
    // 上一遍按核账改过的句子这遍又被报「确定」：两遍说法相反，降成「可能」（不再自动来回改）。
    result = { ...result, issues: settleRevisitedIssues(result.issues, chapter, body, fixes) };
    if (result.coverage) {
      // 冷窗口（R4.4）：核账员还没读完全书也照核（不跳过、不装核过——范围如实说），笔记后台接着补（点名 checker）。
      // 读完后作者再点一次「核账」，就是按读完全书来核的；冷窗口没写任何笔记，两边不会混。
      // 分母统一（R4.3 验收 3.3）：回执和界面进度行同一个口径——共 y 章（已定稿）取已定稿章数。
      coldTotal = Math.max(result.coverage.rawTo, await countCommittedChapters(projectDir));
      requestReaderBackfill(projectDir, { roles: ["checker"], upTo: coldTotal });
    }
  }
  // 核账记忆：冷窗口的结果不写盘（它对照的范围小，不该被当成全书核过缓存起来；下次点「核账」重核，
  // 那时笔记多半已读齐，就是全书的核账）。有一步没跑成的也不存：存了下次就当全核过端出来，那一步的失败没了。
  // 核的途中书上有写（专员笔记、前文都可能跟着变了）：这遍的结果照常给，但不当成这份前文的核账记忆存。
  const bookUnchanged = async (): Promise<boolean> => basisDigest !== undefined && (await readTruthBasisToCompare(projectDir).catch(() => undefined))?.digest === basisDigest;
  if (!reused && !result.coverage && result.failures.length === 0 && earlierHash !== undefined && (await bookUnchanged())) {
    await writeCheckMemory(projectDir, { chapter, bodyHash, body, earlierHash, issues: result.issues }).catch((error) => {
      rethrowIfStopped(error); // 这次操作停掉了：照原样停，不当成「没存上、照常往下走」
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
    }，更早的细节可能漏。${coldPausedNote(result.coverage)}`
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
    ...(changes ? { rechecked: { changed: changes.length } } : {}),
    summary: baseSummary,
    headline,
  };
}
