/**
 * AI 写稿用到、却不在真相依据里的材料（写作版本 P1b 第 5 轮复核 S8/S9 起）。
 *
 * 不按「哪处读了哪样」逐处登记（第 6 轮复核 T5/T6：写手读前章章纲、在场检测读前章工作稿都在登记之外），
 * 也不按「哪几类文件算材料」列白名单（第 7 轮复核 U3：老格式镜像不在白名单里，照旧镜像写的稿照样换上）：
 * 开写时把书里**除下面这几样以外的所有文件**拍一份，换上前在书锁里按同样的读法再拍一份，有一样变了，
 * AI 这版就可能是照旧材料写的，不换上、留成候选（basis_moved）。不算材料的只有：
 *  - 真相（正文、账单、裁定、设定卡）和它的记账（`ledger/` 整个目录）：真相依据管；
 *  - 本章工作稿：底版号管；本章章纲：单独记它的内容指纹（拟纲就是这次出稿自己写的）；
 *  - 记录和缓存：`store-control/`（写入代次、工作稿代次）、`agents/`（专员笔记、候选、恢复稿）、`diagnostics/`，
 *    以及书目录顶层以点开头的（存档仓库、事务目录、界面的会话 / 统计 / 核账记忆）——镜像标记 `.story-core-mirror.json` 除外。
 *    缓存要当材料用的，各自按自己的键核（核账记忆按前文键，跟读笔记按正文哈希），不靠这里。
 * 别的章的工作稿记版本号（里面有代次，作者存一笔就换，撤销改回原样也认得出）；别的文件记全文哈希。
 * 本章章纲没有记成「用的是哪份」时，按开写时盘上那份（没有就是「没有章纲」）核：途中新建、重拟都算变了（第 7 轮 U5）。
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, chapterFromFileName, LEDGER_DIR, readDraftState, sha256 } from "@actalk/story-core";
import { chapterPlanPath, readChapterPlan, type ChapterPlan } from "./chapter-plan.js";
import { MIRROR_MARKER } from "./mirror/sync.js";

export type MaterialRead =
  /** 除 except 这章外，各章工作稿的版本号（章号 → 版本号；没有稿的章不在里面）。 */
  | { readonly kind: "drafts"; readonly except: number; readonly versions: Readonly<Record<string, string | null>> }
  /** 除 except 这章外，各章章纲文件全文的哈希（章号 → 哈希）。 */
  | { readonly kind: "plans"; readonly except: number; readonly files: Readonly<Record<string, string>> }
  /** 书里其余的文件（相对路径 → 全文哈希），见文件头。 */
  | { readonly kind: "files"; readonly except: number; readonly files: Readonly<Record<string, string>> }
  /** 本章照着写的那份章纲：内容指纹（不算来历字段）；没有章纲是 null。 */
  | { readonly kind: "plan"; readonly chapter: number; readonly digest: string | null };

/** 一次 AI 写稿用到的材料（同一样只记第一次的那份）。 */
export interface MaterialLog {
  readonly note: (read: MaterialRead) => void;
  /** 记下的材料；fallback 里有、却没记过的那样（开写时盘上的本章章纲）补在后面。 */
  readonly reads: () => readonly MaterialRead[];
}

const keyOf = (read: MaterialRead): string => (read.kind === "plan" ? `plan:${read.chapter}` : `${read.kind}:${read.except}`);

export function materialLog(fallback: readonly MaterialRead[] = []): MaterialLog {
  const seen = new Map<string, MaterialRead>();
  return {
    note: (read) => {
      if (!seen.has(keyOf(read))) seen.set(keyOf(read), read);
    },
    reads: () => [...seen.values(), ...fallback.filter((read) => !seen.has(keyOf(read)))],
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

async function listDir(dir: string): Promise<readonly import("node:fs").Dirent[]> {
  return readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
}

async function chaptersIn(dir: string, pattern: RegExp, except: number): Promise<readonly number[]> {
  return (await listDir(dir))
    .map((entry) => chapterOf(entry.name, pattern))
    .filter((chapter): chapter is number => chapter !== undefined && chapter !== except)
    .sort((a, b) => a - b);
}

/** 按原始字节算（不按 UTF-8 解码：坏字节、别的编码改了也认得出）。 */
const hashBytes = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const DRAFT_DIR = "drafts/fast";
const PLAN_DIR = "drafts/plans";
/** 顶层不算材料的目录（见文件头）。 */
const NOT_MATERIAL_DIRS = new Set([LEDGER_DIR, "store-control", "agents", "diagnostics"]);

/** 书里其余的文件：相对路径（用 / 分隔）→ 全文哈希。 */
async function otherFiles(projectDir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await listDir(relative ? join(projectDir, relative) : projectDir)) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (!relative && entry.name.startsWith(".") && entry.name !== MIRROR_MARKER) continue;
      if (!relative && NOT_MATERIAL_DIRS.has(entry.name)) continue;
      if (path === DRAFT_DIR || path === PLAN_DIR) continue;
      // 定稿正文是真相：依据管。chapters/ 里别的文件照样算。
      if (relative === "chapters" && entry.isFile() && entry.name.endsWith(".md") && chapterFromFileName(entry.name) !== undefined) continue;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) out[path] = hashBytes(await readFile(join(projectDir, path)));
      // 软链等别的东西：记成它的名字（变了、没了都认得出），不跟着读。
      else out[path] = `special:${entry.isSymbolicLink() ? "link" : "other"}`;
    }
  };
  await walk("");
  return out;
}

