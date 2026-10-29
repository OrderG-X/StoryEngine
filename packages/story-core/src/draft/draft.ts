/**
 * 工作稿：作者在稿纸上写、AI 起草或改稿的那一份（还没定稿的正文）。
 *
 * 一章一份文件 `drafts/fast/chapter-NNNN.md`（沿用老书路径），第一行「# 章名」可有可无。
 * 版本号 = 这一章的工作稿代次 + 文件全文的哈希（代次见 store/control.ts）：谁写了文件（作者存稿、AI 改稿）这章换新号，
 * 撤销 / 恢复换新纪元。只用全文哈希不够：R → 作者存 A → AI 换 B → 撤销回 R，照 R 发的旧存稿和撤销后的版本号一模一样，
 * 会把撤销的结果又盖成 A（写作版本 P1b 第 3 轮复核）。代次不进存档点，撤销翻不回去。
 *
 * 存稿要带「我是在哪个版本上改的」（baseVersion）：和盘上对不上就不存、把盘上那份如实交回去，
 * 由编辑器决定换上还是留作者自己那版——不会悄悄互相覆盖。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readChapterText, sha256 } from "../store/book.js";
import { draftStampOf, readDraftGens, type DraftStamp } from "../store/control.js";
import { draftPath } from "../store/paths.js";
import { parseDraftFile, sameDraftBody } from "./format.js";

export { composeDraftFile, leadingHeading, normalizeDraft, parseDraftFile, retitleText, sameDraft, sameDraftBody, type DraftText } from "./format.js";

export interface Draft {
  readonly chapter: number;
  /** 文件第一行「# 章名」里的章名；没有就是 undefined。 */
  readonly title?: string;
  /** 去掉章名行后的正文。 */
  readonly body: string;
  /** 代次 + 文件全文的哈希（前 16 位）。 */
  readonly version: string;
}

/** 老书（还没换过纪元、这章没号）就是全文的哈希，升级前打开的稿纸照样对得上。 */
export function draftVersionOf(fileText: string, stamp: DraftStamp): string {
  if (!stamp.epoch && stamp.gen === undefined) return sha256(fileText).slice(0, 16);
  return sha256(`${stamp.epoch}\u0000${stamp.gen ?? ""}\u0000${fileText}`).slice(0, 16);
}

/**
 * 这一章没有工作稿时的版本号。老书（还没换过纪元、这章没号）是 null；换过纪元以后「没有稿」也带代次：
 * 「没有稿 → 作者存 A → AI 换 B → 撤销回没有稿」之后，照最早那个「没有稿」发的旧存稿对不上，不会把撤销掉的 A 又写回来
 * （写作版本 P1b 第 4 轮复核 R1）。和任何一份全文的版本号都不会撞（前缀不同）。
 */
export function absentDraftVersion(stamp: DraftStamp): string | null {
  if (!stamp.epoch && stamp.gen === undefined) return null;
  return `none-${sha256(`${stamp.epoch}\u0000${stamp.gen ?? ""}\u0000\u0001absent`).slice(0, 11)}`;
}

/** 一章工作稿此刻的代次。 */
export async function readDraftStamp(bookDir: string, chapter: number): Promise<DraftStamp> {
  return draftStampOf(await readDraftGens(bookDir), chapter);
}

/**
 * 一章工作稿此刻的样子：有文件就是原样全文和它的版本号，没有文件就只有「没有稿」的版本号（老书是 null）。
 * 代次先读、正文后读：正赶上写，算出的版本号谁都对不上（存稿撞版本，不会盖错）。
 * 要拿「我是在哪一版上改的」去比的地方都用这里的 version，别拿 `readDraft(...)?.version ?? null`：那样「没有稿」永远是 null。
 */
export async function readDraftState(bookDir: string, chapter: number): Promise<{ readonly file?: { readonly text: string; readonly version: string }; readonly version: string | null }> {
  return stateWithStamp(bookDir, chapter, await readDraftStamp(bookDir, chapter));
}

async function stateWithStamp(bookDir: string, chapter: number, stamp: DraftStamp): Promise<{ readonly file?: { readonly text: string; readonly version: string }; readonly version: string | null }> {
  let text: string;
  try {
    text = await readFile(join(bookDir, draftPath(chapter)), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: absentDraftVersion(stamp) };
    throw error;
  }
  const version = draftVersionOf(text, stamp);
  return { file: { text, version }, version };
}

/** 几章工作稿此刻的版本号，和 readDraftState 一样算，代次表只读一次（大书整本拍材料快照用，第 8 轮复核的性能观察）。 */
export async function readDraftVersions(bookDir: string, chapters: readonly number[]): Promise<ReadonlyMap<number, string | null>> {
  const gens = await readDraftGens(bookDir);
  const versions = new Map<number, string | null>();
  for (const chapter of chapters) versions.set(chapter, (await stateWithStamp(bookDir, chapter, draftStampOf(gens, chapter))).version);
  return versions;
}

/** 一章工作稿的原样全文和版本号（一起读，版本号就是这份全文的）；没有文件就是 undefined。 */
export async function readDraftFile(bookDir: string, chapter: number): Promise<{ readonly text: string; readonly version: string } | undefined> {
  return (await readDraftState(bookDir, chapter)).file;
}

/** 读一章的工作稿；没有文件就是 undefined。 */
export async function readDraft(bookDir: string, chapter: number): Promise<Draft | undefined> {
  const file = await readDraftFile(bookDir, chapter);
  return file && { chapter, ...parseDraftFile(file.text), version: file.version };
}

export interface ChapterPaper {
  readonly chapter: number;
  /** 工作稿；没有就是 null。 */
  readonly draft: Draft | null;
  /** 工作稿此刻的版本号（没有稿也有，老书没有稿是 null）：稿纸存稿拿它当底版。 */
  readonly draftVersion: string | null;
  /** 定稿正文；没定稿就是 null。 */
  readonly committed: { readonly title?: string; readonly body: string } | null;
  /** 定稿后工作稿又改过（两份都在且正文不一样）；没定稿或没工作稿就是 null。 */
  readonly editedSinceCommit: boolean | null;
}

/** 稿纸打开一章要的全部：工作稿、定稿、定稿后改过没有。 */
export async function readChapterPaper(bookDir: string, chapter: number): Promise<ChapterPaper> {
  const [state, committedText] = await Promise.all([readDraftState(bookDir, chapter), readChapterText(bookDir, chapter)]);
  const draft = state.file && { chapter, ...parseDraftFile(state.file.text), version: state.file.version };
  const committed = committedText === undefined ? null : parseDraftFile(committedText);
  return {
    chapter,
    draft: draft ?? null,
    draftVersion: state.version,
    committed,
    editedSinceCommit: draft && committed ? !sameDraftBody(draft.body, committed.body) : null,
  };
}
