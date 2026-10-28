/**
 * 提议的依据（写作版本 P1a，2026-10-29）：对话 AI 提的「确认改账」「确认改设定」「认下」按钮只带一个依据摘要，
 * 完整依据（四样真相每个文件的哈希）存在书里 `agents/basis/<摘要>.json`。作者点按钮时按摘要取回、在书锁里和现在的书比，
 * 变了就不执行、如实说哪里变了。存不上、取不回都如实失败，绝不当「没变」放行。
 */
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { diffTruthBasis, readTruthBasis, TruthBasis, type BasisChange } from "@actalk/story-core";
import { writeFileAtomic } from "./project-io.js";

const DIGEST = /^[0-9a-f]{64}$/u;
/** 留最近这么多份依据（一份几 KB）；更老的提议按钮点了如实说过期。 */
const KEEP_BASES = 300;

const basisDir = (projectDir: string): string => join(projectDir, "agents", "basis");

/** 存一份依据，返回摘要（按钮上带它）。同一份只存一次。 */
export async function rememberBasis(projectDir: string, basis: TruthBasis): Promise<string> {
  await stat(projectDir); // 书已删就别再写（免得建出幽灵目录）
  const path = join(basisDir(projectDir), `${basis.digest}.json`);
  const exists = await stat(path).then(() => true, () => false);
  if (!exists) {
    await mkdir(basisDir(projectDir), { recursive: true });
    await writeFileAtomic(path, `${JSON.stringify(basis)}\n`);
    await pruneBases(projectDir);
  }
  return basis.digest;
}

/** 现在这本书的依据，存好后返回摘要。 */
export async function rememberCurrentBasis(projectDir: string): Promise<string> {
  return rememberBasis(projectDir, await readTruthBasis(projectDir));
}

async function pruneBases(projectDir: string): Promise<void> {
  const names = (await readdir(basisDir(projectDir)).catch(() => [] as string[])).filter((name) => name.endsWith(".json"));
  if (names.length <= KEEP_BASES) return;
  const dated = await Promise.all(names.map(async (name) => ({ name, at: (await stat(join(basisDir(projectDir), name)).catch(() => undefined))?.mtimeMs ?? 0 })));
  for (const { name } of dated.sort((a, b) => a.at - b.at).slice(0, names.length - KEEP_BASES)) {
    await rm(join(basisDir(projectDir), name), { force: true }).catch(() => undefined);
  }
}

/** 按摘要取回依据；摘要不对、文件不在、内容坏了都是 undefined。 */
export async function recallBasis(projectDir: string, digest: string): Promise<TruthBasis | undefined> {
  if (!DIGEST.test(digest)) return undefined;
  try {
    const parsed = TruthBasis.safeParse(JSON.parse(await readFile(join(basisDir(projectDir), `${digest}.json`), "utf-8")));
    return parsed.success && parsed.data.digest === digest ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export type BasisCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "basis_missing" }
  | { readonly ok: false; readonly code: "basis_changed"; readonly changes: readonly BasisChange[] };

/** 按摘要核：书从那以后变没变。调用方要和写互斥就在书锁里调。 */
export async function checkBasis(projectDir: string, digest: string): Promise<BasisCheck> {
  const basis = await recallBasis(projectDir, digest);
  if (!basis) return { ok: false, code: "basis_missing" };
  const changes = diffTruthBasis(basis, await readTruthBasis(projectDir));
  return changes.length === 0 ? { ok: true } : { ok: false, code: "basis_changed", changes };
}

/** 依据变了哪些 → 给作者看的一句（只有章号和「设定本 / 作者裁定」，不带编号）。 */
export function describeBasisChanges(changes: readonly BasisChange[]): string {
  const parts: string[] = [];
  const chapters = (kind: "text" | "ledger") =>
    [...new Set(changes.flatMap((change) => (change.kind === kind ? [change.chapter] : [])))].sort((a, b) => a - b);
  const list = (numbers: readonly number[]): string =>
    numbers.length > 4 ? `第 ${numbers.slice(0, 4).join("、")} 等 ${numbers.length} 章` : `第 ${numbers.join("、")} 章`;
  const texts = chapters("text");
  const ledgers = chapters("ledger").filter((chapter) => !texts.includes(chapter));
  if (texts.length > 0) parts.push(`${list(texts)}的定稿正文`);
  if (ledgers.length > 0) parts.push(`${list(ledgers)}的账`);
  if (changes.some((change) => change.kind === "cards")) parts.push("设定本");
  if (changes.some((change) => change.kind === "decisions")) parts.push("作者裁定");
  return parts.length > 0 ? parts.join("、") : "书里的内容";
}
