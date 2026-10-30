/**
 * 「账本升级」命令（作者档，写作版本 P2b 设计 2.2）：开书时系统调，把书里 `chapter-ledger/1` 的账单一次全升成 v2。
 *
 * 先存档；一个事务写全部账单（要么全是 v2，要么一份没动）；不调模型、不碰正文 / 裁定 / 设定卡。
 * 幂等：防重复标记带开书时看到的那批旧账单的摘要，书锁里再核一次原样——中间被改过就不升、如实说。
 * 有一章升不了（坏文件、旧格式自己就不成立）整本不升，说清是哪一章。
 * 迁移是撤销的边界：它本身和它之前的操作都撤不了，只能整本恢复（history/revert.ts）。
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { EvidenceStatus } from "../schema/ledger.js";
import { isLedgerV1, upgradeLedgerV1 } from "../ledger/migrate-v1.js";
import { listChapterLedgers, readChapterText } from "../store/book.js";
import { chapterLedgerPath } from "../store/paths.js";
import type { TxWrite } from "../store/transaction.js";
import { fail } from "./runner.js";
import type { WriteCommandSpec } from "./types.js";

export const LEDGER_MIGRATE_COMMAND = "ledger.migrate";

const sha256 = (value: string): string => createHash("sha256").update(value, "utf-8").digest("hex");

export const LedgerMigrateArgs = z.object({
  /** 开书时看到的那批旧账单的摘要（ledgersToUpgrade）。 */
  digest: z.string().regex(/^[0-9a-f]{64}$/u),
});
export type LedgerMigrateArgs = z.infer<typeof LedgerMigrateArgs>;

export interface LedgerMigrateResult {
  /** 升了几章。 */
  readonly chapters: number;
  /** 其中账待记的（导入了还没通读记账的）。 */
  readonly pending: number;
  /** 原句定位的结果（located / quoted / 找不到 / 定稿后改过 / 没原句）各几条。 */
  readonly evidence: Readonly<Record<EvidenceStatus, number>>;
}

interface OldLedgers {
  readonly raws: ReadonlyMap<number, string>;
  readonly digest: string;
}

async function scan(bookDir: string): Promise<OldLedgers | undefined> {
  const raws = new Map<number, string>();
  for (const chapter of await listChapterLedgers(bookDir)) {
    let raw: string;
    try {
      raw = await readFile(join(bookDir, chapterLedgerPath(chapter)), "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (isLedgerV1(raw)) raws.set(chapter, raw);
  }
  if (raws.size === 0) return undefined;
  return { raws, digest: sha256([...raws].map(([chapter, raw]) => `${chapter}\t${sha256(raw)}\n`).join("")) };
}

/** 书里还有没升级的账单：哪几章、那批原样的摘要。都是新格式 = undefined。只读：不写盘、不拿锁。 */
export async function ledgersToUpgrade(bookDir: string): Promise<{ readonly chapters: readonly number[]; readonly digest: string } | undefined> {
  const found = await scan(bookDir);
  return found ? { chapters: [...found.raws.keys()], digest: found.digest } : undefined;
}

/** 这批旧账单升级的防重复标记。 */
export const ledgerMigrateKey = (digest: string): string => `ledger-migrate:2:${digest}`;

export const ledgerMigrate: WriteCommandSpec<LedgerMigrateArgs, LedgerMigrateResult> = {
  name: LEDGER_MIGRATE_COMMAND,
  tier: "author",
  summary: "账本升级：把旧格式的章节账单一次升成新格式（正文、裁定、设定不动）。",
  args: LedgerMigrateArgs,
  snapshot: true,
  idempotent: true,
  async plan(context, args) {
    const found = await scan(context.bookDir);
    if (!found) return fail("nothing_to_upgrade", "账本已经是新格式了。");
    if (found.digest !== args.digest) return fail("changed_since_scan", "打开书之后旧账本又改过，这次没升级。重新打开一次。");
    const writes: TxWrite[] = [];
    const evidence: Record<EvidenceStatus, number> = { located: 0, quoted: 0, unlocated_legacy: 0, stale: 0, none: 0 };
    let pending = 0;
    for (const [chapter, raw] of found.raws) {
      const upgraded = upgradeLedgerV1(raw, await readChapterText(context.bookDir, chapter));
      if (!upgraded.ok) return fail("ledger_unreadable", `第 ${chapter} 章的账本读不了，整本没升级：${upgraded.reason}。`, { chapter });
      if (upgraded.ledger.chapter !== chapter) return fail("ledger_unreadable", `第 ${chapter} 章的账本里写的是第 ${upgraded.ledger.chapter} 章，整本没升级。`, { chapter });
      for (const [status, count] of Object.entries(upgraded.evidence) as [EvidenceStatus, number][]) evidence[status] += count;
      if (upgraded.ledger.status === "pending") pending += 1;
      writes.push({ path: chapterLedgerPath(chapter), content: `${JSON.stringify(upgraded.ledger, null, 2)}\n` });
    }
    const chapters = [...found.raws.keys()];
    return {
      label: "账本升级",
      writes,
      changed: { ledgers: chapters },
      result: { chapters: chapters.length, pending, evidence },
    };
  },
};
