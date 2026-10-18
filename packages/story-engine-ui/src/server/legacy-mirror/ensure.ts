/**
 * 打开书时把书接到新核心上（重构 P3 第 7 步）：
 *
 *   - 有定稿正文、却还没有账单（老书）→ 先存撤销点，再「导入老书」：老账按章归成导入账单，老文件一个字节都不碰；
 *   - 账单有了、老格式镜像过期（或从没生成过）→ 重生成镜像（第一次生成前老文件原样留一份，见 sync.ts）。
 *
 * 新书（还没有定稿章）什么都不做：第一次定稿就会建出账单。这一步每次开书都会调，已经接好的书只读两个小文件。
 *
 * 最前面先收老版本中途崩溃留下的老定稿链事务残留（`.story-engine-tx/`，没有就是一次 lstat）：
 * 读路径都不再收它（重构 P7），开书是唯一入口。
 */
import { recoverProjectCommitTransactions } from "../book/legacy-commit-recovery.js";
import { bookImport, listChapterTexts, readHead, runCommand, type BookImportResult } from "@actalk/story-core";
import { mirrorIsStale, syncLegacyMirror, type MirrorSyncResult } from "./sync.js";

export type EnsureOnCoreResult =
  | {
      readonly ok: true;
      /** 这次导入了老书（导入了几章）。 */
      readonly imported?: BookImportResult;
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
    await recoverProjectCommitTransactions(bookDir);
  } catch (error) {
    return { ok: false, code: "legacy_tx_residue", reason: error instanceof Error ? error.message : String(error) };
  }
  let imported: BookImportResult | undefined;
  if ((await readHead(bookDir)).version === 0) {
    if ((await listChapterTexts(bookDir)).length === 0) return { ok: true };
    const outcome = await runCommand(bookDir, bookImport, {}, {
      caller: "author",
      idempotencyKey: "book-import:open",
      ...(options.snapshot ? { snapshot: options.snapshot } : {}),
    });
    if (!outcome.ok && outcome.code !== "already_imported") return { ok: false, code: outcome.code, reason: outcome.message };
    if (outcome.ok) imported = outcome.result;
  }
  if (!(await mirrorIsStale(bookDir))) return { ok: true, ...(imported ? { imported } : {}) };
  const mirror = await syncLegacyMirror(bookDir);
  if (!mirror.ok) return { ok: false, code: mirror.code, reason: mirror.reason };
  return { ok: true, ...(imported ? { imported } : {}), mirror };
}
