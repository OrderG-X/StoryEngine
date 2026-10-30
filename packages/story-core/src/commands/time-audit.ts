/**
 * 「天数盘点」命令（作者档，写作版本 P3a 设计 2.6）：开书时系统调（和账本升级同一个入口），把以前导入老书时记进账的
 * 不可信天数改成「不知道」：伪作者裁定（老文件里不是作者定的、却记成了作者定的）、估的、比上一章早的，以及紧跟它们的下一章。
 *
 * 和新导入用同一条规则（import/legacy-time.ts）：按导入时的证据——书里还留着的老格式时间线——判；老文件不在了，
 * 记成作者定的天数证明不了，同样改成不知道、列给作者确认（投影里 legacyDay.reason = unproven）。
 * 编号、原句不变，原来的值和依据进条目的 legacy。先存档、一个事务写完、能撤销；不调模型、不碰正文 / 裁定 / 设定卡。
 * 幂等：防重复标记带开书时看到的那批账单的摘要，书锁里再核一次——中间被改过就不改、如实说。改过的不会再被盘出来。
 */
import { z } from "zod";
import { ChapterLedger, timeRoleOf, type LedgerEntry, type LegacyTime, type TimeEntry } from "../schema/ledger.js";
import { readLegacyData } from "../import/legacy.js";
import { legacyTimelineRow, legacyTimeOf } from "../import/legacy-time.js";
import { readAllLedgers, readChapterLedgerFile } from "../store/book.js";
import { chapterLedgerPath } from "../store/paths.js";
import { sha256Bytes } from "../store/transaction.js";
import type { TxWrite } from "../store/transaction.js";
import { fail } from "./runner.js";
import type { WriteCommandSpec } from "./types.js";

export const TIME_AUDIT_COMMAND = "time.audit";

export const TimeAuditArgs = z.object({
  /** 开书时看到的要改的那批（timeAuditPlan）的摘要。 */
  digest: z.string().regex(/^[0-9a-f]{64}$/u),
});
export type TimeAuditArgs = z.infer<typeof TimeAuditArgs>;

export interface TimeAuditChange {
  readonly chapter: number;
  readonly legacy: LegacyTime;
}

export interface TimeAuditResult {
  /** 改成不知道的章。 */
  readonly chapters: readonly number[];
  /** 其中记成作者定的、老文件不在了证明不了的（要作者确认）。 */
  readonly unproven: readonly number[];
}

const startOf = (ledger: ChapterLedger): TimeEntry | undefined =>
  ledger.entries.find((entry): entry is TimeEntry => entry.kind === "time" && (timeRoleOf(entry) === "start" || timeRoleOf(entry) === "authorStart"));

/** 导入来的旧账（还没重记过、记了时间的）。 */
const imported = (ledger: ChapterLedger): boolean => ledger.origin === "import" && ledger.timeModel === undefined && ledger.status !== "pending";

/**
 * 要改哪几章（纯函数）：rows = 书里老格式时间线（按章排好；老文件不在了给空）。fromPlans = 时间线文件不在、rows 是照老代码从章纲现推的：
 * 推出来的不会有作者定的，账里记成作者定的也说不清当年是不是（证明不了，unproven），不说「不是作者定的」。
 */
export function planTimeAudit(
  ledgers: readonly ChapterLedger[],
  rows: readonly Parameters<typeof legacyTimelineRow>[0][],
  options: { readonly fromPlans?: boolean } = {},
): TimeAuditChange[] {
  const byChapter = new Map(ledgers.filter(imported).map((ledger) => [ledger.chapter, ledger]));
  const already = (ledger: ChapterLedger): boolean => startOf(ledger)?.legacy !== undefined;
  const changes: TimeAuditChange[] = [];
  if (rows.length > 0) {
    const sorted = [...rows].sort((a, b) => a.chapter - b.chapter).filter((row, index, all) => index === 0 || all[index - 1]!.chapter !== row.chapter);
    const outcomes = legacyTimeOf(sorted.map((row) => {
      const stored = byChapter.get(row.chapter);
      return { ...legacyTimelineRow(row), storedAsAuthor: stored !== undefined && startOf(stored)?.relation === "at" };
    }));
    for (const outcome of outcomes) {
      const ledger = byChapter.get(outcome.chapter);
      if (!ledger || outcome.kind !== "unknown" || already(ledger) || !startOf(ledger)) continue;
      const legacy = options.fromPlans && outcome.legacy.reason === "not_author" ? { ...outcome.legacy, reason: "unproven" as const } : outcome.legacy;
      changes.push({ chapter: outcome.chapter, legacy });
    }
    return changes;
  }
  // 老文件不在了：记成作者定的证明不了、估的，和紧跟它们的下一章（差值是相对它算的）。
  let previousBad: number | undefined;
  for (const ledger of [...byChapter.values()].sort((a, b) => a.chapter - b.chapter)) {
    const start = startOf(ledger);
    const afterBad = previousBad !== undefined && previousBad === ledger.chapter - 1;
    previousBad = undefined;
    if (!start || already(ledger)) continue;
    const day = start.day;
    if (start.relation === "at") {
      changes.push({ chapter: ledger.chapter, legacy: { relation: "at", ...(day !== undefined ? { day } : {}), basis: start.basis, reason: "unproven" } });
      previousBad = ledger.chapter;
    } else if (start.basis === "estimated") {
      changes.push({ chapter: ledger.chapter, legacy: { relation: start.relation, ...(start.offset ? { offset: start.offset } : {}), basis: start.basis, reason: "estimated" } });
      previousBad = ledger.chapter;
    } else if (afterBad && start.relation === "offset") {
      changes.push({ chapter: ledger.chapter, legacy: { relation: start.relation, ...(start.offset ? { offset: start.offset } : {}), basis: start.basis, reason: "after_bad" } });
    }
  }
  return changes;
}

