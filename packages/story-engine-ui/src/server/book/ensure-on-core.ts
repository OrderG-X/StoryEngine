/**
 * 打开书时把书接到新核心上（重构 P3 第 7 步）：
 *
 *   - 有定稿正文、却还没有账单（老书）→ 先存撤销点，再「导入老书」：老账按章归成导入账单，老文件一个字节都不碰；
 *   - 还没有设定卡 `ledger/cards.json`（重构 P9 以前的书）→ 先存撤销点，再「搬老设定」：老设定文件拼成设定卡，
 *     老文件不碰；什么老设定都没有就建一份空的；
 *   - 书里还留着以前生成的老格式镜像（有标记 `.story-core-mirror.json`）→ 连标记挪进 `.story-core-kept/mirror-retired/`
 *     （写作版本 P2b 起读者都从投影现算，镜像没人读了；挪、不删）。没标记的老文件不碰：还没导入的老书要靠它们导入。
 *
 *   - 账单还是旧格式（`chapter-ledger/1`，写作版本 P2b 以前）→ 先存撤销点，再「账本升级」：一个事务全升成新格式，
 *     正文、裁定、设定不碰；有一章升不了整本不升、如实说没接上。升级是撤销的边界（之前的只能整本恢复）。
 *
 * 新书建书时就写好了设定卡，还没有定稿章不用导入账单：第一次定稿就会建出账单。这一步每次开书都会调，
 * 已经接好的书只列一次目录、读几个小文件。
 *
 * 最前面先收老版本中途崩溃留下的老定稿链事务残留（`.story-engine-tx/`，没有就是一次 lstat）：
 * 读路径都不再收它（重构 P7），开书是唯一入口。
 */
import { mkdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BOOK_START_KEYS, bookImport, cardsImport, KEPT_TX_DIR, ledgerMigrate, ledgerMigrateKey, ledgersToUpgrade, listChapterLedgers, LegacyResidueError, listChapterTexts, readCards, recoverBookTransactions, runCommand, withBookLock, type BookImportResult, type CardsImportResult, type LedgerMigrateResult, type RunOptions } from "@actalk/story-core";

/** 以前生成镜像时写的标记：有它 = 下面这几个文件是我们从账生成的（原来的老文件第一次生成前另存过）。 */
const MIRROR_MARKER = ".story-core-mirror.json";
const MIRROR_FILES = ["story/timeline.json", "time/calendar.json", "story/fact-ledger.json", "story/threads.json", "story/hooks.json", "story/arc-goals.json", "timeline/events.json"] as const;
const RETIRED_DIR = `${KEPT_TX_DIR}/mirror-retired`;

export type EnsureOnCoreResult =
  | {
      readonly ok: true;
      /** 这次导入了老书（导入了几章）。 */
      readonly imported?: BookImportResult;
      /** 这次把旧格式账单升成了新格式。 */
      readonly migrated?: LedgerMigrateResult;
      /** 这次把老设定搬进了设定卡。 */
      readonly cards?: CardsImportResult;
      /** 这次把以前生成的镜像挪走了（挪了哪几个文件）。 */
      readonly retired?: readonly string[];
    }
  | { readonly ok: false; readonly code: string; readonly reason: string };

export interface EnsureOnCoreOptions {
  /** 导入前存撤销点（失败就不导入）。第二个参数是命令名；返回树号记进回执（核心 RunOptions.snapshot）。 */
  readonly snapshot?: RunOptions["snapshot"];
}

const pending = new Map<string, Promise<EnsureOnCoreResult>>();

/** 同一本书同时开两次（总览和章节列表一起请求）只做一遍。 */
export async function ensureBookOnCore(bookDir: string, options: EnsureOnCoreOptions = {}): Promise<EnsureOnCoreResult> {
  const running = pending.get(bookDir);
  if (running) return running;
  const run = ensureNow(bookDir, options).finally(() => pending.delete(bookDir));
  pending.set(bookDir, run);
  return run;
}

