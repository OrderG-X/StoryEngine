/**
 * 把镜像写到书目录：读真相 → 投影 → 生成老文件 → 逐个原子写入 → 最后写「镜像对应的书版本号」。
 *
 * - 每条写命令之后调一次；打开书时发现版本号对不上（镜像过期）也调一次；取依据时落后了也调（book/truth-basis.ts）。
 * - **整个在书锁里**（写作版本 P1 第 8 轮复核）：写真相的命令都在书锁里，锁里读到的真相是一整版、同步途中不会再变；
 *   书删了（挪进回收站也在书锁里）就停，不在原处建出幽灵目录。在书锁里调也行（可重入）。
 * - 内容没变的文件不重写（不白白改动修改时间、不给撤销快照添噪音）。
 * - 第一次生成之前，把书里原来的老文件原样留一份到 `.story-core-kept/legacy-before-mirror/`。
 */
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { KEPT_TX_DIR, parseDraftFile, project, readBookSnapshot, readChapterText, readHead, withBookLock, type BookSnapshot } from "@actalk/story-core";
import { buildLegacyMirror, MIRROR_FILES, serializeLegacyMirror } from "./build.js";

export const MIRROR_MARKER = ".story-core-mirror.json";
// 2：出场人物改成名字（重构 P9）；标记换代，老书打开时镜像按过期重生成一遍。
export const MIRROR_MARKER_SCHEMA = "legacy-mirror/2" as const;
export const MIRROR_BACKUP_DIR = `${KEPT_TX_DIR}/legacy-before-mirror`;

export type MirrorSyncResult =
  | {
      readonly ok: true;
      readonly version: number;
      readonly written: readonly string[];
      readonly backedUp: readonly string[];
    }
  | { readonly ok: false; readonly code: "not_imported" | "unsettled" | "gone" | "failed"; readonly reason: string };

/** 镜像对应的书版本号；还没生成过（或标记坏了）就是 undefined。 */
export async function readMirrorVersion(bookDir: string): Promise<number | undefined> {
  try {
    const marker = JSON.parse(await readFile(join(bookDir, MIRROR_MARKER), "utf-8")) as { schema?: unknown; version?: unknown };
    return marker.schema === MIRROR_MARKER_SCHEMA && typeof marker.version === "number" ? marker.version : undefined;
  } catch {
    return undefined;
  }
}

/** 镜像过期了没有：书在新核心上（版本号 ≥ 1），镜像的版本号和书的对不上。 */
export async function mirrorIsStale(bookDir: string): Promise<boolean> {
  const head = await readHead(bookDir);
  return head.version > 0 && (await readMirrorVersion(bookDir)) !== head.version;
}

export async function syncLegacyMirror(bookDir: string): Promise<MirrorSyncResult> {
  return withBookLock(bookDir, () => syncNow(bookDir));
}

async function syncNow(bookDir: string): Promise<MirrorSyncResult> {
  try {
    if (!(await stat(bookDir).then((info) => info.isDirectory(), () => false))) {
      return { ok: false, code: "gone", reason: "这本书已经不在原处了（删了或挪走了），镜像不再生成" };
    }
    const snapshot = await readBookSnapshot(bookDir);
    // 有定稿章却没有账单 = 老书还没导入：这时生成镜像会拿空账盖掉老账。看账单本身，不看版本号（改设定也会涨版本号）。
    if (snapshot.version === 0 || (snapshot.ledgers.length === 0 && snapshot.textHashes.size > 0)) {
      return { ok: false, code: "not_imported", reason: "这本书的账还没搬到新核心，先导入再生成镜像" };
    }
    // 书锁里还有没收尾的事务 = 上次写到一半进程没了：等下一条写命令先收拾。
    if (snapshot.unsettled) return { ok: false, code: "unsettled", reason: "上次写到一半还没收拾，下次写的时候会先收拾再同步" };
    const backedUp = (await readMirrorVersion(bookDir)) === undefined ? await backupOriginals(bookDir) : [];
    const written = await writeMirror(bookDir, snapshot);
    await writeIfChanged(bookDir, MIRROR_MARKER, `${JSON.stringify({ schema: MIRROR_MARKER_SCHEMA, version: snapshot.version }, null, 2)}\n`);
    return { ok: true, version: snapshot.version, written, backedUp };
  } catch (error) {
    return { ok: false, code: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

async function writeMirror(bookDir: string, snapshot: BookSnapshot): Promise<string[]> {
  const projection = project(snapshot);
  const chapterTitles = await readChapterTitles(bookDir, projection.chapters.map((chapter) => chapter.chapter));
  const mirror = buildLegacyMirror({ projection, ledgers: snapshot.ledgers, chapterTitles });
  const written: string[] = [];
  for (const [file, content] of serializeLegacyMirror(mirror)) {
    if (await writeIfChanged(bookDir, file, content)) written.push(file);
  }
  return written;
}

async function writeIfChanged(bookDir: string, file: string, content: string): Promise<boolean> {
  const target = join(bookDir, file);
  const current = await readFile(target, "utf-8").catch(() => undefined);
  if (current === content) return false;
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.mirror-${process.pid}-${Date.now()}.tmp`;
  try {
    await writeFile(temp, content, "utf-8");
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return true;
}

async function backupOriginals(bookDir: string): Promise<string[]> {
  const backedUp: string[] = [];
  for (const file of Object.values(MIRROR_FILES)) {
    const source = join(bookDir, file);
    const target = join(bookDir, MIRROR_BACKUP_DIR, file);
    if ((await readFile(target).catch(() => undefined)) !== undefined) continue;
    if ((await readFile(source).catch(() => undefined)) === undefined) continue;
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
    backedUp.push(file);
  }
  return backedUp;
}


async function readChapterTitles(bookDir: string, chapters: readonly number[]): Promise<Map<number, string>> {
  const titles = new Map<number, string>();
  for (const chapter of chapters) {
    const title = markdownTitle(await readChapterText(bookDir, chapter));
    if (title) titles.set(chapter, title);
  }
  return titles;
}

/** 章节文件的章名（核心 parseDraftFile：第一行非空行是一级章名行）。 */
export function markdownTitle(text: string | undefined): string | undefined {
  return text === undefined ? undefined : parseDraftFile(text).title;
}
