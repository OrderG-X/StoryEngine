// @vitest-environment node
/**
 * 没收拾的事务有好几份时怎么退（写作版本 P1 第 18 轮复核）：
 * - AF2 老格式残留和核心事务改了同一个文件：按开工先后倒着退，不复活老格式写到一半的那份；分不清先后就一份都不退、如实拦。
 * - AF1 核心事务回滚只要真退回过文件，就换一个新的写入代次（不论这次写没写代次）。
 * - C181 读侧和恢复用同一份判断：恢复收拾不了的老残留，读侧不报稳定。
 * - C182 开书时核心有收拾不了的残留，不报接好了。
 * - 第 19 轮 AG1～AG3：要盖掉的不是那份事务写的先另存；哪份退不下去就整轮挡住；两份代次只往前走。
 * - 第 20 轮 AH1～AH4：另存只认存妥了的；去重分事务实例；老格式只碰工作稿代次也换新纪元；老清单收尾整份换上。
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  composeDraftFile,
  draftPath,
  draftSave,
  hasPendingTransactions,
  LegacyResidueError,
  listSavedDrafts,
  readBookSnapshot,
  readDraft,
  readDraftState,
  recoverBookTransactions,
  runCommand,
  setLegacyTxIoHookForTests,
  settleSavedCopy,
  withSettledBook,
} from "@actalk/story-core";
import { createStoryProject } from "./project-store.js";
import { ensureBookOnCore } from "./ensure-on-core.js";
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
  setLegacyTxIoHookForTests(undefined);
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

/** 另存区里的（收拾半截事务时另存的）。 */
async function savedCopies(): Promise<readonly { readonly path: string; readonly content: string }[]> {
  const dir = join(book, ".story-core-saved");
  const names = await readdir(dir).catch(() => [] as string[]);
  return Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => JSON.parse(await readFile(join(dir, name), "utf-8")) as { path: string; content: string }));
}

