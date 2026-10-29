/**
 * 工作稿的三条写命令（写作版本 P1b）：
 *  - draft.save（作者档）：稿纸停笔就存，AI 回合里也存。带 baseVersion，和盘上对不上就不存，把盘上那份交回去；
 *    盘上已经就是要存的这份（同一笔重发、别处恰好存过）算存上了。不打快照（每次停笔都存，打快照会把历史淹掉）。
 *  - draft.applyGenerated（AI 档）：把 AI 写好的一份（服务端先存成候选）换上工作稿。基稿版本必带，
 *    盘上已经不是那一版（作者这期间存过稿、撤销过）就不换；调用方另带真相依据，写的途中前文 / 设定变了也不换。
 *    不换的那份留在候选里，由作者决定。存档点由调用方在同一把书锁里先打。
 *  - draft.adoptCandidate（作者档）：作者点了「换成 AI 这版」。带作者眼前那份的版本，对不上就不换；写前打快照，能撤销。
 */
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { draftPath } from "../store/paths.js";
import { fail } from "../commands/runner.js";
import type { PlanContext, WriteCommandSpec } from "../commands/types.js";
import type { DraftStamp } from "../store/control.js";
import { absentDraftVersion, composeDraftFile, draftVersionOf, parseDraftFile, readDraft, readDraftStamp, type Draft } from "./draft.js";

/** 三条命令同一份参数：都要说清是拿哪一版改 / 换的（这一章原来没有工作稿就是 null）。 */
export const DraftSaveArgs = z.object({
  chapter: z.number().int().min(1),
  body: z.string(),
  title: z.string().optional(),
  baseVersion: z.string().min(1).nullable(),
});
export type DraftSaveArgs = z.infer<typeof DraftSaveArgs>;

export interface DraftWriteResult {
  readonly chapter: number;
  readonly version: string;
  /** 盘上原来就是这一版，这次什么都没写。 */
  readonly unchanged: boolean;
}

/** 存稿撞版本时交回去的东西：盘上那份（没有就是 null）和它此刻的版本号（没有稿也有，老书是 null）。 */
export interface DraftConflictDetails {
  readonly current: Draft | null;
  readonly currentVersion: string | null;
}

async function readRaw(bookDir: string, chapter: number): Promise<string | undefined> {
  try {
    return await readFile(join(bookDir, draftPath(chapter)), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** 盘上的版本和调用方手里的对不上：不写，把盘上那份交回去。盘上已经就是要写的这份不算对不上（同一笔重发）。 */
async function conflictIfMoved(bookDir: string, chapter: number, baseVersion: string | null, currentText: string | undefined, stamp: DraftStamp, nextText: string) {
  const currentVersion = currentText === undefined ? absentDraftVersion(stamp) : draftVersionOf(currentText, stamp);
  if (baseVersion === currentVersion || currentText === nextText) return undefined;
  const current = currentText === undefined ? null : { chapter, ...parseDraftFile(currentText), version: currentVersion as string };
  const details: DraftConflictDetails = { current, currentVersion };
  return fail("draft_conflict", `第 ${chapter} 章的工作稿在别处改过了（比如 AI 改稿或撤销），这次没有写。`, details);
}

/** 写了：版本号按这次的代次号算（runner 在同一个事务里换上它）。没写：还是盘上那一版。 */
function planWrite(context: PlanContext, chapter: number, nextText: string, currentText: string | undefined, stamp: DraftStamp, label: string) {
  if (currentText === nextText) {
    return { label, writes: [], changed: {}, result: { chapter, version: draftVersionOf(nextText, stamp), unchanged: true } };
  }
  return {
    label,
    writes: [{ path: draftPath(chapter), content: nextText }],
    changed: { drafts: [chapter] },
    result: { chapter, version: draftVersionOf(nextText, { epoch: stamp.epoch, gen: context.draftGen }), unchanged: false },
  };
}

/** 标题：给了用给的，没给沿用盘上的。 */
async function nextDraftText(bookDir: string, args: { readonly chapter: number; readonly body: string; readonly title?: string }, currentText: string | undefined): Promise<string> {
  const currentTitle = currentText === undefined ? undefined : (await readDraft(bookDir, args.chapter))?.title;
  const title = args.title?.trim() || currentTitle;
  return composeDraftFile({ ...(title ? { title } : {}), body: args.body });
}

async function planReplace(context: PlanContext, args: DraftSaveArgs, label: string) {
  const stamp = await readDraftStamp(context.bookDir, args.chapter);
  const currentText = await readRaw(context.bookDir, args.chapter);
  const nextText = await nextDraftText(context.bookDir, args, currentText);
  const conflict = await conflictIfMoved(context.bookDir, args.chapter, args.baseVersion, currentText, stamp, nextText);
  if (conflict) return conflict;
  return planWrite(context, args.chapter, nextText, currentText, stamp, label);
}

export const draftSave: WriteCommandSpec<DraftSaveArgs, DraftWriteResult> = {
  name: "draft.save",
  tier: "author",
  summary: "作者存工作稿（带版本号，和盘上对不上就不存）。",
  args: DraftSaveArgs,
  snapshot: false,
  idempotent: false,
  bumpsVersion: false,
  plan: (context, args) => planReplace(context, args, `存稿：第 ${args.chapter} 章`),
};

export const draftApplyGenerated: WriteCommandSpec<DraftSaveArgs, DraftWriteResult> = {
  name: "draft.applyGenerated",
  tier: "ai-direct",
  summary: "把 AI 写好的一份换上工作稿（基稿版本对不上就不换，留在候选里）。",
  args: DraftSaveArgs,
  snapshot: true,
  idempotent: false,
  bumpsVersion: false,
  plan: (context, args) => planReplace(context, args, `AI 写稿：第 ${args.chapter} 章`),
};

export const draftAdoptCandidate: WriteCommandSpec<DraftSaveArgs, DraftWriteResult> = {
  name: "draft.adoptCandidate",
  tier: "author",
  summary: "作者把 AI 写的那份换上工作稿（作者眼前那份的版本对不上就不换）。",
  args: DraftSaveArgs,
  snapshot: true,
  idempotent: false,
  bumpsVersion: false,
  plan: (context, args) => planReplace(context, args, `换上 AI 稿：第 ${args.chapter} 章`),
};
