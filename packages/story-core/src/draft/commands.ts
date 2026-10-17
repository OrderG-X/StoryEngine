/**
 * 工作稿的两条写命令：
 *  - draft.save（作者档）：稿纸自动存稿。带 baseVersion，和盘上对不上就不存，把盘上那份交回去。
 *    不打快照（每次停笔都存，打快照会把历史淹掉）；作者自己的字，撤销靠下一次 AI 写之前的快照。
 *  - draft.write（AI 档）：AI 起草或改稿写进工作稿。写前打快照，能撤销；不比 baseVersion——
 *    稿纸有没存的字时由编辑器提示作者（AI 写完会把新版本推给编辑器）。
 */
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { draftPath } from "../store/paths.js";
import { fail } from "../commands/runner.js";
import type { WriteCommandSpec } from "../commands/types.js";
import { composeDraftFile, draftVersionOf, readDraft, type Draft } from "./draft.js";

export const DraftSaveArgs = z.object({
  chapter: z.number().int().min(1),
  body: z.string(),
  title: z.string().optional(),
  /** 作者是在哪个版本上改的；这一章原来没有工作稿就传 null。 */
  baseVersion: z.string().min(1).nullable(),
});
export type DraftSaveArgs = z.infer<typeof DraftSaveArgs>;

export const DraftWriteArgs = z.object({
  chapter: z.number().int().min(1),
  body: z.string(),
  title: z.string().optional(),
  /** 可选：拿哪个版本改的（作者点的「应用修订」「全部修」「选这一版」带上）；对不上就不写。 */
  baseVersion: z.string().min(1).nullable().optional(),
});
export type DraftWriteArgs = z.infer<typeof DraftWriteArgs>;

export interface DraftWriteResult {
  readonly chapter: number;
  readonly version: string;
  /** 盘上原来就是这一版，这次什么都没写。 */
  readonly unchanged: boolean;
}

/** 存稿撞版本时交回去的东西：盘上那份（没有就是 null）。 */
export interface DraftConflictDetails {
  readonly current: Draft | null;
}

async function readRaw(bookDir: string, chapter: number): Promise<string | undefined> {
  try {
    return await readFile(join(bookDir, draftPath(chapter)), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** 盘上的版本和调用方手里的对不上：不写，把盘上那份交回去。 */
async function conflictIfMoved(bookDir: string, chapter: number, baseVersion: string | null, currentText: string | undefined) {
  const currentVersion = currentText === undefined ? null : draftVersionOf(currentText);
  if (baseVersion === currentVersion) return undefined;
  const current = currentText === undefined ? null : await readDraft(bookDir, chapter) ?? null;
  const details: DraftConflictDetails = { current };
  return fail("draft_conflict", `第 ${chapter} 章的工作稿在别处改过了（比如 AI 改稿或撤销），这次没有写。`, details);
}

function planWrite(chapter: number, nextText: string, currentText: string | undefined, label: string) {
  const version = draftVersionOf(nextText);
  if (currentText === nextText) {
    return { label, writes: [], changed: {}, result: { chapter, version, unchanged: true } };
  }
  return {
    label,
    writes: [{ path: draftPath(chapter), content: nextText }],
    changed: { drafts: [chapter] },
    result: { chapter, version, unchanged: false },
  };
}

export const draftSave: WriteCommandSpec<DraftSaveArgs, DraftWriteResult> = {
  name: "draft.save",
  tier: "author",
  summary: "作者存工作稿（带版本号，和盘上对不上就不存）。",
  args: DraftSaveArgs,
  snapshot: false,
  idempotent: false,
  bumpsVersion: false,
  async plan(context, args) {
    const currentText = await readRaw(context.bookDir, args.chapter);
    const conflict = await conflictIfMoved(context.bookDir, args.chapter, args.baseVersion, currentText);
    if (conflict) return conflict;
    const currentTitle = currentText === undefined ? undefined : (await readDraft(context.bookDir, args.chapter))?.title;
    const title = args.title?.trim() || currentTitle;
    const nextText = composeDraftFile({ ...(title ? { title } : {}), body: args.body });
    return planWrite(args.chapter, nextText, currentText, `存稿：第 ${args.chapter} 章`);
  },
};

export const draftWrite: WriteCommandSpec<DraftWriteArgs, DraftWriteResult> = {
  name: "draft.write",
  tier: "ai-direct",
  summary: "AI 起草或改稿，写进工作稿（写前存档，能撤销）。",
  args: DraftWriteArgs,
  snapshot: true,
  idempotent: false,
  bumpsVersion: false,
  async plan(context, args) {
    const currentText = await readRaw(context.bookDir, args.chapter);
    if (args.baseVersion !== undefined) {
      const conflict = await conflictIfMoved(context.bookDir, args.chapter, args.baseVersion, currentText);
      if (conflict) return conflict;
    }
    const currentTitle = currentText === undefined ? undefined : (await readDraft(context.bookDir, args.chapter))?.title;
    const title = args.title?.trim() || currentTitle;
    const nextText = composeDraftFile({ ...(title ? { title } : {}), body: args.body });
    return planWrite(args.chapter, nextText, currentText, `AI 写稿：第 ${args.chapter} 章`);
  },
};