describe("AG 第 19 轮：恢复不毁唯一副本、失败就挡住、代次只往前走", () => {
  it("AG3 老事务残留比现在的稿旧（之后作者存下了 C）：退回 A，C 原样另存、稿纸上当恢复稿提示", async () => {
    const a = await read(DRAFT);
    await legacyResidue(a, "2026-10-18T00:00:00.000Z");
    // 老版本没收拾残留就让作者存了 C（回执成功）。
    const c = composeDraftFile({ title: "作者后来的名 C", body: "作者后来存下的整份 C。" });
    await writeFile(join(book, DRAFT), c);

    await recoverBookTransactions(book);
    expect(await readDraft(book, 1)).toMatchObject({ title: "作者原名", body: "作者成功保存的 A。" });
    expect(await savedCopies()).toEqual([expect.objectContaining({ path: DRAFT, content: c })]);
    // 稿纸上当恢复稿提示（找回 / 不要了见 routes/draft-title-ownership.test.ts）。
    expect(await listSavedDrafts(book, 1)).toEqual([expect.objectContaining({ chapter: 1, title: "作者后来的名 C", body: "作者后来存下的整份 C。", settled: false })]);
  });

  it.each([
    ["备份坏了", async (tx: string) => { await writeFile(join(tx, "backups", DRAFT), "被改过的备份"); }],
    ["备份不在了", async (tx: string) => { await rm(join(tx, "backups", DRAFT)); }],
  ])("AG1 老格式退不下去（%s）：比它先开工的核心事务不退，现在的稿 C 一个字不动，写命令挡着、重开也挡着", async (_label, breakIt) => {
    // 核心先开工：新建工作稿（之前没有）写 B，被杀。
    await rm(join(book, DRAFT));
    const tx = join(book, ".story-core-tx", "created-b");
    await mkdir(join(tx, "backup"), { recursive: true });
    await mkdir(join(tx, "staged"), { recursive: true });
    const b = composeDraftFile({ title: "B", body: "核心写的 B。" });
    await writeFile(join(book, DRAFT), b);
    await writeFile(join(tx, "manifest.json"), JSON.stringify({ schema: "story-core-tx/1", id: "created-b", createdAt: "2026-10-18T00:00:00.000Z", status: "prepared", files: [{ path: DRAFT, slot: "0", existed: false, wrote: sha(b) }] }));
    // 老格式后开工：备份 B；现在盘上是 C。
    const legacyTx = await legacyResidue(b, "2026-10-28T00:00:00.000Z");
    const c = composeDraftFile({ title: "C", body: "现在的稿 C。" });
    await writeFile(join(book, DRAFT), c);
    await breakIt(legacyTx);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const error = await recoverBookTransactions(book).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(LegacyResidueError);
      expect(await read(DRAFT)).toBe(c);
      expect(await hasPendingTransactions(book)).toBe(true);
      expect(JSON.parse(await readFile(join(legacyTx, "manifest.json"), "utf-8"))).toMatchObject({ status: "staged" });
      const saved = await runCommand(book, draftSave, { chapter: 1, title: "新", body: "新。", baseVersion: (await readDraftState(book, 1)).version }, { caller: "author" });
      expect(saved).toMatchObject({ ok: false, code: "transaction_residue" });
      expect(await read(DRAFT)).toBe(c);
    }
  });

  it("AG2 核心先开工、老格式后开工：退完工作稿版本和恢复前都不一样，照恢复前版本发的旧存稿撞版本、不盖回去", async () => {
    const aVersion = (await readDraftState(book, 1)).version;
    await coreResidue("earlier-core", "2026-10-18T00:00:00.000Z", { gens: await read(GENS), draft: await read(DRAFT) });
    await liveDraft("核心中断名 B", "核心中断正文 B。");
    const bVersion = (await readDraftState(book, 1)).version;
    await legacyResidue(await read(DRAFT), "2026-10-28T00:00:00.000Z");
    await writeFile(join(book, DRAFT), composeDraftFile({ title: "老事务中断名 C", body: "老事务中断正文 C。" }));

    await recoverBookTransactions(book);
    const after = await readDraftState(book, 1);
    expect(await readDraft(book, 1)).toMatchObject({ title: "作者原名", body: "作者成功保存的 A。" });
    expect(after.version).not.toBe(aVersion);
    expect(after.version).not.toBe(bVersion);
    for (const stale of [aVersion, bVersion]) {
      const saved = await runCommand(book, draftSave, { chapter: 1, title: "迟到", body: "迟到的旧存稿。", baseVersion: stale }, { caller: "author" });
      expect(saved).toMatchObject({ ok: false, code: "draft_conflict" });
    }
    expect(await readDraft(book, 1)).toMatchObject({ body: "作者成功保存的 A。" });
  });

  it("核心事务清单记着写了什么：盘上的正是这次写的，退回不另存", async () => {
    const before = { gens: await read(GENS), draft: await read(DRAFT) };
    await liveDraft("半截", "半截。");
    const half = await read(DRAFT);
    const tx = join(book, ".story-core-tx", "own-write");
    await mkdir(join(tx, "backup"), { recursive: true });
    await mkdir(join(tx, "staged"), { recursive: true });
    await writeFile(join(tx, "backup", "0"), before.gens);
    await writeFile(join(tx, "backup", "1"), before.draft);
    await writeFile(join(tx, "manifest.json"), JSON.stringify({
      schema: "story-core-tx/1", id: "own-write", createdAt: new Date().toISOString(), status: "prepared",
      files: [{ path: GENS, slot: "0", existed: true, wrote: sha(await read(GENS)) }, { path: DRAFT, slot: "1", existed: true, wrote: sha(half) }],
    }));

    expect(await recoverBookTransactions(book)).toMatchObject({ rolledBack: ["own-write"] });
    expect(await readDraft(book, 1)).toMatchObject({ body: "作者成功保存的 A。" });
    expect(await savedCopies()).toEqual([]);
  });
});

