/**
 * 真相依据（写作版本 P1a，2026-10-29）：一份 AI 产物（定稿预览、定论预览、改账 / 改设定提议）是按书里哪一版真相算出来的。
 *
 * 记两样：
 *  - 写入代次（`store-control/revision.json` 原样的 sha256）：每次写真相、每次撤销 / 恢复都换新的，且不随撤销回退。
 *    依据记下之后书上发生过任何一次写（哪怕 A→B→撤销回 A，内容又一模一样），代次都对不上。
 *  - 四样真相每个文件的原样 sha256（正文、章节账单、作者裁定、设定卡），不做任何归一：用来如实说「哪里变了」，
 *    也给缓存按内容认前文（basisDigestBefore 不带代次）。
 * 代次先读、真相后读。作者点「确认」时，runner 在书锁里重读一遍、逐个比；有一样对不上，这张票作废、如实说哪里变了，
 * 不拿新真相去执行旧判断。所以产物要在读材料之前记依据：读材料的中途有写，代次已经换了，确认时照样作废。
 * 缓存（核账记忆、章纲）按内容复用，得在读完材料后再读一遍依据、前后一样才认（store/book 的 readWithStableBasis）。
 * 工作稿不算真相，不进依据（各票自己核目标稿的版本）。
 */
import { createHash } from "node:crypto";
import { z } from "zod";

export const TRUTH_BASIS_SCHEMA = "truth-basis/2" as const;

const Sha = z.string().regex(/^[0-9a-f]{64}$/u);

export const TruthBasis = z.object({
  schema: z.literal(TRUTH_BASIS_SCHEMA),
  /** 下面五样规范化后的 sha256：两份依据一样当且仅当它一样。 */
  digest: Sha,
  /** 写入代次文件原样的 sha256；不在（还没写过的书）= null。 */
  revision: Sha.nullable(),
  /** 章号 → 定稿正文原样的 sha256。 */
  texts: z.record(z.string(), Sha),
  /** 章号 → 章节账单原样的 sha256。 */
  ledgers: z.record(z.string(), Sha),
  /** 作者裁定文件原样的 sha256；不在 = null。 */
  decisions: Sha.nullable(),
  /** 设定卡文件原样的 sha256；不在 = null。 */
  cards: Sha.nullable(),
});
export type TruthBasis = z.infer<typeof TruthBasis>;

/** 依据里变了的一样（结构，给人看的话在最外层拼）。 */
export type BasisChange =
  | { readonly kind: "text" | "ledger"; readonly chapter: number; readonly change: "changed" | "added" | "removed" }
  | { readonly kind: "decisions" | "cards"; readonly change: "changed" | "added" | "removed" }
  /** 四样真相的字节都一样，但中间写过（撤销 / 恢复回到原样、写了一样的内容）。 */
  | { readonly kind: "revision" };

const sha = (text: string): string => createHash("sha256").update(text, "utf-8").digest("hex");

/** 键排好序的 JSON（同样的值永远同样的字符串）：算摘要、比参数用。 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

export interface TruthHashes {
  readonly revision: string | null;
  readonly texts: ReadonlyMap<number, string>;
  readonly ledgers: ReadonlyMap<number, string>;
  readonly decisions: string | null;
  readonly cards: string | null;
}

const record = (map: ReadonlyMap<number, string>): Record<string, string> =>
  Object.fromEntries([...map.entries()].sort(([a], [b]) => a - b).map(([chapter, hash]) => [String(chapter), hash]));

export function truthBasisOf(hashes: TruthHashes): TruthBasis {
  const parts = { revision: hashes.revision, texts: record(hashes.texts), ledgers: record(hashes.ledgers), decisions: hashes.decisions, cards: hashes.cards };
  return { schema: TRUTH_BASIS_SCHEMA, digest: sha(canonicalJson(parts)), ...parts };
}

/**
 * 依据里第 chapter 章「之前」那部分的摘要：前面各章的正文和账、作者裁定、设定卡。
 * 缓存按它认前文变没变（核账记忆、章纲）；laterLedgers 时连本章和后面各章的账也算（核账拿全书的账对数字）。
 * 只看内容、不带写入代次：撤销回原样，按原样核过的结果照样能用。
 */
export function basisDigestBefore(basis: TruthBasis, chapter: number, options: { readonly laterLedgers?: boolean } = {}): string {
  const before = (part: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(part).filter(([key]) => Number(key) < chapter));
  return sha(canonicalJson({
    texts: before(basis.texts),
    ledgers: options.laterLedgers ? basis.ledgers : before(basis.ledgers),
    decisions: basis.decisions,
    cards: basis.cards,
  }));
}

/** 原样文本的 sha256（不在 = null）。 */
export function rawHash(raw: string | undefined): string | null {
  return raw === undefined ? null : sha(raw);
}

function diffChapters(kind: "text" | "ledger", before: Record<string, string>, after: Record<string, string>): BasisChange[] {
  const chapters = new Set([...Object.keys(before), ...Object.keys(after)].map(Number));
  return [...chapters].sort((a, b) => a - b).flatMap((chapter): BasisChange[] => {
    const was = before[String(chapter)];
    const now = after[String(chapter)];
    if (was === now) return [];
    return [{ kind, chapter, change: was === undefined ? "added" : now === undefined ? "removed" : "changed" }];
  });
}

function diffOne(kind: "decisions" | "cards", was: string | null, now: string | null): BasisChange[] {
  if (was === now) return [];
  return [{ kind, change: was === null ? "added" : now === null ? "removed" : "changed" }];
}

/** 两份依据之间变了什么（一样 = 空）。 */
export function diffTruthBasis(before: TruthBasis, after: TruthBasis): readonly BasisChange[] {
  if (before.digest === after.digest) return [];
  const changes: BasisChange[] = [
    ...diffChapters("text", before.texts, after.texts),
    ...diffChapters("ledger", before.ledgers, after.ledgers),
    ...diffOne("decisions", before.decisions, after.decisions),
    ...diffOne("cards", before.cards, after.cards),
  ];
  return changes.length > 0 ? changes : [{ kind: "revision" }];
}
