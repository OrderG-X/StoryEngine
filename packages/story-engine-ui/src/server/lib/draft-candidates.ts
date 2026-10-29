/**
 * 换不上的稿先留着，由作者在稿纸上选（写作版本 P1b）：
 * - AI 稿候选 `agents/drafts/candidates/<id>.json`（draft-candidate/1）：AI 写好的一份，换上工作稿之前就先存下
 *   （applyAiDraft 先存「在写」再换；出稿流程开写就存一份「在写」、每步更新）。换上了就删这一份；没换上（写的途中作者改过稿 /
 *   撤销过，前文、设定改过，写盘出错）、写到一半停了（进程没了、流程抛错）都留着。「在写」的那份只要还有人在写就不提示
 *   （本进程里登记着，见 releaseDraftCandidate）。别的流程换上了新稿，也不清作者还没处理的这些。
 * - 恢复稿 `agents/drafts/recovery/r<章>-<窗口号>.json`（draft-recovery/1）：作者存稿撞了版本时手上那份。
 *   一个稿纸窗口每章一份（窗口号前端开页面时随机给），存的是这个窗口最新的字；带请求序号，比盘上这份旧的请求不写（迟到的旧字盖不回新字）。
 *   存上了、作者说不要了、找回了，就把正文清空、留着序号（再迟到的旧请求照样不写）。
 * - 存稿记号 `agents/drafts/saves/s<章>-<窗口号>.json`（draft-save-mark/1）：一个稿纸窗口在一章上最后处理的那笔存稿的序号，
 *   和它一连串存上的版本（从哪一版起头、依次存成了哪几版）。序号不比它大的存稿是迟到的旧笔，不写；
 *   盘上还是这个窗口最后存成的那版、新一笔又是照这一串里的某一版改的（关窗时补发的那笔和在路上那笔，
 *   或补发之后页面没关、接着存的那笔），就是这个窗口自己接着写，顺着接上（第 7 轮复核 U2）。
 * 写都在书锁里（和存稿、找回、换上同一把锁）：查过的那份到换上为止不会被别人改。
 * 都在 `agents/` 下，不进存档点（撤销不会把它们翻没）；作者没处理的不自动清。
 */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { composeDraftFile, parseDraftFile, readDraft, sha256, withBookLock } from "@actalk/story-core";
import { writeFileAtomic } from "./project-io.js";

/** 本进程里正在写的候选：标着「在写」却不在这里的，就是写到一半停了（进程没了、流程抛错）。 */
const writingNow = new Set<string>();

const ID = /^[0-9a-z-]{8,80}$/u;

export const DraftCandidateSource = z.enum(["draft", "continue", "de-ai", "unit-fix", "revise", "revision"]);
export type DraftCandidateSource = z.infer<typeof DraftCandidateSource>;

/** 为什么没换上：写的途中工作稿变了 / 前文或设定变了 / 换的时候写盘出错 / 写到一半进程没了。 */
export const DraftKeptReason = z.enum(["draft_moved", "basis_moved", "apply_failed", "interrupted"]);
export type DraftKeptReason = z.infer<typeof DraftKeptReason>;

