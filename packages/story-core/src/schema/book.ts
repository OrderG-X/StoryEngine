/**
 * 书的版本号和命令回执。
 *
 * - 版本号（`ledger/head.json`）：每条写命令成功后 +1，和写入的文件同一个事务落盘。
 *   界面拿它判断手上的投影旧没旧；事件里也带它。
 * - 回执（`ledger/receipts/<键>.json`）：带幂等键的命令做完存一份，同一个键再来直接回放，不再执行（防点两次）。
 */
import { z } from "zod";

export const BOOK_HEAD_SCHEMA = "book-head/1" as const;
export const COMMAND_RECEIPT_SCHEMA = "command-receipt/1" as const;

export const BookHead = z.object({
  schema: z.literal(BOOK_HEAD_SCHEMA),
  version: z.number().int().min(0),
  updatedAt: z.string().min(1),
});
export type BookHead = z.infer<typeof BookHead>;

/** 改了哪些东西：界面按它只刷新受影响的部分。 */
export const ChangeSet = z.object({
  /** 正文变了的章。 */
  chapters: z.array(z.number().int().min(1)).optional(),
  /** 账单变了的章。 */
  ledgers: z.array(z.number().int().min(1)).optional(),
  /** 作者裁定变了。 */
  decisions: z.boolean().optional(),
  /** 设定卡变了。 */
  cards: z.boolean().optional(),
  /** 工作稿变了的章。 */
  drafts: z.array(z.number().int().min(1)).optional(),
});
export type ChangeSet = z.infer<typeof ChangeSet>;

export const CommandReceipt = z.object({
  schema: z.literal(COMMAND_RECEIPT_SCHEMA),
  key: z.string().min(1),
  command: z.string().min(1),
  version: z.number().int().min(1),
  at: z.string().min(1),
  changed: ChangeSet,
  result: z.unknown(),
  /** 当时的参数（键排好序）的 sha256：同一个键换了参数再来，不回放、如实拒绝（写作版本 P1a；老回执没有这栏）。 */
  argsHash: z.string().optional(),
});
export type CommandReceipt = z.infer<typeof CommandReceipt>;
