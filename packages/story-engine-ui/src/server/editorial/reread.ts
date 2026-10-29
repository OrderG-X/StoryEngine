/**
 * 通读记账的一章（P8 导入连载，设计见 docs/rebuild/P8-serial-import-design.md；写作版本 P2a 片 3D 起整轮通读是执行器的
 * background.reread 操作，配方在 services/operations/recipes/background-reread.ts，这里只剩记一章要算的那部分，不写书）。
 *
 * 读真相 → 投影（算到上一章）→ 记账员交账单（前文笔记必须补齐，不走冷窗口）→ 核原句、分流
 * → 去掉「会改前文不会变的事实」那几条（定稿时这种默认不写、要作者勾，通读没人勾，就不写）。
 * 一章最多试 REREAD_ATTEMPTS 次（模型偶尔交坏 JSON、连接断一下都很正常）；调用被拒这类再发也一样的不再试；
 * 结果不明、额度到了的由执行器停下（paused，等作者点「接着记」）。
 * 记账员读的是哪一版书记成指纹（rereadInputDigest：这章正文和账 + 前面各章的正文和账 + 作者裁定 + 设定卡）：
 * 落账前重算一遍，对不上就是途中书变了（作者改了设定、撤销……），这章照新的样子重读重记（不然旧正文的梗概会挂到新正文上）。
 */
import {
  basisDigestBefore,
  canonicalJson,
  checkEntries,
  classifyForReview,
  project,
  readBookSnapshot,
  readChapterText,
  sha256,
  type ChapterLedger,
  type LedgerRereadArgs,
  type TruthBasis,
} from "@actalk/story-core";
import { touchesHardFact } from "./commit-flow.js";
import { runLedgerKeeper } from "./ledger-keeper.js";
import { canCallAgain } from "../lib/llm-client.js";
import { rethrowIfStopped } from "../lib/operations/context.js";
import type { BrainCallModel } from "./reader-window.js";

/** 一章最多试几次。 */
export const REREAD_ATTEMPTS = 3;
/** 记的途中书变了、照新的重记：一章最多重来几回（作者一直在改就停下，等「接着记」）。 */
export const BASIS_RETRIES = 5;

export type RereadChapterOutcome =
  /** 记账员交的账单（核过原句、去掉了默认不写的）；skipped = 没记上的条数；digest = 记账员读的那一版书的指纹。 */
  | { readonly kind: "entries"; readonly entries: LedgerRereadArgs["entries"]; readonly skipped: number; readonly digest: string }
  /** 这章的账单已经不是导入时那份空账单了（作者定稿过、记过了）：不记。 */
  | { readonly kind: "settled" }
  /** 读的时候书正在写、这章正文和快照对不上：照新的样子重来。 */
  | { readonly kind: "changed" };

/** 这章的账单还是导入已写的书时那份空账单（要通读记）。老格式书导入的账 origin 也是 import，但带着老账，不算。 */
export const awaitsReread = (ledger: Pick<ChapterLedger, "origin" | "entries">): boolean => ledger.origin === "import" && ledger.entries.length === 0;

/** 记这一章读到的那一版书的指纹（只看内容，不看写入代次：撤销回原样照样认）。 */
export function rereadInputDigest(basis: TruthBasis, chapter: number): string {
  return sha256(canonicalJson({
    before: basisDigestBefore(basis, chapter),
    text: basis.texts[String(chapter)] ?? null,
    ledger: basis.ledgers[String(chapter)] ?? null,
  }));
}

function oneLine(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).trim().split(/\s+/u).join(" ");
  return text.length > 120 ? `${text.slice(0, 120)}…` : text || "未知错误";
}

/** 这章试满还不成（或这章没法记）：message 是给作者看的一句原因。 */
export function rereadFailure(message: string): Error {
  return Object.assign(new Error(message), { code: "reread_failed" });
}

export async function rereadChapter(projectDir: string, chapter: number, callModel: BrainCallModel): Promise<RereadChapterOutcome> {
  // 先读快照（带依据）再读正文；正文和快照里记的对不上 = 两次读之间有写，照新的重来。
  const snapshot = await readBookSnapshot(projectDir);
  if (snapshot.unsettled) return { kind: "changed" };
  const ledger = snapshot.ledgers.find((item) => item.chapter === chapter);
  if (!ledger) throw rereadFailure(`第 ${chapter} 章的账单不见了`);
  if (!awaitsReread(ledger)) return { kind: "settled" };
  const text = await readChapterText(projectDir, chapter);
  if (text === undefined) throw rereadFailure(`第 ${chapter} 章的正文不见了`);
  if (snapshot.basis.texts[String(chapter)] !== sha256(text)) return { kind: "changed" };
  const before = project(snapshot, { upTo: chapter - 1 });
  let reason = "没记上";
  for (let attempt = 1; attempt <= REREAD_ATTEMPTS; attempt += 1) {
    let cause: unknown;
    try {
      const keeper = await runLedgerKeeper({ projectDir, chapter, draft: text, before, callModel, maxCatchUp: Number.MAX_SAFE_INTEGER });
      if (keeper.ok) {
        const checked = checkEntries(keeper.parsed.entries, text, before);
        const plan = classifyForReview(checked.accepted, before, { chapter });
        const optIn = new Set(plan.review.filter((item) => touchesHardFact(item, before)).map((item) => item.index));
        return {
          kind: "entries",
          entries: checked.accepted.filter((item) => !optIn.has(item.index)).map((item) => item.entry),
          skipped: checked.rejected.length + optIn.size + keeper.parsed.drops.length,
          digest: rereadInputDigest(snapshot.basis, chapter),
        };
      }
      reason = keeper.reason;
      cause = keeper.cause;
    } catch (error) {
      rethrowIfStopped(error);
      reason = oneLine(error);
      cause = error;
    }
    // 被拒这类再发也一样（写作版本 P2a 4.2）：这章不再试。
    if (cause !== undefined && !canCallAgain(cause)) break;
  }
  throw rereadFailure(reason);
}
