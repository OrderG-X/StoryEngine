/**
 * 写命令的执行器：所有写操作都从这里过，命令自己不碰盘。
 *
 * 顺序固定：查权限 → 校参数 → 加书锁 → 收拾上次没写完的事务 → 有回执就回放（同键换参数就拒绝）→ 核依据 → plan →
 * 打快照 → 事务落盘（正文 / 账单 / 裁定 + 回执 + 版本号，版本号最后写；工作稿不动版本号）→ 推事件。
 * 任何一步不成都如实返回失败，书保持原样。
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BOOK_HEAD_SCHEMA, COMMAND_RECEIPT_SCHEMA, CommandReceipt } from "../schema/book.js";
import { canonicalJson, diffTruthBasis } from "../store/basis.js";
import { BookFileError, readHead, readTruthBasis } from "../store/book.js";
import { bookKey, withBookLock } from "../store/lock.js";
import { HEAD_PATH, receiptPath } from "../store/paths.js";
import { commitFiles, recoverTransactions, type RecoveryReport, type TxWrite } from "../store/transaction.js";
import type { BookEvent, CommandFailure, CommandOutcome, RunOptions, WriteCommandSpec } from "./types.js";

export function fail(code: string, message: string, details?: unknown): CommandFailure {
  return { ok: false, code, message, ...(details !== undefined ? { details } : {}) };
}

function isFailure(value: unknown): value is CommandFailure {
  return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false;
}

function keyHash(key: string): string {
  return createHash("sha256").update(key, "utf-8").digest("hex").slice(0, 32);
}

function argsHashOf(args: unknown): string {
  return createHash("sha256").update(canonicalJson(args), "utf-8").digest("hex");
}

async function readReceipt(bookDir: string, key: string): Promise<CommandReceipt | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(bookDir, receiptPath(keyHash(key))), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const parsed = CommandReceipt.safeParse(JSON.parse(raw));
  return parsed.success && parsed.data.key === key ? parsed.data : undefined;
}

export async function runCommand<A, R>(
  bookDir: string,
  spec: WriteCommandSpec<A, R>,
  rawArgs: unknown,
  options: RunOptions,
): Promise<CommandOutcome<R>> {
  if (spec.tier === "author" && options.caller !== "author") {
    return fail("author_only", "这一步只能由你在界面上点按钮来做，AI 不能替你做。");
  }
  const key = options.idempotencyKey?.trim();
  if (spec.idempotent && !key) return fail("missing_idempotency_key", "这一步缺少防重复的标记，没有执行。");
  const parsed = spec.args.safeParse(rawArgs);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return fail("invalid_args", `参数不对：${first?.path.join(".") || "整体"}：${first?.message ?? "格式不对"}`, parsed.error.issues);
  }

  return withBookLock(bookDir, async () => {
    let recovery: RecoveryReport;
    try {
      recovery = await recoverTransactions(bookDir);
    } catch (error) {
      return fail("book_unreadable", "这本书的目录读不了，没有执行。", error instanceof Error ? error.message : String(error));
    }
    if (recovery.problems.length > 0) {
      return fail("transaction_residue", "上次写到一半的记录读不了，先不动这本书，免得丢数据。作者确认后可以把它挪到一边留证，再继续写。", recovery);
    }
    const notice = recovery.rolledBack.length > 0 || recovery.keptOverLimit ? { recovered: recovery } : {};
    const argsHash = argsHashOf(options.intent !== undefined ? options.intent : parsed.data);
    if (key) {
      const receipt = await readReceipt(bookDir, key);
      if (receipt) {
        if (receipt.command !== spec.name) return fail("idempotency_key_reused", "防重复标记被别的操作用过了，没有执行。");
        if (receipt.argsHash !== undefined && receipt.argsHash !== argsHash) {
          return fail("idempotency_args_changed", "这一步已经按上一次的选择做过了，这次的选择没有执行。");
        }
        return { ok: true, result: receipt.result as R, version: receipt.version, changed: receipt.changed, replayed: true, ...notice };
      }
    }
    if (options.basis) {
      let changes;
      try {
        changes = diffTruthBasis(options.basis, await readTruthBasis(bookDir));
      } catch (error) {
        return fail("book_unreadable", "这本书的目录读不了，没有执行。", error instanceof Error ? error.message : String(error));
      }
      if (changes.length > 0) return fail("basis_changed", "预览之后书里有地方改过，这张预览作废了，请重新预览一次。", { changes });
    }

    const now = options.now?.() ?? new Date();
    let planned: Awaited<ReturnType<typeof spec.plan>>;
    try {
      planned = await spec.plan({ bookDir, caller: options.caller, now }, parsed.data);
    } catch (error) {
      if (error instanceof BookFileError) return fail("book_file_invalid", error.message);
      return fail("plan_failed", "这一步出了意外，书保持原样。", error instanceof Error ? error.message : String(error));
    }
    if (isFailure(planned)) return planned;
    const head = await readHead(bookDir);
    if (planned.writes.length === 0) {
      return { ok: true, result: planned.result, version: head.version, changed: {}, replayed: false, ...notice };
    }

    if (spec.snapshot && options.snapshot) {
      try {
        await options.snapshot(planned.label, spec.name);
      } catch (error) {
        return fail("snapshot_failed", "没能先存撤销点，这次没有写。", error instanceof Error ? error.message : String(error));
      }
    }

    const bumps = spec.bumpsVersion !== false;
    const version = bumps ? head.version + 1 : head.version;
    const at = now.toISOString();
    const writes: TxWrite[] = [...planned.writes];
    if (key) {
      const receipt: CommandReceipt = {
        schema: COMMAND_RECEIPT_SCHEMA,
        key,
        command: spec.name,
        version,
        at,
        changed: planned.changed,
        result: planned.result,
        argsHash,
      };
      writes.push({ path: receiptPath(keyHash(key)), content: `${JSON.stringify(receipt, null, 2)}\n` });
    }
    if (bumps) writes.push({ path: HEAD_PATH, content: `${JSON.stringify({ schema: BOOK_HEAD_SCHEMA, version, updatedAt: at }, null, 2)}\n` });
    try {
      await commitFiles(bookDir, writes);
    } catch (error) {
      return fail("write_failed", "写盘没成功，书保持原样。", error instanceof Error ? error.message : String(error));
    }

    const event: BookEvent = { book: bookKey(bookDir), version, command: spec.name, label: planned.label, changed: planned.changed, at };
    options.emit?.(event);
    return { ok: true, result: planned.result, version, changed: planned.changed, replayed: false, ...notice };
  });
}
