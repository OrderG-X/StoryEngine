// @vitest-environment node
/**
 * 没收拾的事务有好几份时怎么退（写作版本 P1 第 18 轮复核）：
 * - AF2 老格式残留和核心事务改了同一个文件：按开工先后倒着退，不复活老格式写到一半的那份；分不清先后就一份都不退、如实拦。
 * - AF1 核心事务回滚只要真退回过文件，就换一个新的写入代次（不论这次写没写代次）。
 * - C181 读侧和恢复用同一份判断：恢复收拾不了的老残留，读侧不报稳定。
 * - C182 开书时核心有收拾不了的残留，不报接好了。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  composeDraftFile,
  draftPath,
  draftSave,
  hasPendingTransactions,
  LegacyResidueError,
  readBookSnapshot,
  readDraft,
  readDraftState,
  recoverBookTransactions,
  runCommand,
  withSettledBook,
} from "@actalk/story-core";
import { createStoryProject } from "./project-store.js";
import { ensureBookOnCore } from "./mirror/ensure.js";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";

const sha = (text: string): string => createHash("sha256").update(text, "utf-8").digest("hex");
const DRAFT = draftPath(1);
const GENS = "store-control/drafts.json";
const REVISION = "store-control/revision.json";

let root: string;
let book: string;
beforeEach(async () => {
  root = await makeHomeTempDir("mixed-tx-");
  ({ projectDir: book } = await createStoryProject({ rootDir: root, title: "事务先后", genre: "都市", protagonistName: "林远" }));
  expect((await runCommand(book, draftSave, { chapter: 1, title: "作者原名", body: "作者成功保存的 A。", baseVersion: null }, { caller: "author" })).ok).toBe(true);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const read = (path: string): Promise<string> => readFile(join(book, path), "utf-8");

/** 照老定稿链写盘的格式造一份没写完的事务：备份了工作稿 previous，清单 staged。 */
async function legacyResidue(previous: string, createdAt: string): Promise<string> {
  const tx = join(book, ".story-engine-tx", "commit-chapter-0001");
  await mkdir(join(tx, "backups", DRAFT, ".."), { recursive: true });
  await writeFile(join(tx, "backups", DRAFT), previous);
  await writeFile(join(tx, "manifest.json"), JSON.stringify({
    version: 2, chapter: 1, createdAt, files: [DRAFT],
    backups: [{ relativePath: DRAFT, existed: true, backupPath: join("backups", DRAFT), sha256: sha(previous) }],
    status: "staged",
  }));
  return tx;
}

/** 造一份被杀进程留下的核心存稿事务：备份的是当时盘上的工作稿代次和工作稿，都已换上（没有暂存），清单 prepared。 */
async function coreResidue(name: string, createdAt: string, before: { gens: string; draft: string }): Promise<void> {
  const tx = join(book, ".story-core-tx", name);
  await mkdir(join(tx, "backup"), { recursive: true });
  await mkdir(join(tx, "staged"), { recursive: true });
  await writeFile(join(tx, "backup", "0"), before.gens);
  await writeFile(join(tx, "backup", "1"), before.draft);
  await writeFile(join(tx, "manifest.json"), JSON.stringify({
    schema: "story-core-tx/1", id: name, createdAt, status: "prepared",
    files: [GENS, DRAFT].map((path, slot) => ({ path, slot: String(slot), existed: true })),
  }));
}

async function liveDraft(title: string, body: string): Promise<void> {
  const gens = JSON.parse(await read(GENS)) as { chapters: Record<string, string> };
  gens.chapters["1"] = `half-${title}`;
  await writeFile(join(book, GENS), JSON.stringify(gens));
  await writeFile(join(book, DRAFT), composeDraftFile({ title, body }));
}

