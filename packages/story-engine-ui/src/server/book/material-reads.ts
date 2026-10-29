/**
 * AI 写稿用到、却不在真相依据里的材料：别的章的工作稿、各章章纲（写作版本 P1b 第 5 轮复核 S8/S9）。
 *
 * 不按「哪处读了哪样」逐处登记（第 6 轮复核 T5/T6：写手读前章章纲、在场检测读前章工作稿都在登记之外）：
 * 开写时先把整本书这两样拍一份（除本章工作稿——它由底版号管），本章照哪份章纲写再记一笔；换上前在书锁里按同样的读法再拍一份，
 * 有一样变了，AI 这版就可能是照旧材料写的，不换上、留成候选（basis_moved）。
 * 别的章的工作稿版本号里有代次（作者存一笔就换），撤销改回原样也认得出；章纲文件带写入时间，重拟一次全文就变。
 * 章纲在书锁里写（book/chapter-plan），核完到换上之间换不了。
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, readDraftState, sha256 } from "@actalk/story-core";
import { chapterPlanPath, readChapterPlan, type ChapterPlan } from "./chapter-plan.js";

export type MaterialRead =
  /** 除 except 这章外，各章工作稿的版本号（章号 → 版本号；没有稿的章不在里面）。 */
  | { readonly kind: "drafts"; readonly except: number; readonly versions: Readonly<Record<string, string | null>> }
  /** 除 except 这章外，各章章纲文件全文的哈希（章号 → 哈希）。 */
  | { readonly kind: "plans"; readonly except: number; readonly files: Readonly<Record<string, string>> }
  /** 本章照着写的那份章纲：内容指纹（不算来历字段）；没有章纲是 null。 */
  | { readonly kind: "plan"; readonly chapter: number; readonly digest: string | null };

/** 一次 AI 写稿用到的材料（同一样只记第一次的那份）。 */
export interface MaterialLog {
  readonly note: (read: MaterialRead) => void;
  readonly reads: () => readonly MaterialRead[];
}

const keyOf = (read: MaterialRead): string => (read.kind === "plan" ? `plan:${read.chapter}` : `${read.kind}:${read.except}`);

export function materialLog(): MaterialLog {
  const seen = new Map<string, MaterialRead>();
  return {
    note: (read) => {
      if (!seen.has(keyOf(read))) seen.set(keyOf(read), read);
    },
    reads: () => [...seen.values()],
  };
}

/** 章纲写手看得到的内容（指纹、章纲依据、写入时间是来历，不算）。 */
export function planDigest(plan: ChapterPlan | undefined): string | null {
  return plan ? sha256(canonicalJson({ ...plan, basis: undefined, createdAt: undefined })) : null;
}

const chapterOf = (file: string, pattern: RegExp): number | undefined => {
  const chapter = Number(pattern.exec(file)?.[1]);
  return Number.isInteger(chapter) && chapter > 0 ? chapter : undefined;
};

async function chaptersIn(dir: string, pattern: RegExp, except: number): Promise<readonly number[]> {
  const files = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[];
    throw error;
  });
  return files
    .map((file) => chapterOf(file, pattern))
    .filter((chapter): chapter is number => chapter !== undefined && chapter !== except)
    .sort((a, b) => a - b);
}

/** 开写时整本书的工作稿和章纲（除本章工作稿）。 */
export async function readMaterialWorld(projectDir: string, except: number): Promise<readonly MaterialRead[]> {
  const [drafts, plans] = await Promise.all([
    chaptersIn(join(projectDir, "drafts", "fast"), /^chapter-(\d{4})\.md$/u, except),
    chaptersIn(join(projectDir, "drafts", "plans"), /^chapter-(\d{4})\.json$/u, except),
  ]);
  const versions = await Promise.all(drafts.map(async (chapter) => [String(chapter), (await readDraftState(projectDir, chapter)).version] as const));
  const files = await Promise.all(plans.map(async (chapter) => [String(chapter), sha256(await readFile(chapterPlanPath(projectDir, chapter), "utf-8"))] as const));
  return [
    { kind: "drafts", except, versions: Object.fromEntries(versions) },
    { kind: "plans", except, files: Object.fromEntries(files) },
  ];
}

/** 变了的那一样：哪类材料、哪一章（读不出来就没有章号）。 */
export interface MovedMaterial {
  readonly kind: MaterialRead["kind"];
  readonly chapter?: number;
}

function movedChapter(before: Readonly<Record<string, unknown>>, now: Readonly<Record<string, unknown>>): number | undefined {
  const chapters = [...new Set([...Object.keys(before), ...Object.keys(now)])].map(Number).sort((a, b) => a - b);
  return chapters.find((chapter) => before[String(chapter)] !== now[String(chapter)]);
}

function moved(read: MaterialRead, now: MaterialRead | undefined): MovedMaterial | undefined {
  if (now && canonicalJson(now) === canonicalJson(read)) return undefined;
  if (read.kind === "plan") return { kind: "plan", chapter: read.chapter };
  if (!now || now.kind !== read.kind) return { kind: read.kind };
  const chapter = read.kind === "drafts"
    ? movedChapter(read.versions, (now as typeof read).versions)
    : movedChapter(read.files, (now as typeof read).files);
  return chapter === undefined ? { kind: read.kind } : { kind: read.kind, chapter };
}

/** 记下的材料里第一样变了的（读不出来也算变了）；都没变 → undefined。调用方在书锁里调。 */
export async function firstMovedMaterial(projectDir: string, reads: readonly MaterialRead[]): Promise<MovedMaterial | undefined> {
  const worlds = new Map<number, Promise<readonly MaterialRead[]>>();
  const readNow = async (read: MaterialRead): Promise<MaterialRead | undefined> => {
    if (read.kind === "plan") {
      let corrupt = false;
      const plan = await readChapterPlan(projectDir, read.chapter, () => { corrupt = true; });
      if (corrupt) throw new Error(`第 ${read.chapter} 章章纲读不出来`);
      return { ...read, digest: planDigest(plan) };
    }
    if (!worlds.has(read.except)) worlds.set(read.except, readMaterialWorld(projectDir, read.except));
    return (await worlds.get(read.except)!).find((item) => item.kind === read.kind);
  };
  for (const read of reads) {
    const change = moved(read, await readNow(read).catch(() => undefined));
    if (change) return change;
  }
  return undefined;
}