async function ensureNow(bookDir: string, options: EnsureOnCoreOptions): Promise<EnsureOnCoreResult> {
  try {
    // 老格式、新核心写到一半的事务都先收拾（下面先读盘看有没有账单）。收拾不了的如实说没接上（P1 第 18 轮 C182），不报接好了。
    const recovery = await recoverBookTransactions(bookDir);
    if (recovery.problems.length > 0) return { ok: false, code: "tx_residue", reason: "上次写到一半的记录读不了，先不动这本书，免得丢数据" };
  } catch (error) {
    if (error instanceof LegacyResidueError) return { ok: false, code: "legacy_tx_residue", reason: "升级之前写到一半的记录收拾不了，先不动这本书，免得丢数据" };
    return { ok: false, code: "book_unreadable", reason: error instanceof Error ? error.message : String(error) };
  }
  const snapshot = options.snapshot ? { snapshot: options.snapshot } : {};
  // 旧格式账单先升级：读路径见了旧格式只报「要升级」，不在读的时候猜着读。
  let migrated: LedgerMigrateResult | undefined;
  const old = await ledgersToUpgrade(bookDir).catch((error: unknown) => error as Error);
  if (old instanceof Error) return { ok: false, code: "book_unreadable", reason: old.message };
  if (old) {
    const outcome = await runCommand(bookDir, ledgerMigrate, { digest: old.digest }, { caller: "author", idempotencyKey: ledgerMigrateKey(old.digest), ...snapshot });
    if (!outcome.ok && outcome.code !== "nothing_to_upgrade") return { ok: false, code: outcome.code, reason: outcome.message };
    if (outcome.ok) migrated = outcome.result;
  }
  // 先导账单再搬设定：看「有没有账单」而不是书的版本号（搬设定、改设定也会让版本号往上走）。
  let ledgers = (await listChapterLedgers(bookDir)).length;
  let imported: BookImportResult | undefined;
  if (ledgers === 0 && (await listChapterTexts(bookDir)).length > 0) {
    const outcome = await runCommand(bookDir, bookImport, {}, { caller: "author", idempotencyKey: BOOK_START_KEYS.importOpen, ...snapshot });
    if (!outcome.ok && outcome.code !== "already_imported") return { ok: false, code: outcome.code, reason: outcome.message };
    if (outcome.ok) imported = outcome.result;
    ledgers = (await listChapterLedgers(bookDir)).length;
  }
  let cards: CardsImportResult | undefined;
  if (!(await readCards(bookDir))) {
    const outcome = await runCommand(bookDir, cardsImport, {}, { caller: "author", idempotencyKey: BOOK_START_KEYS.cardsImportOpen, ...snapshot });
    if (!outcome.ok && outcome.code !== "already_imported") return { ok: false, code: outcome.code, reason: outcome.message };
    if (outcome.ok) cards = outcome.result;
  }
  const retired = ledgers > 0 ? await retireMirror(bookDir) : [];
  return { ok: true as const, ...(imported ? { imported } : {}), ...(migrated ? { migrated } : {}), ...(cards ? { cards } : {}), ...(retired.length > 0 ? { retired } : {}) };
}

/**
 * 以前生成的镜像连标记挪进留证区（书锁里；书删了就不动，不在原处建出幽灵目录）。标记最后挪：中途进程没了，下次开书接着挪。
 * 留证区里已经有同名的（以前挪过一回、后来又生成了）就加时间戳另放，不盖掉。挪不动（权限、磁盘）的不挡开书：没人再读它们。
 */
async function retireMirror(bookDir: string): Promise<string[]> {
  return withBookLock(bookDir, async () => {
    if (!(await exists(join(bookDir, MIRROR_MARKER)))) return [];
    const moved: string[] = [];
    const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
    let stuck = false;
    for (const file of [...MIRROR_FILES, MIRROR_MARKER]) {
      // 有挪不动的就留着标记，下次开书再试。
      if (file === MIRROR_MARKER && stuck) break;
      const source = join(bookDir, file);
      if (!(await exists(source))) continue;
      const target = join(bookDir, RETIRED_DIR, file);
      const free = (await exists(target)) ? `${target}.${stamp}` : target;
      try {
        await mkdir(dirname(free), { recursive: true });
        await rename(source, free);
        moved.push(file);
      } catch {
        stuck = true;
      }
    }
    return moved;
  }).catch(() => []);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}