const DraftCandidateFile = z.object({
  schema: z.literal("draft-candidate/1"),
  id: z.string().regex(ID),
  chapter: z.number().int().min(1),
  title: z.string().optional(),
  body: z.string(),
  baseVersion: z.string().nullable(),
  basisDigest: z.string(),
  source: DraftCandidateSource,
  status: z.enum(["writing", "ready"]),
  reason: DraftKeptReason.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DraftCandidate = z.infer<typeof DraftCandidateFile>;

/** 稿纸窗口号（前端开页面时随机给）。 */
const CLIENT = /^[0-9a-z]{8,40}$/u;

const DraftRecoveryFile = z.object({
  schema: z.literal("draft-recovery/1"),
  id: z.string().regex(ID),
  chapter: z.number().int().min(1),
  title: z.string().optional(),
  /** 空 = 已经存上 / 不要了 / 找回了（留着序号挡迟到的旧请求）。 */
  body: z.string(),
  /** 作者是在哪一版上改的（撞版本时手上的底版）。 */
  baseVersion: z.string().nullable(),
  /** 哪个稿纸窗口的。 */
  client: z.string().regex(CLIENT),
  /** 这个窗口第几笔存稿：只认比盘上大的。 */
  seq: z.number().int().min(0),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DraftRecovery = z.infer<typeof DraftRecoveryFile>;

const candidatesDir = (projectDir: string): string => join(projectDir, "agents", "drafts", "candidates");
const recoveryDir = (projectDir: string): string => join(projectDir, "agents", "drafts", "recovery");

async function writeEntry(projectDir: string, dir: string, id: string, value: unknown): Promise<void> {
  await stat(projectDir); // 书已删就别再写（免得建出幽灵目录）
  await mkdir(dir, { recursive: true });
  await writeFileAtomic(join(dir, `${id}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

async function readEntries<T>(dir: string, schema: z.ZodType<T>): Promise<T[]> {
  const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith(".json"));
  const entries: T[] = [];
  for (const name of names) {
    try {
      const parsed = schema.safeParse(JSON.parse(await readFile(join(dir, name), "utf-8")));
      if (parsed.success) entries.push(parsed.data);
    } catch {
      // 读不了、坏了的跳过（不当成有）。
    }
  }
  return entries;
}

async function removeEntry(dir: string, id: string): Promise<void> {
  if (!ID.test(id)) return;
  await rm(join(dir, `${id}.json`), { force: true });
}

/** 正文开头自带「# 章名」行的拆开，和工作稿一样存（比对、换上都按拆开的比）。 */
function splitTitle(input: { readonly title?: string; readonly body: string }): { readonly title?: string; readonly body: string } {
  const parsed = parseDraftFile(composeDraftFile({ ...(input.title?.trim() ? { title: input.title.trim() } : {}), body: input.body }));
  return { ...(parsed.title ? { title: parsed.title } : {}), body: parsed.body };
}

/** 一份稿的内容：正文 + 章名。 */
export interface DraftContent {
  readonly title?: string;
  readonly body: string;
}

/** 是不是同一份稿：拆开章名行后，正文（去首尾空白）和章名都一样（第 12 轮复核 Z2：只比正文会漏掉另起的章名）。没有稿算不一样。 */
export function sameDraftContent(a: DraftContent, b: DraftContent | undefined): boolean {
  if (!b) return false;
  const left = splitTitle(a);
  const right = splitTitle(b);
  return left.body.trim() === right.body.trim() && (left.title ?? "") === (right.title ?? "");
}

/* ------------------------------- AI 稿候选 ------------------------------- */

export async function saveDraftCandidate(projectDir: string, input: {
  readonly chapter: number;
  readonly title?: string;
  readonly body: string;
  readonly baseVersion: string | null;
  readonly basisDigest: string;
  readonly source: DraftCandidateSource;
  readonly status: "writing" | "ready";
  readonly reason?: DraftKeptReason;
  /** 更新已有的那份（出稿流程每改一步存一次）。 */
  readonly id?: string;
}): Promise<DraftCandidate> {
  const now = new Date().toISOString();
  const previous = input.id ? await readDraftCandidate(projectDir, input.id) : undefined;
  const id = previous?.id ?? `${input.chapter}-${randomUUID()}`;
  const text = splitTitle(input);
  const candidate: DraftCandidate = {
    schema: "draft-candidate/1",
    id,
    chapter: input.chapter,
    ...text,
    baseVersion: input.baseVersion,
    basisDigest: input.basisDigest,
    source: input.source,
    status: input.status,
    ...(input.reason ? { reason: input.reason } : {}),
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
  if (input.status === "writing") writingNow.add(id);
  else writingNow.delete(id);
  // 书锁里写：作者点「换成 AI 这版」查过的那份，到换上为止不会被改。
  await withBookLock(projectDir, () => writeEntry(projectDir, candidatesDir(projectDir), id, candidate));
  return candidate;
}

/** 写这份的流程结束了（换上、没换上、抛错都调）：还标着「在写」的，从此算写到一半停了，稿纸会提示。 */
export function releaseDraftCandidate(id: string): void {
  writingNow.delete(id);
}

export async function readDraftCandidate(projectDir: string, id: string): Promise<DraftCandidate | undefined> {
  if (!ID.test(id)) return undefined;
  try {
    const parsed = DraftCandidateFile.safeParse(JSON.parse(await readFile(join(candidatesDir(projectDir), `${id}.json`), "utf-8")));
    return parsed.success && parsed.data.id === id ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export async function removeDraftCandidate(projectDir: string, id: string): Promise<void> {
  writingNow.delete(id);
  await withBookLock(projectDir, () => removeEntry(candidatesDir(projectDir), id));
}

/**
 * 这一章等作者选的那份（没换上的，或写到一半停了的）；正在写的、和眼下工作稿一样的不算。
 * 先挑掉一样的再取最新：最新那份碰巧和工作稿一样时，更早那份作者还没处理的照样提示（第 4 轮复核 R4）。
 */
export async function pendingDraftCandidate(projectDir: string, chapter: number, draft?: DraftContent): Promise<DraftCandidate | undefined> {
  const candidates = (await readEntries(candidatesDir(projectDir), DraftCandidateFile))
    .filter((candidate) => candidate.chapter === chapter && candidate.body.trim() && !sameDraftContent(candidate, draft) && !writingNow.has(candidate.id))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return candidates[0];
}

/* --------------------------------- 恢复稿 -------------------------------- */

/** 一个稿纸窗口在一章上的那份恢复稿。 */
export function recoveryIdOf(chapter: number, client: string): string {
  return `r${chapter}-${client}`;
}

/** 窗口号和序号要么都对、要么都不认（不认的一笔单独存一份，不覆盖谁）。 */
export function recoveryClientOf(client: unknown, seq: unknown): { readonly client: string; readonly seq: number } | undefined {
  return typeof client === "string" && CLIENT.test(client) && typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0 ? { client, seq } : undefined;
}

export interface RecoverySave {
  readonly recovery: DraftRecovery;
  /** 盘上这份比这笔请求新（迟到的旧请求）：没写。 */
  readonly stale: boolean;
}

/**
 * 存稿撞了版本：把作者手上那份留下。在书锁里：查序号和写是一下子的。
 * 写不进去就抛（调用方如实告诉作者「没存上」，不能当存下了）。
 */
export async function saveDraftRecovery(projectDir: string, input: {
  readonly chapter: number;
  readonly title?: string;
  readonly body: string;
  readonly baseVersion: string | null;
  readonly from?: { readonly client: string; readonly seq: number };
}): Promise<RecoverySave> {
  return withBookLock(projectDir, async () => {
    const from = input.from ?? { client: randomUUID().replace(/-/gu, "").slice(0, 24), seq: 0 };
    const id = recoveryIdOf(input.chapter, from.client);
    const previous = await readDraftRecovery(projectDir, id);
    if (previous && previous.seq >= from.seq) return { recovery: previous, stale: true };
    const now = new Date().toISOString();
    const recovery: DraftRecovery = {
      schema: "draft-recovery/1",
      id,
      chapter: input.chapter,
      ...splitTitle(input),
      baseVersion: input.baseVersion,
      client: from.client,
      seq: from.seq,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    await writeEntry(projectDir, recoveryDir(projectDir), id, recovery);
    return { recovery, stale: false };
  });
}

export async function readDraftRecovery(projectDir: string, id: string): Promise<DraftRecovery | undefined> {
  if (!ID.test(id)) return undefined;
  try {
    const parsed = DraftRecoveryFile.safeParse(JSON.parse(await readFile(join(recoveryDir(projectDir), `${id}.json`), "utf-8")));
    return parsed.success && parsed.data.id === id ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** 清空正文、留着序号（调用方在书锁里）。 */
async function settleRecovery(projectDir: string, recovery: DraftRecovery, seq = recovery.seq): Promise<void> {
  const { title: _title, ...rest } = recovery;
  await writeEntry(projectDir, recoveryDir(projectDir), recovery.id, { ...rest, body: "", seq: Math.max(seq, recovery.seq), updatedAt: new Date().toISOString() });
}

/**
 * 不要那一份了（调用方在书锁里）。是这个窗口自己的那份直接清；别的窗口留下的，要作者看到的就是这一份（sha）才清。
 * 已经清空了的（找回了、别处不要了）：本窗口的就把序号推到这一笔，在路上的旧笔到了不再写回来（第 5 轮复核 S10）。
 * 返回 false = 那一份在这期间变过了，没清。
 */
export async function dismissDraftRecovery(projectDir: string, recovery: DraftRecovery, check: { readonly sha?: string; readonly from?: { readonly client: string; readonly seq: number } }): Promise<boolean> {
  const own = check.from?.client === recovery.client;
  if (!recovery.body.trim()) {
    if (own && check.from!.seq > recovery.seq) await settleRecovery(projectDir, recovery, check.from!.seq);
    return true;
  }
  if (!own && check.sha !== sha256(recovery.body)) return false;
  // 本窗口迟到的旧「不要了」：它说不要的那几笔已经被后来的字顶掉了，后来的字不清（第 4 轮复核 R2）。
  if (own && check.from!.seq < recovery.seq) return true;
  await settleRecovery(projectDir, recovery, own ? check.from!.seq : recovery.seq);
  return true;
}

/** 找回了（调用方在书锁里、刚换上）。 */
export async function consumeDraftRecovery(projectDir: string, recovery: DraftRecovery): Promise<void> {
  await settleRecovery(projectDir, recovery);
}

/** 清空了的恢复稿留多久（挡迟到的旧请求；一个星期前发出的请求不会再到了）。 */
const SETTLED_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** 作者存上了（调用方在书锁里）：这个窗口的那份清掉（留着这次的序号），别的窗口和存上的这份一样（正文和章名）的也清。 */
export async function clearSavedRecoveries(projectDir: string, chapter: number, saved: DraftContent, from?: { readonly client: string; readonly seq: number }): Promise<void> {
  const now = Date.now();
  for (const recovery of await readEntries(recoveryDir(projectDir), DraftRecoveryFile)) {
    if (!recovery.body && now - Date.parse(recovery.updatedAt) > SETTLED_KEEP_MS) {
      await removeEntry(recoveryDir(projectDir), recovery.id);
      continue;
    }
    if (recovery.chapter !== chapter) continue;
    // 本窗口的：只清这笔之前的（迟到的旧笔恰好和盘上一样也算存上，但它之后那几笔还在恢复稿里，不能顺手清掉，第 4 轮复核 R2）。
    if (from && recovery.client === from.client) {
      if (from.seq >= recovery.seq) await settleRecovery(projectDir, recovery, from.seq);
    } else if (recovery.body.trim() && sameDraftContent(recovery, saved)) await settleRecovery(projectDir, recovery);
  }
}

/* -------------------------------- 存稿记号 -------------------------------- */

const SaveMarkFile = z.object({
  schema: z.literal("draft-save-mark/1"),
  chapter: z.number().int().min(1),
  client: z.string().regex(CLIENT),
  /** 最后处理的那笔（存上、存成恢复稿都算）。 */
  seq: z.number().int().min(0),
  /** 这个窗口一连串存上的：起头那一版、依次存成的版本（最后一个是最近存成的）。 */
  saved: z.object({ base: z.string().nullable(), versions: z.array(z.string()).min(1) }).optional(),
  updatedAt: z.string(),
});
export type DraftSaveMark = z.infer<typeof SaveMarkFile>;

const savesDir = (projectDir: string): string => join(projectDir, "agents", "drafts", "saves");
const saveMarkId = (chapter: number, client: string): string => `s${chapter}-${client}`;

/** 一个窗口在一章上的存稿记号（调用方在书锁里）；没有、坏了都是 undefined。 */
export async function readSaveMark(projectDir: string, chapter: number, client: string): Promise<DraftSaveMark | undefined> {
  try {
    const parsed = SaveMarkFile.safeParse(JSON.parse(await readFile(join(savesDir(projectDir), `${saveMarkId(chapter, client)}.json`), "utf-8")));
    return parsed.success && parsed.data.chapter === chapter && parsed.data.client === client ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

const CHAIN_KEPT = 20;

/** 盘上还是这个窗口最后存成的那版、这笔又是照这个窗口这一串里的某一版改的：这个窗口自己接着写。 */
export function ownLineage(mark: DraftSaveMark | undefined, baseVersion: string | null, diskVersion: string | null): boolean {
  const chain = mark?.saved;
  if (!chain || diskVersion !== chain.versions.at(-1)) return false;
  return chain.base === baseVersion || (baseVersion !== null && chain.versions.includes(baseVersion));
}

/** 记下这一笔（调用方在书锁里）；saved 是存上了：照哪一版改的、存成了哪一版。顺手清掉一个星期没动过的记号。 */
export async function writeSaveMark(projectDir: string, input: { readonly chapter: number; readonly from: { readonly client: string; readonly seq: number }; readonly saved?: { readonly base: string | null; readonly version: string } }): Promise<void> {
  const previous = await readSaveMark(projectDir, input.chapter, input.from.client);
  const chain = previous?.saved;
  // 照这一串里的版本改的就接在后面；照别处的版本改的另起一串。
  const continues = chain && input.saved && (chain.base === input.saved.base || (input.saved.base !== null && chain.versions.includes(input.saved.base)));
  const saved = !input.saved
    ? chain
    : continues
      ? { base: chain.base, versions: [...chain.versions, input.saved.version].slice(-CHAIN_KEPT) }
      : { base: input.saved.base, versions: [input.saved.version] };
  const mark: DraftSaveMark = {
    schema: "draft-save-mark/1",
    chapter: input.chapter,
    client: input.from.client,
    seq: Math.max(input.from.seq, previous?.seq ?? 0),
    ...(saved ? { saved } : {}),
    updatedAt: new Date().toISOString(),
  };
  await writeEntry(projectDir, savesDir(projectDir), saveMarkId(input.chapter, input.from.client), mark);
  const now = Date.now();
  for (const old of await readEntries(savesDir(projectDir), SaveMarkFile)) {
    if (now - Date.parse(old.updatedAt) > SETTLED_KEEP_MS) await rm(join(savesDir(projectDir), `${saveMarkId(old.chapter, old.client)}.json`), { force: true });
  }
}

/* ------------------------------ 稿纸上的提示 ------------------------------ */

/** 稿纸打开一章时要提示作者的一份：先恢复稿（作者自己的字），再 AI 候选。和工作稿一样的不提示。 */
export type PendingDraft =
  | { readonly kind: "recovery"; readonly id: string; readonly title?: string; readonly body: string; readonly sha: string }
  | { readonly kind: "candidate"; readonly id: string; readonly title?: string; readonly body: string; readonly sha: string; readonly reason: DraftKeptReason };

export async function pendingDraftFor(projectDir: string, chapter: number): Promise<PendingDraft | undefined> {
  // 和工作稿是同一份（正文和章名都一样）才不提示：只比正文，作者另起的章名就找不回了（第 12 轮复核 Z2）。
  const draft = await readDraft(projectDir, chapter);
  const recoveries = (await readEntries(recoveryDir(projectDir), DraftRecoveryFile))
    .filter((recovery) => recovery.chapter === chapter && recovery.body.trim() && !sameDraftContent(recovery, draft))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const recovery = recoveries[0];
  if (recovery) return { kind: "recovery", id: recovery.id, ...(recovery.title ? { title: recovery.title } : {}), body: recovery.body, sha: sha256(recovery.body) };
  const candidate = await pendingDraftCandidate(projectDir, chapter, draft);
  if (!candidate) return undefined;
  return {
    kind: "candidate",
    id: candidate.id,
    ...(candidate.title ? { title: candidate.title } : {}),
    body: candidate.body,
    sha: sha256(candidate.body),
    reason: candidate.status === "writing" ? "interrupted" : candidate.reason ?? "draft_moved",
  };
}