/** 开写时整本书的材料（除本章工作稿、本章章纲），外加开写时盘上的本章章纲（见 materialLog 的 fallback）。 */
export async function readMaterialWorld(projectDir: string, except: number): Promise<readonly MaterialRead[]> {
  const [drafts, plans, files] = await Promise.all([
    chaptersIn(join(projectDir, DRAFT_DIR), /^chapter-(\d{4})\.md$/u, except),
    chaptersIn(join(projectDir, PLAN_DIR), /^chapter-(\d{4})\.json$/u, except),
    otherFiles(projectDir),
  ]);
  const versions = await Promise.all(drafts.map(async (chapter) => [String(chapter), (await readDraftState(projectDir, chapter)).version] as const));
  const planFiles = await Promise.all(plans.map(async (chapter) => [String(chapter), sha256(await readFile(chapterPlanPath(projectDir, chapter), "utf-8"))] as const));
  return [
    { kind: "drafts", except, versions: Object.fromEntries(versions) },
    { kind: "plans", except, files: Object.fromEntries(planFiles) },
    { kind: "files", except, files },
  ];
}

/**
 * 盘上的本章章纲：内容指纹（没有就是 null）。出稿没记「照哪份写」时按开写时这份核。
 * 章纲文件坏了：记坏文件全文的哈希（一直坏着不算变，被重拟、修好都算变）。
 */
export async function readStartPlan(projectDir: string, chapter: number): Promise<MaterialRead> {
  let corrupt = false;
  const plan = await readChapterPlan(projectDir, chapter, () => { corrupt = true; });
  if (!corrupt) return { kind: "plan", chapter, digest: planDigest(plan) };
  return { kind: "plan", chapter, digest: `unreadable:${hashBytes(await readFile(chapterPlanPath(projectDir, chapter)))}` };
}

/** 变了的那一样：哪类材料、哪一章 / 哪个文件（读不出来就都没有）。 */
export interface MovedMaterial {
  readonly kind: MaterialRead["kind"];
  readonly chapter?: number;
  readonly path?: string;
}

function movedKey(before: Readonly<Record<string, unknown>>, now: Readonly<Record<string, unknown>>, byChapter = false): string | undefined {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(now)])];
  keys.sort(byChapter ? (a, b) => Number(a) - Number(b) : undefined);
  return keys.find((key) => before[key] !== now[key]);
}

function moved(read: MaterialRead, now: MaterialRead | undefined): MovedMaterial | undefined {
  if (now && canonicalJson(now) === canonicalJson(read)) return undefined;
  if (read.kind === "plan") return { kind: "plan", chapter: read.chapter };
  if (!now || now.kind !== read.kind) return { kind: read.kind };
  if (read.kind === "files") {
    const path = movedKey(read.files, (now as typeof read).files);
    return path === undefined ? { kind: "files" } : { kind: "files", path };
  }
  const key = read.kind === "drafts"
    ? movedKey(read.versions, (now as typeof read).versions, true)
    : movedKey(read.files, (now as typeof read).files, true);
  const chapter = key === undefined ? undefined : Number(key);
  return chapter === undefined ? { kind: read.kind } : { kind: read.kind, chapter };
}

/** 记下的材料里第一样变了的（读不出来也算变了）；都没变 → undefined。调用方在书锁里调。 */
export async function firstMovedMaterial(projectDir: string, reads: readonly MaterialRead[]): Promise<MovedMaterial | undefined> {
  const worlds = new Map<number, Promise<readonly MaterialRead[]>>();
  const readNow = async (read: MaterialRead): Promise<MaterialRead | undefined> => {
    if (read.kind === "plan") return readStartPlan(projectDir, read.chapter);
    if (!worlds.has(read.except)) worlds.set(read.except, readMaterialWorld(projectDir, read.except));
    return (await worlds.get(read.except)!).find((item) => item.kind === read.kind);
  };
  for (const read of reads) {
    const change = moved(read, await readNow(read).catch(() => undefined));
    if (change) return change;
  }
  return undefined;
}

