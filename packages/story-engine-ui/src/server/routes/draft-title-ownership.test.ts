// @vitest-environment node
/**
 * 章名归作者（写作版本 P1 第 16 轮 AD1–AD3）：只换掉模型网络，真写手、候选、HTTP 路由、核心都不 mock。
 * - AD1 写手没起名就是没起名：写手的稿不带章名，换上时沿用作者的，不补「第N章」盖掉它（P2a 片 2D：换上走 draft.adopt，
 *   「沿用作者的」在 `readAdoptable` 里，见 candidate-adopt.test.ts）。
 * - AD2 章名里的换行（含单独的 \r）收成空格，不串进正文。
 * - AD3 存稿先收拾完上次没写完的事务再读盘：旧页面沿用的章名是回滚后的。
 * - AE1 只写了章号（换个写法：「第1章：」「第 1 章」「第一〇一章」……）也算没起名（第 17 轮）。
 * - AE2 存稿连升级前的老格式事务一起先收拾（第 17 轮）。
 * - AE3 AI 换稿先收拾事务、再核写的时候用过的材料（第 17 轮）。
 * - AF3 Markdown 标题的闭合井号（`# 第一章 #`）不算章名，名字中间、贴着字的井号留着（第 18 轮）。
 */
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bareChapterName, composeDraftFile, draftPath, draftSave, readDraft, readDraftState, readTruthBasis, recoverBookTransactions, runCommand } from "@actalk/story-core";
import { createConfiguredWriterClient } from "../writing/writer-client.js";
import { runFastDraft } from "../writing/fast-draft-writer.js";
import { ensureBookOnCore } from "../book/mirror/ensure.js";
import { readMaterialWorld } from "../book/material-reads.js";
import { applyAiDraft } from "../lib/ai-draft-write.js";
import { readDraftCandidate, readDraftRecovery } from "../lib/draft-candidates.js";
import { createStoryProject } from "../book/project-store.js";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import type { Middleware } from "../lib/project-io.js";
import { registerWorkingDraftRoutes } from "./working-draft.js";

const model = vi.hoisted(() => ({ text: "" }));
vi.mock("../lib/llm-client.js", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  streamChatModelToText: vi.fn(async () => ({ content: model.text })),
}));
vi.mock("../writing/writer-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../writing/writer-client.js")>();
  return { ...actual, createConfiguredWriterClient: vi.fn(async () => actual.createOpenAICompatibleWriterClient({ profile: { temperature: 0.8 } } as never)) };
});

let root: string;
let book: string;
beforeEach(async () => {
  root = await makeHomeTempDir("draft-title-");
  ({ projectDir: book } = await createStoryProject({ rootDir: root, title: "章名", genre: "都市", protagonistName: "林远" }));
  model.text = "林远推开门，拿起桌上的信。\n\n他认出了纸上的字，转身去找寄信人。\n\n街上的店铺刚开门，送信的人已经走远了。";
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function call(url: string, body: Record<string, unknown>, method = "POST"): Promise<{ status: number; payload: Record<string, unknown> }> {
  const handlers: Middleware[] = [];
  registerWorkingDraftRoutes({ use: (handler) => handlers.push(handler) });
  const chunks: Buffer[] = [];
  const res = { statusCode: 200, setHeader() { return res; }, end(chunk?: string | Buffer) { if (chunk) chunks.push(Buffer.from(chunk)); return res; } } as unknown as ServerResponse;
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method, url }) as IncomingMessage;
  await handlers[0]!(req, res, () => { throw new Error("没进路由"); });
  return { status: res.statusCode, payload: JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown> };
}

/** 真写手写一稿（模型网络换成 model.text）：写手起的章名、去掉章名行的正文。 */
async function write(): Promise<{ readonly title?: string; readonly body: string }> {
  const report = await runFastDraft({ projectDir: book, chapter: 1, chapterGoal: "林远收到一封信。", writerClient: await createConfiguredWriterClient("fastDraft"), selectedCharacters: ["林远"], requestedDraftLength: 500 });
  expect(report.passed).toBe(true);
  return { ...(report.title ? { title: report.title } : {}), body: report.draftBody ?? "" };
}