describe("AH 第 20 轮：另存只认存妥了的、分事务实例；老格式代次换新纪元；清单整份换上", () => {
  const c = composeDraftFile({ title: "作者后来的名 C", body: "作者后来存下的整份 C。" });
  const a = (): Promise<string> => read(DRAFT);
  const savedDir = (): string => join(book, ".story-core-saved");
  const savedNames = async (): Promise<string[]> => (await readdir(savedDir()).catch(() => [] as string[])).filter((name) => name.endsWith(".json"));
  const keptC = async (): Promise<boolean> => (await listSavedDrafts(book, 1)).some((copy) => copy.title === "作者后来的名 C" && copy.body === "作者后来存下的整份 C。");

  /** 一份比现在的稿旧的残留（备份 A），盘上是之后存下的 C。同样的参数造出来的是同一份事务实例。 */
  async function staleResidue(kind: "core" | "legacy", previous: string): Promise<string> {
    let tx: string;
    if (kind === "legacy") tx = await legacyResidue(previous, "2026-10-18T00:00:00.000Z");
    else {
      tx = join(book, ".story-core-tx", "stale-core");
      await mkdir(join(tx, "backup"), { recursive: true });
      await mkdir(join(tx, "staged"), { recursive: true });
      await writeFile(join(tx, "backup", "0"), previous);
      await writeFile(join(tx, "manifest.json"), JSON.stringify({ schema: "story-core-tx/1", id: "stale-core", createdAt: "2026-10-18T00:00:00.000Z", status: "prepared", files: [{ path: DRAFT, slot: "0", existed: true }] }));
    }
    await writeFile(join(book, DRAFT), c);
    return tx;
  }

  /** 先真跑一遍，记下这份副本落在哪个号；再把书摆回恢复前（同一份事务实例、同样的 C），另存区清空。 */
  async function primaryName(kind: "core" | "legacy"): Promise<string> {
    const previous = await a();
    await staleResidue(kind, previous);
    await recoverBookTransactions(book);
    const [name] = await savedNames();
    expect(name).toMatch(/^kept-[0-9a-f]{20}\.json$/u);
    await rm(savedDir(), { recursive: true, force: true });
    await staleResidue(kind, previous);
    return name!;
  }

  it.each((["core", "legacy"] as const).flatMap((kind) => (["目录", "坏 JSON", "断了的软链", "原文对不上"] as const).map((obstacle) => [kind, obstacle] as const)))(
    "AH1 %s：号被%s占着，不当存过——另起一个号存下 C，退回 A",
    async (kind, obstacle) => {
      const name = await primaryName(kind);
      const target = join(savedDir(), name);
      await mkdir(savedDir(), { recursive: true });
      if (obstacle === "目录") await mkdir(target);
      else if (obstacle === "坏 JSON") await writeFile(target, "{");
      else if (obstacle === "断了的软链") await symlink(join(root, "不在的副本"), target);
      else await writeFile(target, JSON.stringify({ schema: "story-core-saved/1", id: name.slice(0, -5), path: DRAFT, content: "错位的另一份。", sha: sha(c), from: "x", savedAt: "2026-10-20T00:00:00.000Z" }));

      expect(await recoverBookTransactions(book)).toMatchObject({ problems: [] });
      expect(await readDraft(book, 1)).toMatchObject({ body: "作者成功保存的 A。" });
      expect(await keptC()).toBe(true);
      expect(await hasPendingTransactions(book)).toBe(false);
    },
  );

  it.each(["core", "legacy"] as const)("AH1 %s：同一份事务实例存妥了的，重来不存第二份", async (kind) => {
    const previous = await a();
    await staleResidue(kind, previous);
    await recoverBookTransactions(book);
    const first = await savedNames();
    // 被杀在换回之前：事务还在、盘上还是 C、副本已存。
    await staleResidue(kind, previous);
    await recoverBookTransactions(book);
    expect(await savedNames()).toEqual(first);
    expect(await keptC()).toBe(true);
  });

  it.each(["core", "legacy"] as const)("AH3 %s：上一回作者「不要了」的那份不吞掉这一回的 C（同一份清单也不行）", async (kind) => {
    const previous = await a();
    await staleResidue(kind, previous);
    await recoverBookTransactions(book);
    const [copy] = await listSavedDrafts(book, 1);
    await settleSavedCopy(book, copy!.id);
    expect(await keptC()).toBe(false);

    await staleResidue(kind, previous);
    await recoverBookTransactions(book);
    expect(await readDraft(book, 1)).toMatchObject({ body: "作者成功保存的 A。" });
    expect(await keptC()).toBe(true);
  });

  it("AH3 老格式按章号起名，同一章的新一份残留（开工时间不同）另算一份", async () => {
    const previous = await a();
    const tx = await staleResidue("legacy", previous);
    await recoverBookTransactions(book);
    const [copy] = await listSavedDrafts(book, 1);
    await settleSavedCopy(book, copy!.id);

    const manifest = JSON.parse(await readFile(join(tx, "manifest.json"), "utf-8")) as Record<string, unknown>;
    await writeFile(join(tx, "manifest.json"), JSON.stringify({ ...manifest, createdAt: "2026-10-25T00:00:00.000Z", status: "staged" }));
    await writeFile(join(book, DRAFT), c);
    await recoverBookTransactions(book);
    expect(await keptC()).toBe(true);
  });

  it("AH2 老格式清单只有工作稿代次：退完整本换新纪元，恢复前的版本存不上", async () => {
    const gens = await read(GENS);
    const tx = join(book, ".story-engine-tx", "commit-chapter-0001");
    await mkdir(join(tx, "backups", "store-control"), { recursive: true });
    await writeFile(join(tx, "backups", GENS), gens);
    await writeFile(join(tx, "manifest.json"), JSON.stringify({
      version: 2, chapter: 1, createdAt: "2026-10-18T00:00:00.000Z", files: [GENS],
      backups: [{ relativePath: GENS, existed: true, backupPath: join("backups", GENS), sha256: sha(gens) }],
      status: "staged",
    }));
    const interrupted = JSON.parse(gens) as Record<string, unknown>;
    await writeFile(join(book, GENS), JSON.stringify({ ...interrupted, epoch: "写到一半的纪元" }));
    const before = (await readDraftState(book, 1)).version;

    await recoverBookTransactions(book);
    expect((await readDraftState(book, 1)).version).not.toBe(before);
    const stale = await runCommand(book, draftSave, { chapter: 1, title: "迟到", body: "恢复前的旧存稿。", baseVersion: before }, { caller: "author" });
    expect(stale).toMatchObject({ ok: false, code: "draft_conflict" });
    expect(await readDraft(book, 1)).toMatchObject({ body: "作者成功保存的 A。" });
  });

  it("AH4 老清单收尾换上前失败：清单还是整份 staged（不清空），没留临时文件，重来收尾成", async () => {
    const tx = await staleResidue("legacy", await a());
    const manifestPath = join(tx, "manifest.json");
    const before = await readFile(manifestPath, "utf-8");
    setLegacyTxIoHookForTests((phase, target) => {
      if (phase === "after-open-before-verify" && target === manifestPath) throw Object.assign(new Error("写到一半被打断"), { code: "EIO" });
    });
    expect(await recoverBookTransactions(book).catch((error: unknown) => error)).toBeInstanceOf(LegacyResidueError);
    expect(await readFile(manifestPath, "utf-8")).toBe(before);
    expect((await readdir(tx)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(await hasPendingTransactions(book)).toBe(true);

    setLegacyTxIoHookForTests(undefined);
    await recoverBookTransactions(book);
    expect(JSON.parse(await readFile(manifestPath, "utf-8"))).toMatchObject({ status: "recovered" });
    expect(await hasPendingTransactions(book)).toBe(false);
    expect(await keptC()).toBe(true);
  });

  it("AH4 被杀时留下的临时清单不挡下一次恢复", async () => {
    const tx = await staleResidue("legacy", await a());
    await writeFile(join(tx, ".manifest.json.0123456789ab.tmp"), "{");
    await recoverBookTransactions(book);
    expect(JSON.parse(await readFile(join(tx, "manifest.json"), "utf-8"))).toMatchObject({ status: "recovered" });
    expect(await hasPendingTransactions(book)).toBe(false);
  });
});