describe("AF2 老格式和核心的事务改了同一个文件：按开工先后倒着退", () => {
  it("老格式先开工（留下 B），核心后开工（备份 B、写 C）：退回作者存好的 A，工作稿版本换新", async () => {
    const a = await read(DRAFT);
    const aVersion = (await readDraftState(book, 1)).version;
    const oldTx = await legacyResidue(a, "2026-10-18T00:00:00.000Z");
    await writeFile(join(book, DRAFT), composeDraftFile({ title: "旧事务中断名 B", body: "旧事务中断正文 B。" }));
    await coreResidue("later-core", "2026-10-28T00:00:00.000Z", { gens: await read(GENS), draft: await read(DRAFT) });
    await liveDraft("新事务中断名 C", "新事务中断正文 C。");

    const recovery = await recoverBookTransactions(book);
    expect(recovery).toMatchObject({ rolledBack: ["later-core"], problems: [] });
    expect(await readDraft(book, 1)).toMatchObject({ title: "作者原名", body: "作者成功保存的 A。" });
    expect((await readDraftState(book, 1)).version).not.toBe(aVersion);
    expect(JSON.parse(await readFile(join(oldTx, "manifest.json"), "utf-8"))).toMatchObject({ status: "recovered" });
    expect(await hasPendingTransactions(book)).toBe(false);
  });

  it("核心先开工（备份 A、写 B），老格式后开工（备份 B、写 C）：同样退回 A", async () => {
    await coreResidue("earlier-core", "2026-10-18T00:00:00.000Z", { gens: await read(GENS), draft: await read(DRAFT) });
    await liveDraft("核心中断名 B", "核心中断正文 B。");
    await legacyResidue(await read(DRAFT), "2026-10-28T00:00:00.000Z");
    await writeFile(join(book, DRAFT), composeDraftFile({ title: "老事务中断名 C", body: "老事务中断正文 C。" }));

    await recoverBookTransactions(book);
    expect(await readDraft(book, 1)).toMatchObject({ title: "作者原名", body: "作者成功保存的 A。" });
    expect(await hasPendingTransactions(book)).toBe(false);
  });

  it.each([
    ["开工时间一样", "2026-10-18T00:00:00.000Z"],
    ["开工时间读不出", "不是时间"],
  ])("%s、换回的内容又不一样：一份都不退，写命令和读侧都如实拦", async (_label, coreAt) => {
    await legacyResidue(await read(DRAFT), "2026-10-18T00:00:00.000Z");
    await writeFile(join(book, DRAFT), composeDraftFile({ title: "B", body: "B。" }));
    await coreResidue("same-time-core", coreAt, { gens: await read(GENS), draft: await read(DRAFT) });
    await liveDraft("C", "C。");
    const before = await read(DRAFT);

    const error = await recoverBookTransactions(book).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LegacyResidueError);
    expect((error as LegacyResidueError).code).toBe("TX_OVERLAP_ORDER_UNKNOWN");
    expect(await read(DRAFT)).toBe(before);
    expect(await hasPendingTransactions(book)).toBe(true);
    const saved = await runCommand(book, draftSave, { chapter: 1, title: "新", body: "新。", baseVersion: (await readDraftState(book, 1)).version }, { caller: "author" });
    expect(saved).toMatchObject({ ok: false, code: "transaction_residue" });
    expect(await read(DRAFT)).toBe(before);
  });

  it("开工时间一样、但换回的是同一份内容：谁先退都一样，照常退", async () => {
    const a = await read(DRAFT);
    await legacyResidue(a, "2026-10-18T00:00:00.000Z");
    await coreResidue("same-before-core", "2026-10-18T00:00:00.000Z", { gens: await read(GENS), draft: a });
    await liveDraft("C", "C。");

    await recoverBookTransactions(book);
    expect(await readDraft(book, 1)).toMatchObject({ title: "作者原名", body: "作者成功保存的 A。" });
  });
});

