/**
 * 定稿给界面的样子（重构 P3 的 commit_preview / commit_apply 两个工具里挪出来；写作版本 P2a 片 4A 起由 commit.prepare 配方出）：
 * 定不了时的原因卡、停下请作者点的卡（对话里交的「定稿？」、核出对不上的那几处）、定完以后回执那一句。
 *
 * 安静账房（2026-11-03）：账不再列成清单给作者勾。记下的照默认、能撤；只有核出「确定」对不上的才停下给作者看。
 */
import { parseDraftFile, readChapterLedger, readChapterPaper, type ChapterCommitResult, type LedgerCompleteResult } from "@actalk/story-core";
import { markdownTitle } from "../book/story-views.js";
import type { ChapterCheckItem } from "../editorial/continuity/check-service.js";
import type { CommitQualityIssue } from "../writing/commit-quality-check.js";
import { countDraftChineseCharacters } from "../writing/draft-length-control.js";
import { describeQualityIssue, QUALITY_TYPE_LABELS } from "../writing/quality-report-refine.js";
import type { ContinuityCheckOutput } from "./inspect-service.js";

/** 定不了的卡：原因照摆，界面不自己拼字。 */
export interface CommitPreviewView {
  readonly chapter: number;
  readonly blockingReasons: readonly string[];
  /** 给作者看的一句话结论。 */
  readonly summary: string;
  /** 正文硬闸没过的地方（会挡定稿）。 */
  readonly draftIssues?: readonly string[];
  /** 只差字数下限：卡上给「就这么短，照样定稿」。 */
  readonly shortOnly?: boolean;
  /** 补账（正文不动）。 */
  readonly fill?: true;
}

/** 停下请作者挑一个的卡（通用）：几行说明 + 几个按钮，字都由服务端给；核出对不上的那张带着那几处（只有确定的）。 */
export interface AuthorChoicePreview {
  readonly lines: readonly string[];
  readonly choices: readonly { readonly decision: string; readonly label: string; readonly primary?: true }[];
  readonly check?: ContinuityCheckOutput;
}

/** 对话里交的定稿 / 补账：先问一句，作者点了才记账（没点不花钱）。 */
export function commitAskChoice(chapter: number, fill: boolean): AuthorChoicePreview {
  return fill
    ? { lines: [`第 ${chapter} 章的账要补记吗？`], choices: [{ decision: "commit", label: "补记账", primary: true }] }
    : { lines: [`第 ${chapter} 章要定稿吗？定了也能撤。`], choices: [{ decision: "commit", label: "定稿", primary: true }] };
}

/** 定稿前核出和前文确定对不上的：卡上只列这几处（可能的不列），改不改作者定。 */
export function conflictsChoice(chapter: number, check: ContinuityCheckOutput): AuthorChoicePreview {
  const sure: readonly ChapterCheckItem[] = check.sure;
  return {
    lines: [`第 ${chapter} 章有 ${sure.length} 处和前文对不上，改好了再点「定稿」。`],
    choices: [{ decision: "commit", label: "照这样定稿" }],
    check: { ...check, maybe: [], earlierOpen: [] },
  };
}

/** 定不了：原因列在卡上。 */
export function blockedView(chapter: number, reasons: readonly string[], summary: string, extra: Partial<Pick<CommitPreviewView, "draftIssues" | "shortOnly">> = {}): CommitPreviewView {
  return { chapter, blockingReasons: [...reasons], summary, ...extra };
}

/**
 * 下限是作者自己的写作规则（重构 P6 第 7 步）。这一章就该这么短，作者点按钮放这一章；不用为一章去改全书下限
 * （作者长篇实跑 2026-10-26：手写的第 36 章收在悬念上 1137 字，只能去改每章下限才定得了）。
 */
const LENGTH_RULE_HINT = "。这章就该这么短的话，点「就这么短，照样定稿」";

export function describeGate(issue: CommitQualityIssue): string {
  if (issue.type === "too_short") return `${describeQualityIssue(issue)}${LENGTH_RULE_HINT}`;
  return QUALITY_TYPE_LABELS[issue.type] ?? "正文过不了定稿硬闸";
}

/**
 * 字数下限是作者后来定的、这章原来就按短的定了稿：回头改个错字再定稿，不拿下限挡（作者长篇实跑 2026-10-26：
 * 第 3 章删一段重复，被后定的「至少 2000 字」挡住，提示还叫作者把全书下限改低）。返回下限字数；不是这种情况回 undefined。
 */
export async function committedShortOf(projectDir: string, chapter: number, gates: readonly CommitQualityIssue[]): Promise<number | undefined> {
  const short = gates.find((issue) => issue.type === "too_short")?.length;
  if (!short) return undefined;
  const committed = (await readChapterPaper(projectDir, chapter)).committed;
  return committed && countDraftChineseCharacters(committed.body) < short.min ? short.min : undefined;
}

/** 定稿回执卡上的账：记没记上（安静账房：条数不再列给作者）。 */
export interface CommitLedgerReport {
  readonly chapter: number;
  /** 补账的回执（正文没动）。 */
  readonly fill?: true;
  /** pending = 正文定了、账还没记上；partial = 没记全。 */
  readonly status: "pending" | "partial" | "ready";
}

/** 定完以后：回执卡、给作者的那一句话、定稿后的正文（稿纸以「已定稿」载入）。没有回执卡和正文的是回放旧定稿、盘上已经是后来的那份（supersededCommitView）。 */
export interface CommitDone {
  readonly report?: CommitLedgerReport;
  readonly summary: string;
  readonly draftBody?: string;
  readonly draftTitle?: string;
}

