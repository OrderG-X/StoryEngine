/**
 * 账单 v1 → v2 的迁移器（写作版本 P2b 设计 2.2，契约第六节）：核心里唯一认识 `chapter-ledger/1` 的地方。纯函数，不读盘、不调模型。
 *
 * 规则：
 *  1. 条目编号、原句、review、origin、committedAt、textSha256 原样；裁定、设定卡、正文不碰。
 *  2. 原句定位：正文没变（哈希 = textSha256）时在正文里找——一处给句号（located），多处不任选（quoted），找不到 unlocated_legacy；
 *     定稿后正文改过 → stale（不拿新正文硬套）；正文不在了 → unlocated_legacy；没原句（老书导入）→ none。
 *  3. 时间：作者定的第几天 → at；离上一章几天 → offset（相对上一章结尾）；都没有 → unknown（星期、时段原样）；
 *     本章内过几天 → 另一条本章结尾相对本章开头，编号「原编号-end」；basis 原样（估的不升成准的）。
 *  4. 状态：导入的、没条目的 → pending（imported_text，等通读记账）；其余 → ready（legacy_protocol）。
 *  5. 来源一律 unknown（旧账没存来源，不默认当叙述）；provenance = migrated；legacy.sha256 = 原文件哈希。
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { ChapterLedger, FactNature, ReviewMark, ThreadOp, ThreadType, TimeBasis, type Evidence, type EvidenceStatus, type LedgerEntry } from "../schema/ledger.js";
import { chapterSource, evidenceFor, newLedger, storeLegacyTime, storeWithProof, type ChapterSource } from "./entries.js";

export const LEDGER_V1_SCHEMA = "chapter-ledger/1" as const;

const text = z.string().trim().min(1);
const id = text;
const quote = text.optional();

const V1Entry = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("summary"), id, review: ReviewMark, text, quote }),
  z.object({
    kind: z.literal("fact"),
    id,
    review: ReviewMark,
    nature: FactNature,
    subject: text.optional(),
    attribute: text.optional(),
    value: text.optional(),
    text,
    quote,
    replaces: z.array(id).min(1).optional(),
  }),
  z.object({ kind: z.literal("thread"), id, review: ReviewMark, op: ThreadOp, type: ThreadType.optional(), title: text.optional(), note: text, quote, thread: id }),
  z.object({
    kind: z.literal("time"),
    id,
    review: ReviewMark,
    basis: TimeBasis,
    quote,
    daysSincePrevious: z.number().int().min(0).max(3650).optional(),
    day: z.number().int().min(1).optional(),
    daysInChapter: z.number().int().min(0).max(3650).optional(),
    weekday: z.number().int().min(0).max(6).optional(),
    timeOfDay: text.optional(),
  }),
  z.object({ kind: z.literal("presence"), id, review: ReviewMark, name: text, nameUsed: text, viewpoint: z.boolean().optional(), generic: z.boolean().optional(), quote }),
]);
type V1Entry = z.infer<typeof V1Entry>;

const needsQuote = (entry: V1Entry): boolean => entry.kind !== "time" || entry.basis === "text" || entry.basis === "judged";

function shapeProblem(entry: V1Entry): string | undefined {
  if (entry.kind === "fact" && entry.nature !== "event" && (!entry.subject || !entry.attribute || !entry.value)) return "不会变的事实和状态必须写清谁、哪方面、是什么";
  if (entry.kind === "thread" && entry.op === "open" && (!entry.type || !entry.title)) return "新开的线索必须有类型和标题";
  if (entry.kind === "time" && entry.day !== undefined && entry.basis !== "author") return "只有作者能直接定故事第几天";
  return undefined;
}

/** v1 账单原来的校验（和当年运行期读它时一样严：当年读不了的，现在也不硬迁）。 */
const V1Ledger = z
  .object({
    schema: z.literal(LEDGER_V1_SCHEMA),
    chapter: z.number().int().min(1),
    textSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    committedAt: z.string().min(1),
    origin: z.enum(["commit", "import", "reread"]),
    entries: z.array(V1Entry),
  })
  .superRefine((ledger, ctx) => {
    const ids = new Set<string>();
    let summaries = 0;
    let times = 0;
    ledger.entries.forEach((entry, index) => {
      if (ids.has(entry.id)) ctx.addIssue({ code: "custom", path: ["entries", index, "id"], message: "条目编号重复" });
      ids.add(entry.id);
      if (entry.kind === "summary") summaries += 1;
      if (entry.kind === "time") times += 1;
      const problem = shapeProblem(entry);
      if (problem) ctx.addIssue({ code: "custom", path: ["entries", index], message: problem });
      if (ledger.origin !== "import" && needsQuote(entry) && !entry.quote) ctx.addIssue({ code: "custom", path: ["entries", index, "quote"], message: "定稿、通读记的条目必须附原句" });
    });
    if (summaries > 1) ctx.addIssue({ code: "custom", path: ["entries"], message: "一章只能有一条梗概" });
    if (times > 1) ctx.addIssue({ code: "custom", path: ["entries"], message: "一章只能有一条时间" });
  });

