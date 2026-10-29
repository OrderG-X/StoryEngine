/**
 * 定论预览存盘 + 确认后改齐（P12）：预览算一次要好几次模型调用，存进书目录 `agents/settle/<票号>.json`
 * （重开应用也还在）；作者点「确认」带票号回来，这里按票号读出、去掉作者划掉的几处，拼成 settle.apply 的参数，
 * 一条核心命令写完（写前一个存档点，能撤销）。同一个票号、同一组划掉的，点两次只做一次。
 */
import { randomBytes } from "node:crypto";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  applyUnitEdits,
  draftPath,
  quoteInText,
  readChapterText,
  runCommand,
  settleApply,
  splitUnits,
  type CardOp,
  type SettleApplyArgs,
  type SettleApplyResult,
} from "@actalk/story-core";
import { runWithLazySnapshot } from "../../lib/snapshot.js";
import { describeBasisChanges } from "../../lib/truth-basis-store.js";
import { writeAtomically } from "../reader-window.js";
import type { SettleProposal } from "./propose.js";

/** 3：带真相依据（写作版本 P1a）；2 的老预览读不出来 = 过期，重新查一遍。 */
export const SETTLE_PROPOSAL_SCHEMA = "settle-proposal/3" as const;
/** 留最近这么多份预览，旧的删掉。 */
const KEEP_PROPOSALS = 20;

export interface StoredSettleProposal extends SettleProposal {
  readonly schema: typeof SETTLE_PROPOSAL_SCHEMA;
  readonly token: string;
  readonly createdAt: string;
}

const settleDir = (projectDir: string): string => join(projectDir, "agents", "settle");
const TOKEN = /^[0-9a-f]{16}$/u;

export async function saveSettleProposal(projectDir: string, proposal: SettleProposal, now = new Date()): Promise<StoredSettleProposal> {
  await stat(projectDir); // 书已删就别再写（免得建出幽灵目录）
  const stored: StoredSettleProposal = { schema: SETTLE_PROPOSAL_SCHEMA, token: randomBytes(8).toString("hex"), createdAt: now.toISOString(), ...proposal };
  await writeAtomically(join(settleDir(projectDir), `${stored.token}.json`), `${JSON.stringify(stored, null, 2)}\n`);
  const names = (await readdir(settleDir(projectDir)).catch(() => [] as string[])).filter((name) => name.endsWith(".json"));
  if (names.length > KEEP_PROPOSALS) {
    const dated = await Promise.all(names.map(async (name) => ({ name, at: (await stat(join(settleDir(projectDir), name)).catch(() => undefined))?.mtimeMs ?? 0 })));
    for (const { name } of dated.sort((a, b) => a.at - b.at).slice(0, names.length - KEEP_PROPOSALS)) {
      await rm(join(settleDir(projectDir), name), { force: true }).catch(() => undefined);
    }
  }
  return stored;
}

export async function readSettleProposal(projectDir: string, token: string): Promise<StoredSettleProposal | undefined> {
  if (!TOKEN.test(token)) return undefined;
  try {
    const parsed = JSON.parse(await readFile(join(settleDir(projectDir), `${token}.json`), "utf-8")) as Partial<StoredSettleProposal>;
    return parsed.schema === SETTLE_PROPOSAL_SCHEMA && parsed.token === token && typeof parsed.canon === "string" ? (parsed as StoredSettleProposal) : undefined;
  } catch {
    return undefined;
  }
}

