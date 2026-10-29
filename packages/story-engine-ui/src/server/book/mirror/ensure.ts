/**
 * 打开书时把书接到新核心上（重构 P3 第 7 步）：
 *
 *   - 有定稿正文、却还没有账单（老书）→ 先存撤销点，再「导入老书」：老账按章归成导入账单，老文件一个字节都不碰；
 *   - 还没有设定卡 `ledger/cards.json`（重构 P9 以前的书）→ 先存撤销点，再「搬老设定」：老设定文件拼成设定卡，
 *     老文件不碰；什么老设定都没有就建一份空的；
 *   - 账单有了、老格式镜像过期（或从没生成过）→ 重生成镜像（第一次生成前老文件原样留一份，见 sync.ts）。
 *
 * 新书建书时就写好了设定卡，还没有定稿章不用导入账单：第一次定稿就会建出账单。这一步每次开书都会调，
 * 已经接好的书只列一次目录、读三个小文件。
 *
 * 最前面先收老版本中途崩溃留下的老定稿链事务残留（`.story-engine-tx/`，没有就是一次 lstat）：
 * 读路径都不再收它（重构 P7），开书是唯一入口。
 */
import { bookImport, cardsImport, listChapterLedgers, LegacyResidueError, listChapterTexts, readCards, recoverBookTransactions, runCommand, type BookImportResult, type CardsImportResult } from "@actalk/story-core";
import { mirrorIsStale, syncLegacyMirror, type MirrorSyncResult } from "./sync.js";

export type EnsureOnCoreResult =
  | {
      readonly ok: true;
      /** 这次导入了老书（导入了几章）。 */
      readonly imported?: BookImportResult;
      /** 这次把老设定搬进了设定卡。 */
      readonly cards?: CardsImportResult;
      /** 这次重生成了镜像。 */
      readonly mirror?: Extract<MirrorSyncResult, { ok: true }>;
    }
  | { readonly ok: false; readonly code: string; readonly reason: string };

export interface EnsureOnCoreOptions {
  /** 导入前存撤销点（失败就不导入）。第二个参数是命令名。 */
  readonly snapshot?: (label: string, command: string) => Promise<void>;
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
    // 老格式、新核心写到一半的事务都先收拾（下面先读盘看有没有账单）。核心自己收拾不了的，下面的命令照「残留」如实失败。
    await recoverBookTransactions(bookDir);
  } catch (error) {
    return { ok: false, code: error instanceof LegacyResidueError ? "legacy_tx_residue" : "book_unreadable", reason: error instanceof Error ? error.message : String(error) };
  }
  const snapshot = options.snapshot ? { snapshot: options.snapshot } : {};
  // 先导账单再搬设定：看「有没有账单」而不是书的版本号（搬设定、改设定也会让版本号往上走）。
  let ledgers = (await listChapterLedgers(bookDir)).length;
  let imported: BookImportResult | undefined;
  if (ledgers === 0 && (await listChapterTexts(bookDir)).length > 0) {
    const outcome = await runCommand(bookDir, bookImport, {}, { caller: "author", idempotencyKey: "book-import:open", ...snapshot });
    if (!outcome.ok && outcome.code !== "already_imported") return { ok: false, code: outcome.code, reason: outcome.message };
    if (outcome.ok) imported = outcome.result;
    ledgers = (await listChapterLedgers(bookDir)).length;
  }
  let cards: CardsImportResult | undefined;
  if (!(await readCards(bookDir))) {
    const outcome = await runCommand(bookDir, cardsImport, {}, { caller: "author", idempotencyKey: "cards-import:open", ...snapshot });
    if (!outcome.ok && outcome.code !== "already_imported") return { ok: false, code: outcome.code, reason: outcome.message };
    if (outcome.ok) cards = outcome.result;
  }
  const done = { ok: true as const, ...(imported ? { imported } : {}), ...(cards ? { cards } : {}) };
  // 还没有账单（新书没定稿过）不生成镜像：镜像全是从账单算的。
  if (ledgers === 0 || !(await mirrorIsStale(bookDir))) return done;
  const mirror = await syncLegacyMirror(bookDir);
  if (!mirror.ok) return { ok: false, code: mirror.code, reason: mirror.reason };
  return { ...done, mirror };
}