/** 这一章的账按盘点改：本章开头那条改成不知道（原值进 legacy），结尾那条（本章内过了几天）去掉。 */
export function auditedLedger(ledger: ChapterLedger, change: TimeAuditChange): ChapterLedger {
  const start = startOf(ledger) as TimeEntry;
  const entries: LedgerEntry[] = [];
  for (const entry of ledger.entries) {
    if (entry.kind !== "time") {
      entries.push(entry);
    } else if (entry.id === start.id) {
      const { anchor: _anchor, offset: _offset, day: _day, ...rest } = entry;
      entries.push({ ...rest, relation: "unknown", legacy: change.legacy });
    } else if (timeRoleOf(entry) !== "end" && timeRoleOf(entry) !== "authorEnd") {
      entries.push(entry);
    }
  }
  return { ...ledger, entries };
}

const digestOf = (changes: readonly TimeAuditChange[], hashes: ReadonlyMap<number, string>): string =>
  sha256Bytes(changes.map((change) => `${change.chapter}\t${hashes.get(change.chapter) ?? ""}\t${change.legacy.reason}\n`).join(""));

/** 书里有要盘的天数：哪几章、那批的摘要。没有 = undefined。只读：不写盘、不拿锁。 */
export async function timeAuditPlan(bookDir: string): Promise<{ readonly chapters: readonly number[]; readonly digest: string; readonly changes: readonly TimeAuditChange[] } | undefined> {
  const ledgers = await readAllLedgers(bookDir);
  if (!ledgers.some(imported)) return undefined;
  const legacy = await readLegacyData(bookDir);
  const changes = planTimeAudit(ledgers, legacy.timeline, { fromPlans: legacy.timelineFromPlans });
  if (changes.length === 0) return undefined;
  const hashes = new Map<number, string>();
  for (const change of changes) {
    const file = await readChapterLedgerFile(bookDir, change.chapter);
    if (file) hashes.set(change.chapter, file.sha256);
  }
  return { chapters: changes.map((change) => change.chapter), digest: digestOf(changes, hashes), changes };
}

/** 这批盘点的防重复标记。 */
export const timeAuditKey = (digest: string): string => `time-audit:1:${digest}`;

export const timeAudit: WriteCommandSpec<TimeAuditArgs, TimeAuditResult> = {
  name: TIME_AUDIT_COMMAND,
  tier: "author",
  summary: "天数盘点：把以前导入老书时记进账的不可信天数改成「不知道」（原值留着，正文、裁定、设定不动）。",
  args: TimeAuditArgs,
  snapshot: true,
  idempotent: true,
  async plan(context, args) {
    const found = await timeAuditPlan(context.bookDir);
    if (!found) return fail("nothing_to_audit", "天数已经盘过了。");
    if (found.digest !== args.digest) return fail("changed_since_scan", "打开书之后账又改过，这次没盘。重新打开一次。");
    const writes: TxWrite[] = [];
    for (const change of found.changes) {
      const file = await readChapterLedgerFile(context.bookDir, change.chapter);
      if (!file) return fail("changed_since_scan", "打开书之后账又改过，这次没盘。重新打开一次。");
      const next = ChapterLedger.safeParse(auditedLedger(file.ledger, change));
      if (!next.success) return fail("ledger_invalid", `第 ${change.chapter} 章的账盘完拼不成，整本没盘。`, { chapter: change.chapter });
      writes.push({ path: chapterLedgerPath(change.chapter), content: `${JSON.stringify(next.data, null, 2)}\n` });
    }
    return {
      label: "天数盘点",
      writes,
      changed: { ledgers: [...found.chapters] },
      result: { chapters: [...found.chapters], unproven: found.changes.filter((change) => change.legacy.reason === "unproven").map((change) => change.chapter) },
    };
  },
};
