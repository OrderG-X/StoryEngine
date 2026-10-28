/**
 * 换不上的稿先留着，由作者在稿纸上选（写作版本 P1b）：
 * - AI 稿候选 `agents/drafts/candidates/<id>.json`（draft-candidate/1）：AI 写好、没换上工作稿的一份
 *   （写的途中作者改过稿 / 撤销过，或前文、设定改过）。出稿流程开写就存一份「在写」，写到一半停了（进程没了、流程抛错）也找得回；
 *   换上了就删。「在写」的那份只要还有人在写就不提示（本进程里登记着，见 releaseDraftCandidate）。
 * - 恢复稿 `agents/drafts/recovery/<id>.json`（draft-recovery/1）：作者存稿撞了版本时手上那份。
 *   同一章、同一底版只留最新的一份（撞版本后接着打字，一直存到这一份里）。
 * 都在 `agents/` 下，不进存档点（撤销不会把它们翻没）；作者没处理的不自动清。
 */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { composeDraftFile, parseDraftFile, readDraft, sha256 } from "@actalk/story-core";
import { writeFileAtomic } from "./project-io.js";

/** 本进程里正在写的候选：标着「在写」却不在这里的，就是写到一半停了（进程没了、流程抛错）。 */
const writingNow = new Set<string>();

const ID = /^[0-9a-z-]{8,80}$/u;

export const DraftCandidateSource = z.enum(["draft", "continue", "de-ai", "unit-fix", "revise", "revision"]);
export type DraftCandidateSource = z.infer<typeof DraftCandidateSource>;

/** 为什么没换上：写的途中工作稿变了 / 前文或设定变了 / 写到一半进程没了。 */
export const DraftKeptReason = z.enum(["draft_moved", "basis_moved", "interrupted"]);
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

const DraftRecoveryFile = z.object({
  schema: z.literal("draft-recovery/1"),
  id: z.string().regex(ID),
  chapter: z.number().int().min(1),
  title: z.string().optional(),
  body: z.string(),
  /** 作者是在哪一版上改的（撞版本时手上的底版）。 */
  baseVersion: z.string().nullable(),
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
  await writeEntry(projectDir, candidatesDir(projectDir), id, candidate);
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
  await removeEntry(candidatesDir(projectDir), id);
}

/** AI 的新一版换上了：这一章更早的候选都是照更早的稿写的，一起清掉。 */
export async function clearDraftCandidates(projectDir: string, chapter: number): Promise<void> {
  for (const candidate of await readEntries(candidatesDir(projectDir), DraftCandidateFile)) {
    if (candidate.chapter === chapter && !writingNow.has(candidate.id)) {
      await removeEntry(candidatesDir(projectDir), candidate.id);
    }
  }
}

/** 这一章等作者选的那份（没换上的，或写到一半停了的）；正在写的不算。 */
export async function pendingDraftCandidate(projectDir: string, chapter: number): Promise<DraftCandidate | undefined> {
  const candidates = (await readEntries(candidatesDir(projectDir), DraftCandidateFile))
    .filter((candidate) => candidate.chapter === chapter && candidate.body.trim() && !writingNow.has(candidate.id))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return candidates[0];
}

/* --------------------------------- 恢复稿 -------------------------------- */

/** 存稿撞了版本：把作者手上那份留下。同一章同一底版只留一份（接着打的字存进同一份）。 */
export async function saveDraftRecovery(projectDir: string, input: {
  readonly chapter: number;
  readonly title?: string;
  readonly body: string;
  readonly baseVersion: string | null;
}): Promise<DraftRecovery> {
  const id = `${input.chapter}-${(input.baseVersion ?? "new").slice(0, 24)}`;
  const now = new Date().toISOString();
  const previous = await readDraftRecovery(projectDir, id);
  const recovery: DraftRecovery = {
    schema: "draft-recovery/1",
    id,
    chapter: input.chapter,
    ...splitTitle(input),
    baseVersion: input.baseVersion,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
  await writeEntry(projectDir, recoveryDir(projectDir), id, recovery);
  return recovery;
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

export async function removeDraftRecovery(projectDir: string, id: string): Promise<void> {
  await removeEntry(recoveryDir(projectDir), id);
}

/** 作者存上了：和存上的这份一样的恢复稿没用了。 */
export async function clearSavedRecoveries(projectDir: string, chapter: number, savedBody: string): Promise<void> {
  for (const recovery of await readEntries(recoveryDir(projectDir), DraftRecoveryFile)) {
    if (recovery.chapter === chapter && recovery.body.trim() === savedBody.trim()) await removeEntry(recoveryDir(projectDir), recovery.id);
  }
}

/* ------------------------------ 稿纸上的提示 ------------------------------ */

/** 稿纸打开一章时要提示作者的一份：先恢复稿（作者自己的字），再 AI 候选。和工作稿一样的不提示。 */
export type PendingDraft =
  | { readonly kind: "recovery"; readonly id: string; readonly title?: string; readonly body: string; readonly sha: string }
  | { readonly kind: "candidate"; readonly id: string; readonly title?: string; readonly body: string; readonly sha: string; readonly reason: DraftKeptReason };

export async function pendingDraftFor(projectDir: string, chapter: number): Promise<PendingDraft | undefined> {
  const draftBody = (await readDraft(projectDir, chapter))?.body.trim() ?? "";
  const recoveries = (await readEntries(recoveryDir(projectDir), DraftRecoveryFile))
    .filter((recovery) => recovery.chapter === chapter && recovery.body.trim() && recovery.body.trim() !== draftBody)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const recovery = recoveries[0];
  if (recovery) return { kind: "recovery", id: recovery.id, ...(recovery.title ? { title: recovery.title } : {}), body: recovery.body, sha: sha256(recovery.body) };
  const candidate = await pendingDraftCandidate(projectDir, chapter);
  if (!candidate || candidate.body.trim() === draftBody) return undefined;
  return {
    kind: "candidate",
    id: candidate.id,
    ...(candidate.title ? { title: candidate.title } : {}),
    body: candidate.body,
    sha: sha256(candidate.body),
    reason: candidate.status === "writing" ? "interrupted" : candidate.reason ?? "draft_moved",
  };
}
