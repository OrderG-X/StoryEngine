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
  /** 章纲变了的章（写作版本 P2a）。 */
  plans: z.array(z.number().int().min(1)).optional(),
});
export type ChangeSet = z.infer<typeof ChangeSet>;

export const CommandReceipt = z.object({
  schema: z.literal(COMMAND_RECEIPT_SCHEMA),
  key: z.string().min(1),
  command: z.string().min(1),
  /** 写完时书的版本号。不动版本号的命令（存稿、章纲）在还没定稿过的书上是 0。 */
  version: z.number().int().min(0),
  at: z.string().min(1),
  changed: ChangeSet,
  result: z.unknown(),
  /** 当时的参数（键排好序）的 sha256：同一个键换了参数再来，不回放、如实拒绝（写作版本 P1a；老回执没有这栏）。 */
  argsHash: z.string().optional(),
  /** 哪次操作的哪一步写的（写作版本 P2a；不是操作写的没有）。 */
  opId: z.string().min(1).optional(),
  stepId: z.string().min(1).optional(),
  /**
   * 撤销范围里（paths.ts 的 isUndoablePath）这次写的每个文件换之前、换之后的 sha256（null = 不存在）。
   * 写作版本 P2a 起的回执才有；没有 = 升级之前的写，撤销不了，只能整本恢复。
   */
  effects: z.array(z.object({ path: z.string().min(1), before: z.string().nullable(), after: z.string().nullable() })).optional(),
  /** 写之前那份存档的树号（撤销时从这里取前像；树经提交链重写、裁剪后仍可读）。没打存档的没有。 */
  snapshotTree: z.string().min(1).optional(),
});
export type CommandReceipt = z.infer<typeof CommandReceipt>;