async function save(title: string, body = "作者原正文。"): Promise<void> {
  const result = await runCommand(book, draftSave, { chapter: 1, title, body, baseVersion: (await readDraftState(book, 1)).version }, { caller: "author" });
  expect(result.ok).toBe(true);
}

describe("AD1 写手没起名：不补「第N章」", () => {
  it("写手只回正文：没有章名", async () => {
    const written = await write();
    expect(written.title).toBeUndefined();
    expect(written.body).toContain("林远推开门");
  });

  it("写手在正文开头起了名：统一成本章章号", async () => {
    model.text = `# 第1章 · 信到门口\n\n${model.text}`;
    const written = await write();
    expect(written.title).toBe("第1章 · 信到门口");
    expect(written.body).not.toContain("信到门口");
  });

  it("写手只写了光秃秃的「第一章」：算没起名", async () => {
    model.text = `# 第一章\n\n${model.text}`;
    const written = await write();
    expect(written.title).toBeUndefined();
    expect(written.body).not.toContain("第一章");
  });
});

describe("AD2 章名里的换行收成空格", () => {
  it.each(["前半\n后半", "前半\r\n后半", "前半\r后半", "前半 后半", "前半 后半"])("%j", async (title) => {
    const body = "# 正文第一节\n\n原正文。";
    const out = await call("/api/working-draft", { projectPath: book, chapter: 1, title, body, baseVersion: null }, "PUT");
    expect(out.status).toBe(200);
    expect(await readDraft(book, 1)).toMatchObject({ title: "前半 后半", body });
  });
});

describe("AD3 存稿先收拾完上次没写完的事务再读盘", () => {
  // P1 第 19 轮 AG2：收拾半截事务时工作稿代次只往前走（这一章换了新号），收拾前打开的页面这笔撞版本、整份进恢复稿；
  // 恢复稿里的章名是回滚后的那个（先收拾、再读盘），稿子是回滚后的那份。
  it.each([false, true])("旧页面不带章名 / 带章名（%j）：沿用的是回滚后的章名", async (explicit) => {
    await save("作者原章名");
    const baseVersion = (await readDraftState(book, 1)).version;
    // 造一份被杀进程留下的事务：两个文件已经换上（工作稿代次、工作稿），清单还是 prepared。
    const paths = ["store-control/drafts.json", "drafts/fast/chapter-0001.md"];
    const original = await Promise.all(paths.map((path) => readFile(join(book, path), "utf-8")));
    const tx = join(book, ".story-core-tx", "killed-save");
    await mkdir(join(tx, "backup"), { recursive: true });
    await mkdir(join(tx, "staged"), { recursive: true });
    for (const [slot, text] of original.entries()) await writeFile(join(tx, "backup", String(slot)), text);
    await writeFile(join(tx, "manifest.json"), JSON.stringify({ schema: "story-core-tx/1", id: "killed-save", createdAt: new Date().toISOString(), status: "prepared", files: paths.map((path, slot) => ({ path, slot: String(slot), existed: true })) }));
    const gens = JSON.parse(original[0]!) as { chapters: Record<string, string> };
    gens.chapters["1"] = "killed-save-gen";
    await writeFile(join(book, paths[0]!), JSON.stringify(gens));
    await writeFile(join(book, paths[1]!), composeDraftFile({ title: "没写完的那次的章名", body: "没写完的那次的正文。" }));

    const body = "# 作者的正文首节\n\n作者最新正文。";
    const out = await call("/api/working-draft", { projectPath: book, chapter: 1, body, baseVersion, client: "adthreeclient", seq: 1, ...(explicit ? { title: "作者原章名" } : {}) }, "PUT");
    expect(out.status).toBe(409);
    expect(out.payload.code).toBe("draft_conflict");
    expect(await readDraft(book, 1)).toMatchObject({ title: "作者原章名", body: "作者原正文。" });
    const recovery = await readDraftRecovery(book, String(out.payload.recoveryId));
    expect(recovery).toMatchObject({ title: "作者原章名", body });
  });
});