/** 原始字节是不是 v1 账单（只看格式标记，不校验）：迁移入口按它挑。 */
export function isLedgerV1(raw: string): boolean {
  try {
    const value = JSON.parse(raw) as { readonly schema?: unknown } | null;
    return typeof value === "object" && value !== null && value.schema === LEDGER_V1_SCHEMA;
  } catch {
    return false;
  }
}

export type UpgradeResult =
  | { readonly ok: true; readonly ledger: ChapterLedger; readonly evidence: Readonly<Record<EvidenceStatus, number>> }
  | { readonly ok: false; readonly reason: string };

const sha256 = (value: string): string => createHash("sha256").update(value, "utf-8").digest("hex");

/**
 * 一份 v1 账单（原始字节）→ v2。`chapterText` = 和它配对的正文（同一份存档 / 现在书里那一章）；不在就给 undefined。
 */
export function upgradeLedgerV1(raw: string, chapterText: string | undefined): UpgradeResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "文件坏了（不是合法的 JSON）" };
  }
  const parsed = V1Ledger.safeParse(value);
  if (!parsed.success) {
    return { ok: false, reason: plainReason(parsed.error.issues[0]) };
  }
  const v1 = parsed.data;
  // 原句只在定稿那一版正文上找：正文后来改过、不在了，就不拿别的版本硬套。
  const same = chapterText !== undefined && sha256(chapterText) === v1.textSha256;
  const source: ChapterSource | undefined = same ? chapterSource(v1.chapter, chapterText) : undefined;
  const fallback: EvidenceStatus = chapterText !== undefined && !same ? "stale" : "unlocated_legacy";
  const tally: Record<EvidenceStatus, number> = { located: 0, quoted: 0, unlocated_legacy: 0, stale: 0, none: 0 };
  const entries: LedgerEntry[] = [];
  for (const entry of v1.entries) {
    const { id: entryId, ...declared } = entry;
    const proof = proofOf(entry.quote, v1.chapter, v1.textSha256, source, fallback);
    tally[proof.evidenceStatus] += 1;
    const thread = entry.kind === "thread" && entry.op === "open" ? entry.thread : undefined;
    entries.push(...(declared.kind === "time"
      ? storeLegacyTime(declared, entryId, proof, "migrated")
      : storeWithProof(declared, { id: entryId, ...(thread ? { thread } : {}) }, proof, "migrated")));
  }
  const empty = v1.origin === "import" && entries.length === 0;
  const built = newLedger({
    chapter: v1.chapter,
    textSha256: v1.textSha256,
    committedAt: v1.committedAt,
    origin: v1.origin,
    entries,
    status: empty ? "pending" : "ready",
    coverage: { reasonCodes: [empty ? "imported_text" : "legacy_protocol"] },
    legacy: { schema: LEDGER_V1_SCHEMA, sha256: sha256(raw) },
    ...(empty ? {} : { legacyTime: true as const }),
  });
  if (!built.success) {
    return { ok: false, reason: `升级后不成立：${plainReason(built.error.issues[0])}` };
  }
  return { ok: true, ledger: built.data, evidence: tally };
}

/** 给作者看的一句：只说哪条自家规矩不成立（不带字段路径、编号）；zod 自带的英文报错一律说「格式不对」。 */
function plainReason(issue: z.core.$ZodIssue | undefined): string {
  return issue?.code === "custom" ? issue.message : "格式不对";
}

function proofOf(
  quote: string | undefined,
  chapter: number,
  revision: string,
  source: ChapterSource | undefined,
  fallback: EvidenceStatus,
): { readonly evidence: Evidence[]; readonly evidenceStatus: EvidenceStatus } {
  if (quote === undefined) return { evidence: [], evidenceStatus: "none" };
  const found = source ? evidenceFor(quote, source) : undefined;
  if (found) return found;
  return { evidence: [{ resource: { kind: "chapter", chapter }, revision, quote }], evidenceStatus: fallback };
}
