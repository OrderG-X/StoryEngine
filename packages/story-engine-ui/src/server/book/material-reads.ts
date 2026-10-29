/**
 * AI 写稿用过、却不在真相依据里的材料（写作版本 P1b 第 5 轮复核 S8/S9）：前一章的工作稿、已有各章章名、本章章纲。
 * 写稿时在哪儿用到就在哪儿记下用的是哪一版（同一样记第一次用的那版），换上前在书锁里按同样的读法逐条再读：
 * 有一样变了，AI 这版就是照旧材料写的，不换上、留成候选（basis_moved）。四样真相归真相依据管，这里不重复。
 */
import { canonicalJson, readDraftState, sha256 } from "@actalk/story-core";
import { readChapterPlan, type ChapterPlan } from "./chapter-plan.js";
import { readChapterTitles } from "./chapter-titles.js";

export type MaterialRead =
  /** 那一章的工作稿全文：版本号（没有稿也有号；老书没有稿是 null）。 */
  | { readonly kind: "draft"; readonly chapter: number; readonly version: string | null }
  /** 已有各章章名（不含 except 这章）：整份名单的指纹（改名、新添、删掉都算变）。 */
  | { readonly kind: "titles"; readonly except: number; readonly digest: string }
  /** 那一章的章纲：内容指纹（不算来历字段）；没有章纲是 null。 */
  | { readonly kind: "plan"; readonly chapter: number; readonly digest: string | null };

/** 一次 AI 写稿用过的材料（同一样只记第一次用的那版）。 */
export interface MaterialLog {
  readonly note: (read: MaterialRead) => void;
  readonly reads: () => readonly MaterialRead[];
}

const keyOf = (read: MaterialRead): string => (read.kind === "titles" ? `titles:${read.except}` : `${read.kind}:${read.chapter}`);

export function materialLog(): MaterialLog {
  const seen = new Map<string, MaterialRead>();
  return {
    note: (read) => {
      if (!seen.has(keyOf(read))) seen.set(keyOf(read), read);
    },
    reads: () => [...seen.values()],
  };
}

export function titlesDigest(titles: readonly { readonly chapter: number; readonly title: string }[]): string {
  return sha256(canonicalJson(titles));
}

/** 章纲写手看得到的内容（指纹、章纲依据、写入时间是来历，不算）。 */
export function planDigest(plan: ChapterPlan | undefined): string | null {
  return plan ? sha256(canonicalJson({ ...plan, basis: undefined, createdAt: undefined })) : null;
}

async function readNow(projectDir: string, read: MaterialRead): Promise<MaterialRead> {
  switch (read.kind) {
    case "draft":
      return { ...read, version: (await readDraftState(projectDir, read.chapter)).version };
    case "titles":
      return { ...read, digest: titlesDigest(await readChapterTitles(projectDir, read.except)) };
    case "plan": {
      let corrupt = false;
      const plan = await readChapterPlan(projectDir, read.chapter, () => { corrupt = true; });
      if (corrupt) throw new Error(`第 ${read.chapter} 章章纲读不出来`);
      return { ...read, digest: planDigest(plan) };
    }
  }
}

/** 记下的材料里第一样变了的（读不出来也算变了）；都没变 → undefined。调用方在书锁里调。 */
export async function firstMovedMaterial(projectDir: string, reads: readonly MaterialRead[]): Promise<MaterialRead | undefined> {
  for (const read of reads) {
    const now = await readNow(projectDir, read).catch(() => undefined);
    if (!now || canonicalJson(now) !== canonicalJson(read)) return read;
  }
  return undefined;
}