describe("AF1 核心事务回滚：真退回过文件就换写入代次", () => {
  it("只写工作稿的事务（不写代次）换上后被杀：回滚后工作稿回到原样，写入代次换了新的", async () => {
    const revision = await read(REVISION);
    await coreResidue("draft-only", new Date().toISOString(), { gens: await read(GENS), draft: await read(DRAFT) });
    await liveDraft("半截", "半截。");

    expect(await recoverBookTransactions(book)).toMatchObject({ rolledBack: ["draft-only"] });
    expect(await readDraft(book, 1)).toMatchObject({ body: "作者成功保存的 A。" });
    expect(await read(REVISION)).not.toBe(revision);
  });

  it("一个文件都还没换上（都在暂存区）：书没动过，代次不换", async () => {
    const revision = await read(REVISION);
    const tx = join(book, ".story-core-tx", "not-started");
    await mkdir(join(tx, "backup"), { recursive: true });
    await mkdir(join(tx, "staged"), { recursive: true });
    await writeFile(join(tx, "backup", "0"), await read(DRAFT));
    await writeFile(join(tx, "staged", "0"), composeDraftFile({ title: "没换上", body: "没换上。" }));
    await writeFile(join(tx, "manifest.json"), JSON.stringify({ schema: "story-core-tx/1", id: "not-started", createdAt: new Date().toISOString(), status: "prepared", files: [{ path: DRAFT, slot: "0", existed: true }] }));

    expect(await recoverBookTransactions(book)).toMatchObject({ rolledBack: ["not-started"] });
    expect(await readDraft(book, 1)).toMatchObject({ body: "作者成功保存的 A。" });
    expect(await read(REVISION)).toBe(revision);
  });
});

describe("C181 老残留：读侧和恢复同一份判断", () => {
  it.each(["invalid-applied", "invalid-recovered", "invalid-snapshot", "truncated-snapshot", "valid-applied", "zero-file-shell"] as const)("%s", async (kind) => {
    const tx = join(book, ".story-engine-tx", "commit-chapter-0001");
    await mkdir(tx, { recursive: true });
    if (kind === "zero-file-shell") {
      await mkdir(join(tx, "backups", "chapters"), { recursive: true });
    } else {
      const raw = kind === "valid-applied"
        ? { version: 2, chapter: 1, createdAt: new Date().toISOString(), files: [], backups: [], status: "applied" }
        : { status: kind === "invalid-recovered" ? "recovered" : "applied" };
      await writeFile(join(tx, kind.endsWith("snapshot") ? "snapshot-manifest.json" : "manifest.json"), kind === "truncated-snapshot" ? "{not-json" : JSON.stringify(raw));
    }
    const stable = kind === "valid-applied" || kind === "zero-file-shell";
    expect(await hasPendingTransactions(book)).toBe(!stable);
    expect((await readBookSnapshot(book)).unsettled).toBe(!stable);
    expect((await withSettledBook(book, async () => "收拾好了")).ok).toBe(stable);
  });
});

describe("C182 开书：核心有收拾不了的残留，不报接好了", () => {
  it("坏清单：如实说没接上，书原样留着", async () => {
    const tx = join(book, ".story-core-tx", "broken");
    await mkdir(tx, { recursive: true });
    await writeFile(join(tx, "manifest.json"), "{broken");
    const opened = await ensureBookOnCore(book);
    expect(opened).toMatchObject({ ok: false, code: "tx_residue" });
    if (!opened.ok) expect(opened.reason).not.toMatch(/[a-z]{4,}|\//u);
    expect((await readBookSnapshot(book)).unsettled).toBe(true);
  });

  it("老格式收拾不了：说的是中文原因，不带英文报错和路径", async () => {
    const tx = join(book, ".story-engine-tx", "commit-chapter-0001");
    await mkdir(tx, { recursive: true });
    await writeFile(join(tx, "manifest.json"), "{broken");
    const opened = await ensureBookOnCore(book);
    expect(opened).toMatchObject({ ok: false, code: "legacy_tx_residue" });
    if (!opened.ok) expect(opened.reason).not.toMatch(/[a-z]{4,}|\//u);
  });
});