describe("AE1 只写了章号，换个写法也算没起名", () => {
  it.each(["# 第1章：", "# 第1章 ·", "# 第一章—", "# 第1 章", "# 第零一章", "# 第一〇一章", "# 第 1 章", "第 1 章"])("%j：不起名", async (heading) => {
    model.text = `${heading}\n\n${model.text}`;
    const written = await write();
    expect(written.title).toBeUndefined();
    expect(written.body).not.toMatch(/^第|^#/u);
  });

  it.each([
    ["# 第1章：雨夜", "第1章 · 雨夜"],
    ["# 第 1 章 雨夜", "第1章 · 雨夜"],
    ["# 第九章 · 雨夜", "第1章 · 雨夜"],
    ["# 雨夜", "第1章 · 雨夜"],
    ["# 第三章的秘密", "第1章 · 第三章的秘密"],
  ])("%j：起了名，统一成本章章号", async (heading, expected) => {
    model.text = `${heading}\n\n${model.text}`;
    expect((await write()).title).toBe(expected);
  });

  it.each(["# 第一章 #", "## 第 1 章 ##", "# 第１２章： ###", "### 第1章 #"])("AF3 闭合井号 %j：不起名", async (heading) => {
    model.text = `${heading}\n\n${model.text}`;
    const written = await write();
    expect(written.title).toBeUndefined();
    expect(written.body).not.toMatch(/^第|^#/u);
  });

  it.each([
    ["# 第1章 雨夜 #", "第1章 · 雨夜"],
    ["## 雨夜 ##", "第1章 · 雨夜"],
    ["# 第1章 · 门后的 # 号", "第1章 · 门后的 # 号"],
    ["# 第1章 · 井号#", "第1章 · 井号#"],
    ["# C# 入门", "第1章 · C# 入门"],
  ])("AF3 %j：闭合井号去掉，名字里的井号留着", async (heading, expected) => {
    model.text = `${heading}\n\n${model.text}`;
    const written = await write();
    expect(written.title).toBe(expected);
    expect(written.body).not.toMatch(/^#/u);
  });

  it("核心同一条规则：剥章号、连着几次的也剥", () => {
    expect(bareChapterName("第1章 · 第1章 · 雨夜")).toBe("雨夜");
    expect(bareChapterName("第１２章｜雨夜")).toBe("雨夜");
    expect(bareChapterName("第两百章")).toBe("");
    expect(bareChapterName("第三章的秘密")).toBe("第三章的秘密");
  });
});

/** 照老定稿链写盘的格式造一份没写完的事务：备份了工作稿原样，清单 staged。 */
async function writeLegacyResidue(previous: string): Promise<void> {
  const relativePath = draftPath(1);
  const tx = join(book, ".story-engine-tx", "commit-chapter-0001");
  const backupPath = join("backups", relativePath);
  await mkdir(join(tx, backupPath, ".."), { recursive: true });
  await writeFile(join(tx, backupPath), previous, "utf-8");
  await writeFile(join(tx, "manifest.json"), JSON.stringify({
    version: 2,
    chapter: 1,
    createdAt: "2026-07-13T00:00:00.000Z",
    files: [relativePath],
    backups: [{ relativePath, existed: true, backupPath, sha256: createHash("sha256").update(previous, "utf-8").digest("hex") }],
    status: "staged",
  }), "utf-8");
}

describe("AE2 存稿连老格式事务一起先收拾", () => {
  it.each([
    ["稿已换成没写完的那版", true],
    ["备份写了、稿还没换", false],
  ])("%s：存的这笔撞版本留成恢复稿，之后开书回滚也丢不了", async (_label, swapped) => {
    await save("作者原章名", "原正文 A。");
    const baseVersion = (await readDraftState(book, 1)).version;
    const original = await readFile(join(book, draftPath(1)), "utf-8");
    await writeLegacyResidue(original);
    if (swapped) await writeFile(join(book, draftPath(1)), composeDraftFile({ title: "没写完的章名", body: "没写完的正文 B。" }));

    const out = await call("/api/working-draft", { projectPath: book, chapter: 1, title: "作者原章名", body: "作者新写的 C。", baseVersion }, "PUT");
    expect(out.status).toBe(409);
    expect(await readDraftRecovery(book, String(out.payload.recoveryId))).toMatchObject({ body: "作者新写的 C。" });
    expect(await readDraft(book, 1)).toMatchObject({ title: "作者原章名", body: "原正文 A。" });
    // 之后开书再收拾一遍：没有要回滚的了，作者那笔照样在恢复稿里。
    await ensureBookOnCore(book);
    expect(await readDraft(book, 1)).toMatchObject({ body: "原正文 A。" });
    expect(await readDraftRecovery(book, String(out.payload.recoveryId))).toMatchObject({ body: "作者新写的 C。" });
  });
});

describe("AE3 AI 换稿先收拾事务，再核写的时候用过的材料", () => {
  it("前一章正写断在半路（工作稿事务，不换真相代次）：照半截那版写的不换上、留成候选", async () => {
    await save("", "口令是白鹤。");
    // 造一份被杀进程留下的前一章存稿事务：工作稿代次、工作稿都已换上，清单还是 prepared。
    const paths = ["store-control/drafts.json", draftPath(1)];
    const original = await Promise.all(paths.map((path) => readFile(join(book, path), "utf-8")));
    const tx = join(book, ".story-core-tx", "killed-save");
    await mkdir(join(tx, "backup"), { recursive: true });
    await mkdir(join(tx, "staged"), { recursive: true });
    for (const [slot, text] of original.entries()) await writeFile(join(tx, "backup", String(slot)), text);
    await writeFile(join(tx, "manifest.json"), JSON.stringify({ schema: "story-core-tx/1", id: "killed-save", createdAt: new Date().toISOString(), status: "prepared", files: paths.map((path, slot) => ({ path, slot: String(slot), existed: true })) }));
    const gens = JSON.parse(original[0]!) as { chapters: Record<string, string> };
    gens.chapters["1"] = "killed-save-gen";
    await writeFile(join(book, paths[0]!), JSON.stringify(gens));
    await writeFile(join(book, paths[1]!), composeDraftFile({ title: "", body: "口令是青鹭。" }));

    // 写手开工：依据、材料都照半截那版读。
    const basis = await readTruthBasis(book);
    const materials = await readMaterialWorld(book, 2);
    const outcome = await applyAiDraft(book, { chapter: 2, title: "", body: "他报出口令：青鹭。", baseVersion: null, basis, materials, source: "draft" });
    expect(outcome).toMatchObject({ applied: false, reason: "basis_moved" });
    expect(await readDraft(book, 1)).toMatchObject({ body: "口令是白鹤。" });
    expect(await readDraft(book, 2)).toBeUndefined();
    if (!outcome.applied) expect(await readDraftCandidate(book, outcome.candidateId)).toMatchObject({ body: "他报出口令：青鹭。" });
  });
});

describe("AG3 收拾半截事务时另存的稿：稿纸上找得回、不要了就不再提示", () => {
  async function residueOverC(): Promise<string> {
    await save("作者原章名", "作者原正文 A。");
    const a = await readFile(join(book, draftPath(1)), "utf-8");
    const tx = join(book, ".story-engine-tx", "commit-chapter-0001");
    await mkdir(join(tx, "backups", "drafts", "fast"), { recursive: true });
    await writeFile(join(tx, "backups", draftPath(1)), a);
    await writeFile(join(tx, "manifest.json"), JSON.stringify({
      version: 2, chapter: 1, createdAt: "2026-10-18T00:00:00.000Z", files: [draftPath(1)],
      backups: [{ relativePath: draftPath(1), existed: true, backupPath: join("backups", draftPath(1)), sha256: createHash("sha256").update(a, "utf-8").digest("hex") }],
      status: "staged",
    }));
    // 老版本没收拾残留就让作者存下了 C。
    await writeFile(join(book, draftPath(1)), composeDraftFile({ title: "后来的章名", body: "后来存下的 C。" }));
    expect((await recoverBookTransactions(book)).problems).toEqual([]);
    return a;
  }

  async function pendingOnPaper(): Promise<Record<string, unknown> | undefined> {
    const handlers: Middleware[] = [];
    registerWorkingDraftRoutes({ use: (handler) => handlers.push(handler) });
    const chunks: Buffer[] = [];
    const res = { statusCode: 200, setHeader() { return res; }, end(chunk?: string | Buffer) { if (chunk) chunks.push(Buffer.from(chunk)); return res; } } as unknown as ServerResponse;
    const req = Object.assign(Readable.from([]), { method: "GET", url: `/api/working-draft?project=${encodeURIComponent(book)}&chapter=1` }) as IncomingMessage;
    await handlers[0]!(req, res, () => { throw new Error("没进路由"); });
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as { paper: { pending?: Record<string, unknown> } };
    return payload.paper.pending;
  }

  it("找回：换上另存的那份（章名一起），之后不再提示", async () => {
    await residueOverC();
    const pending = await pendingOnPaper();
    expect(pending).toMatchObject({ kind: "recovery", title: "后来的章名", body: "后来存下的 C。" });
    expect(String(pending!.id)).toMatch(/^kept-/u);
    const adopted = await call("/api/working-draft/pending", { projectPath: book, chapter: 1, kind: "recovery", id: pending!.id, sha: pending!.sha, decision: "adopt", baseVersion: (await readDraftState(book, 1)).version });
    expect(adopted.status).toBe(200);
    expect(await readDraft(book, 1)).toMatchObject({ title: "后来的章名", body: "后来存下的 C。" });
    expect(await pendingOnPaper()).toBeUndefined();
  });

  it("另存区被换成书外目录的软链（P1 第 21 轮 AI1）：稿纸上不提示，找回不换", async () => {
    await residueOverC();
    const pending = (await pendingOnPaper())!;
    const movedOut = join(root, "saved-outside");
    await rename(join(book, ".story-core-saved"), movedOut);
    await symlink(movedOut, join(book, ".story-core-saved"));
    expect(await pendingOnPaper()).toBeUndefined();
    const adopted = await call("/api/working-draft/pending", { projectPath: book, chapter: 1, kind: "recovery", id: pending.id, sha: pending.sha, decision: "adopt", baseVersion: (await readDraftState(book, 1)).version });
    expect(adopted.status).toBe(404);
    expect(await readDraft(book, 1)).toMatchObject({ title: "作者原章名", body: "作者原正文 A。" });
  });

  it("换上了、清掉那一份没成：回成功并如实说那一份还在", async () => {
    await residueOverC();
    const pending = (await pendingOnPaper())!;
    await chmod(join(book, ".story-core-saved"), 0o500);
    try {
      const adopted = await call("/api/working-draft/pending", { projectPath: book, chapter: 1, kind: "recovery", id: pending.id, sha: pending.sha, decision: "adopt", baseVersion: (await readDraftState(book, 1)).version });
      expect(adopted.status).toBe(200);
      expect(String(adopted.payload.warning)).toMatch(/^换好了，但那一份没清掉/u);
      expect(String(adopted.payload.warning)).not.toContain(root);
      expect(await readDraft(book, 1)).toMatchObject({ title: "后来的章名", body: "后来存下的 C。" });
    } finally {
      await chmod(join(book, ".story-core-saved"), 0o700);
    }
  });

  it("不要了：指纹对得上才清；清了不再提示，稿子不动", async () => {
    await residueOverC();
    const pending = (await pendingOnPaper())!;
    const wrong = await call("/api/working-draft/pending", { projectPath: book, chapter: 1, kind: "recovery", id: pending.id, sha: "不对", decision: "dismiss" });
    expect(wrong.status).toBe(409);
    const dismissed = await call("/api/working-draft/pending", { projectPath: book, chapter: 1, kind: "recovery", id: pending.id, sha: pending.sha, decision: "dismiss" });
    expect(dismissed.status).toBe(200);
    expect(await pendingOnPaper()).toBeUndefined();
    expect(await readDraft(book, 1)).toMatchObject({ title: "作者原章名", body: "作者原正文 A。" });
  });
});