/** 预览里的改法 → settle.apply 的参数（去掉作者划掉的）。账里跟着改的只带「改后原句真在新正文里」的那几条。 */
export async function settleApplyArgs(projectDir: string, proposal: SettleProposal, excluded: ReadonlySet<string>): Promise<SettleApplyArgs> {
  const edits = proposal.edits.filter((edit) => !excluded.has(edit.key));
  const fields = proposal.fields.filter((edit) => !excluded.has(edit.key));
  const cardOps: CardOp[] = [
    ...(proposal.canonExists || proposal.sceneOnly
      ? []
      : [proposal.replaces
        ? { op: "canon.set" as const, canon: proposal.replaces.id, text: proposal.canon }
        : { op: "canon.add" as const, text: proposal.canon }]),
    ...fields.map((edit): CardOp => (edit.card && edit.relationWith
      ? { op: "relation.set", a: edit.card, b: edit.relationWith, label: edit.to }
      : edit.card ? { op: "field.set", card: edit.card, label: edit.label, value: edit.to } : { op: "story.set", label: edit.label, value: edit.to })),
  ];
  const chapters: SettleApplyArgs["chapters"][number][] = [];
  const drafts: SettleApplyArgs["drafts"][number][] = [];
  for (const item of proposal.committed) {
    const mine = edits.filter((edit) => edit.target === "committed" && edit.chapter === item.chapter);
    if (mine.length === 0) continue;
    const unitEdits = mine.map(({ id, from, to }) => ({ id, from, to }));
    const text = await readChapterText(projectDir, item.chapter);
    const next = text === undefined ? undefined : applyUnitEdits(text, unitEdits);
    // 老账没记原句的那几条是照整章的改法问的：这章有一句被划掉就都不动（不知道是哪句引起的）。
    const partial = proposal.edits.some((edit) => edit.target === "committed" && edit.chapter === item.chapter && excluded.has(edit.key));
    const mineFacts = proposal.facts.filter((fact) => fact.chapter === item.chapter && !(fact.loose && partial));
    const facts = mineFacts
      .filter((fact) => fact.patch && next?.ok && quoteInText(fact.patch.quote, next.text))
      .map((fact) => ({ id: fact.factId, ...fact.patch! }));
    const retract = mineFacts.filter((fact) => fact.loose && !fact.patch).map((fact) => fact.factId);
    chapters.push({ chapter: item.chapter, textSha256: item.textSha256, edits: unitEdits, facts, retract });
    if (item.draftVersion) {
      const draftText = await readFile(join(projectDir, draftPath(item.chapter)), "utf-8").catch(() => undefined);
      const units = draftText === undefined ? [] : splitUnits(draftText);
      const carried = unitEdits
        .map((edit) => ({ edit, matches: units.filter((unit) => unit.text === edit.from) }))
        .filter(({ matches }) => matches.length === 1)
        .map(({ edit, matches }) => ({ ...edit, id: matches[0]!.id }));
      if (carried.length > 0) drafts.push({ chapter: item.chapter, baseVersion: item.draftVersion, edits: carried });
    }
  }
  for (const item of proposal.drafts) {
    const mine = edits.filter((edit) => edit.target === "draft" && edit.chapter === item.chapter);
    if (mine.length > 0) drafts.push({ chapter: item.chapter, baseVersion: item.baseVersion, edits: mine.map(({ id, from, to }) => ({ id, from, to })) });
  }
  return { label: `${proposal.sceneOnly ? "改齐" : "定论"}：${proposal.canon.slice(0, 40)}`, cardOps, chapters, drafts };
}

export type SettleApplyOutcome =
  | { readonly ok: true; readonly result: SettleApplyResult; readonly chapter?: number; readonly snapshotId?: string; readonly replayed?: true }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** 作者点了「确认」：按票号改齐（作者档）。 */
export async function applySettleProposal(projectDir: string, token: string, excluded: readonly string[]): Promise<SettleApplyOutcome> {
  const proposal = await readSettleProposal(projectDir, token);
  if (!proposal) return { ok: false, code: "proposal_missing", message: "这份定论预览找不到了，重新查一遍。" };
  const skip = new Set(excluded);
  const args = await settleApplyArgs(projectDir, proposal, skip);
  if (args.cardOps.length + args.chapters.length + args.drafts.length === 0) {
    return { ok: false, code: "nothing", message: proposal.sceneOnly ? "要改的几处都划掉了，这次什么都没改。" : "这条定论已经记着，要改的几处也都划掉了，这次什么都没改。" };
  }
  // 一张票只改一次：同一张票换了划掉的几处再点，核心如实拒绝（不按旧的选择回放成「改好了」）。
  const key = `settle:${token}`;
  const { snapshotId, result } = await runWithLazySnapshot(projectDir, (snapshot) =>
    runCommand(projectDir, settleApply, args, {
      caller: "author",
      snapshot,
      idempotencyKey: key,
      // 作者的选择只有划掉哪几处（参数里的账是照现在的正文重算的，改完再点会不一样）。
      intent: { excluded: [...skip].sort() },
      basis: proposal.basis,
    }));
  if (!result.ok) {
    if (result.code === "basis_changed") {
      const changes = (result.details as { readonly changes?: Parameters<typeof describeBasisChanges>[0] } | undefined)?.changes ?? [];
      return { ok: false, code: result.code, message: `查完之后${describeBasisChanges(changes)}改过，这份定论预览是照改之前查的，请重新查一遍。` };
    }
    return { ok: false, code: result.code, message: result.message };
  }
  return {
    ok: true,
    result: result.result,
    ...(proposal.chapter !== undefined ? { chapter: proposal.chapter } : {}),
    ...(result.replayed ? { replayed: true as const } : snapshotId ? { snapshotId } : {}),
  };
}