/** 回执上除了「定了」之外要说的（每样一句）：账为什么没记上、这次没核成 / 没核全 / 只对照了一部分、记账员交的有几条没记上。 */
export interface CommitNotes {
  readonly ledgerFailed?: string;
  readonly checkFailed?: string;
  /** 核成了、但有一遍没跑成（剩下几遍的结果照用）。 */
  readonly checkPartial?: string;
  readonly checkCold?: boolean;
  /** 记账员交的、核不上没交给定稿的条数。 */
  readonly notRecorded?: number;
}

/** 定稿命令自己说的：拒收的、重定稿后后文还接着却没了来处的（Astra 2026-11-03 第 9 条：这些是没成的事，不能跟着清单一起删）。 */
export type CommitOutcome = Pick<ChapterCommitResult, "rejected" | "orphanedThreads" | "orphanedItems">;

/**
 * 回放一次旧定稿（写成了、记检查点之前断了），这章之后又定过 / 撤过：盘上的正文和账是后来的，不拿来冒充这次的（Astra 第 14 轮第 2 条）。
 */
export function supersededCommitView(chapter: number): CommitDone {
  return { summary: `第 ${chapter} 章这次的定稿已经写成了；这章之后又改过。` };
}

/** 账没记全的原因（账单 coverage 里自家的原因码；认不得的说中性的）。 */
const PARTIAL_REASONS: Readonly<Record<string, string>> = { quote_repair_failed: "补摘原句那一步没成", item_rejected: "东西有几条没记上" };
function partialReasonText(codes: readonly string[]): string {
  const known = [...new Set(codes.flatMap((code) => (PARTIAL_REASONS[code] ? [PARTIAL_REASONS[code]] : [])))];
  return known.length > 0 ? known.join("、") : "有几条没记上";
}

async function reportOf(projectDir: string, chapter: number, fill: boolean): Promise<{ readonly report: CommitLedgerReport; readonly reasonCodes: readonly string[] }> {
  const ledger = await readChapterLedger(projectDir, chapter);
  return { report: { chapter, ...(fill ? { fill: true as const } : {}), status: ledger?.status ?? "ready" }, reasonCodes: ledger?.coverage.reasonCodes ?? [] };
}

/** 核账没跑成、没核全、只对照了一部分：各一句。 */
function checkLines(notes: CommitNotes): string[] {
  return [
    ...(notes.checkFailed ? [`这次没核成：${notes.checkFailed}。`] : []),
    ...(notes.checkPartial ? [`这次没核全：${notes.checkPartial}。`] : []),
    ...(notes.checkCold ? ["核账员还没读完前文，这次只对照了读过的和最近几章。"] : []),
  ];
}

/**
 * 账上没成的：有几条没记上（账记全了才单说，没记全的那句已经包了）；重定稿后后面几章还接着、这章却不再写它来处的线索和东西。
 */
function ledgerLines(status: CommitLedgerReport["status"], notRecorded: number, outcome: CommitOutcome | undefined): string[] {
  const missed = notRecorded + (outcome?.rejected.length ?? 0);
  const orphaned = [...(outcome?.orphanedThreads ?? []), ...(outcome?.orphanedItems ?? []).map((name) => name || "一样东西")];
  return [
    ...(status === "ready" && missed > 0 ? [`有 ${missed} 条账没记上。`] : []),
    ...(orphaned.length > 0 ? [`后面几章还接着${orphaned.slice(0, 3).map((title) => `「${title}」`).join("")}，这章改过以后不再写它的来处，要看一下。`] : []),
  ];
}

/** 定稿成了：一句话（读的是盘上刚写好的账）。账待记 / 没记全的如实说，回执卡上给「补记账」。 */
export async function commitDoneView(projectDir: string, chapter: number, text: string, notes: CommitNotes = {}, outcome?: CommitOutcome): Promise<CommitDone> {
  const { report, reasonCodes } = await reportOf(projectDir, chapter, false);
  const head = report.status === "pending"
    ? `第 ${chapter} 章定稿了，账没记上${notes.ledgerFailed ? `（${notes.ledgerFailed}）` : ""}；可以点「补记账」再记。`
    : report.status === "partial"
      ? `第 ${chapter} 章定稿了，账没记全（${partialReasonText(reasonCodes)}）；可以点「补记账」补全。`
      : `第 ${chapter} 章定稿了。`;
  const title = markdownTitle(text);
  return {
    report,
    summary: [head, ...ledgerLines(report.status, notes.notRecorded ?? 0, outcome), ...checkLines(notes)].join(""),
    draftBody: parseDraftFile(text).body,
    ...(title ? { draftTitle: title } : {}),
  };
}

/** 补账成了：一句话（正文没动，稿纸不重新载入）。 */
export async function fillDoneView(projectDir: string, chapter: number, result: Pick<LedgerCompleteResult, "ledgerStatus">, notRecorded = 0): Promise<CommitDone> {
  const { report, reasonCodes } = await reportOf(projectDir, chapter, true);
  const head = result.ledgerStatus === "partial" ? `第 ${chapter} 章的账补了，还是没记全（${partialReasonText(reasonCodes)}）。` : `第 ${chapter} 章的账补上了。`;
  return { report, summary: [head, ...ledgerLines(report.status, notRecorded, undefined)].join("") };
}
