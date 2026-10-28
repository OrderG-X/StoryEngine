/**
 * 命令表的格式。改书只有一条路：调命令。按钮和对话 AI 调的是同一张表。
 *
 * 每条命令写清：参数（zod）、谁能调（三档）、写前要不要打快照、要不要幂等键、做完改了什么。
 * 命令分两步：plan 只读、算出要写的文件和结果（不碰盘）；runner 负责权限、加锁、收拾残留事务、
 * 回放回执、打快照、事务落盘、版本号 +1、推事件。命令自己永远不直接写文件。
 */
import type { z } from "zod";
import type { ChangeSet } from "../schema/book.js";
import type { TxWrite } from "../store/transaction.js";
import type { RecoveryReport } from "../store/transaction.js";
import type { TruthBasis } from "../store/basis.js";

/**
 * author = 只能由作者按按钮触发（定稿、改账、裁定、删除、裁剪历史）；
 * ai-direct = AI 也能直接做，但必须能撤销（起草、改稿、补资料、记笔记）；
 * ai-propose = 只出提议、不写真相（预览、问题、章纲）——这一档不进写命令的 runner。
 */
export type CommandTier = "author" | "ai-direct" | "ai-propose";

/** 谁在调：author = 界面按钮（作者本人点的）；ai = 对话 AI 的工具调用。 */
export type Caller = "author" | "ai";

export interface CommandFailure {
  readonly ok: false;
  /** 给程序用的错误码。 */
  readonly code: string;
  /** 给作者看的一句话（已经是中文、不带 id）。 */
  readonly message: string;
  readonly details?: unknown;
}

export interface WritePlan<R> {
  /** 历史里显示的标签，比如「定稿：第 3 章」。 */
  readonly label: string;
  readonly writes: readonly TxWrite[];
  readonly changed: ChangeSet;
  readonly result: R;
}

export interface PlanContext {
  readonly bookDir: string;
  readonly caller: Caller;
  readonly now: Date;
}

export interface WriteCommandSpec<A, R> {
  readonly name: string;
  readonly tier: Exclude<CommandTier, "ai-propose">;
  /** 一句话说明（也是给对话 AI 的工具说明）。 */
  readonly summary: string;
  readonly args: z.ZodType<A>;
  /** 写前打快照（撤销靠它）。 */
  readonly snapshot: boolean;
  /** 必须带幂等键：同一个键只执行一次，再来回放回执。作者档的命令一律要。 */
  readonly idempotent: boolean;
  /**
   * 写完要不要把书的版本号 +1（默认要）。工作稿不算书的真相投影（投影只看定稿、账单、裁定），
   * 存稿不 +1：不然每次停笔都会让老格式镜像「过期」重生成，还会让没导入的老书被当成已导入。
   */
  readonly bumpsVersion?: boolean;
  plan(context: PlanContext, args: A): Promise<WritePlan<R> | CommandFailure>;
}

/** 书变了的通知。界面按 changed 原地更新，不刷新页面。 */
export interface BookEvent {
  readonly book: string;
  readonly version: number;
  readonly command: string;
  readonly label: string;
  readonly changed: ChangeSet;
  readonly at: string;
}

export interface CommandSuccess<R> {
  readonly ok: true;
  readonly result: R;
  readonly version: number;
  readonly changed: ChangeSet;
  /** 同一个幂等键以前做过，这次是回放回执，什么都没再写。 */
  readonly replayed: boolean;
  /** 开工前收拾了上次写断的事务（退回去了），或留证区攒太多了：如实带出来，界面要告诉作者。 */
  readonly recovered?: RecoveryReport;
}

export type CommandOutcome<R> = CommandSuccess<R> | CommandFailure;

export interface RunOptions {
  readonly caller: Caller;
  readonly idempotencyKey?: string;
  /** 写前打快照（git 快照在服务端，核心只管在对的时机调它）。第二个参数是命令名，服务端据此给操作历史分类。 */
  readonly snapshot?: (label: string, command: string) => Promise<void>;
  /** 写成功后推事件。 */
  readonly emit?: (event: BookEvent) => void;
  readonly now?: () => Date;
  /**
   * 这次写是照哪一版真相算出来的（预览、提议里存的）。给了就在书锁里核：书里有一样变了就不写，返回 basis_changed + 变了哪些。
   * 同一个幂等键的回执先回放（定稿自己就改了真相，点第二次不能因此报「变了」）。
   */
  readonly basis?: TruthBasis;
  /**
   * 作者这次的选择（缺省 = 参数本身）：回执记它的哈希，同一个幂等键换了选择再来就如实拒绝（idempotency_args_changed），
   * 不按上次的选择回放成「做好了」。参数里有照现状重算的（比如按现在的正文对出来的改句），就传不随现状变的那部分。
   */
  readonly intent?: unknown;
}

/** 命令表里装的任意一条写命令（表本身不关心每条的参数类型）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyWriteCommandSpec = WriteCommandSpec<any, any>;
