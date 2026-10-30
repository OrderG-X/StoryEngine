/**
 * 定论确认后改齐用的参数（P12；写作版本 P2a 片 3C 起预览存在操作的步骤里，不再另存票库）：
 * 预览里的改法去掉作者划掉的，拼成 settle.apply 的参数，一条核心命令写完（写前存档，能撤销）。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  applyUnitEdits,
  draftPath,
  quoteInText,
  readChapterText,
  splitUnits,
  type CardOp,
  type SettleApplyArgs,
} from "@actalk/story-core";
import type { SettleProposal } from "./propose.js";

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

/** 什么都不改（定论已经记着 / 只是一场的事，要改的又都划掉了）。 */
export const isEmptySettleArgs = (args: SettleApplyArgs): boolean => args.cardOps.length + args.chapters.length + args.drafts.length === 0;
