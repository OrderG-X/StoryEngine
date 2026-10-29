// @vitest-environment node
/**
 * 章名归作者（写作版本 P1 第 16 轮 AD1–AD3）：只换掉模型网络，真写手、候选、HTTP 路由、核心都不 mock。
 * - AD1 写手没起名就是没起名：「另写几版」不带章名，选用时沿用作者的，不补「第N章」盖掉它。
 * - AD2 章名里的换行（含单独的 \r）收成空格，不串进正文。
 * - AD3 存稿先收拾完上次没写完的事务再读盘：旧页面沿用的章名是回滚后的。
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composeDraftFile, draftSave, readDraft, readDraftState, runCommand } from "@actalk/story-core";
import { createStoryProject } from "../book/project-store.js";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import type { Middleware } from "../lib/project-io.js";
import { registerDraftRoutes } from "./draft.js";
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
vi.mock("../editorial/index.js", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  callConfiguredPlannerModel: vi.fn(async () => { throw new Error("这里不拟章纲"); }),
}));

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
  (url.includes("working-draft") ? registerWorkingDraftRoutes : registerDraftRoutes)({ use: (handler) => handlers.push(handler) });
  const chunks: Buffer[] = [];
  const res = { statusCode: 200, setHeader() { return res; }, end(chunk?: string | Buffer) { if (chunk) chunks.push(Buffer.from(chunk)); return res; } } as unknown as ServerResponse;
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method, url }) as IncomingMessage;
  await handlers[0]!(req, res, () => { throw new Error("没进路由"); });
  return { status: res.statusCode, payload: JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown> };
}

async function save(title: string, body = "作者原正文。"): Promise<void> {
  const result = await runCommand(book, draftSave, { chapter: 1, title, body, baseVersion: (await readDraftState(book, 1)).version }, { caller: "author" });
  expect(result.ok).toBe(true);
}

describe("AD1 写手没起名：另写几版不补「第N章」", () => {
  it.each(["", "作者保留的章名"])("原来的章名 %j 选用后照旧", async (oldTitle) => {
    await save(oldTitle);
    const generated = await call("/api/draft/generate", { projectPath: book, chapter: 1, persist: false, selectedCharacters: ["林远"], requestedDraftLength: 500 });
    expect(generated.status).toBe(200);
    expect(generated.payload.draftTitle).toBeUndefined();
    const before = (await readDraft(book, 1))!;
    // 和稿纸选用候选一样：候选没起名就用作者眼前的。
    const applied = await call("/api/draft/apply-candidate", { projectPath: book, chapter: 1, title: (generated.payload.draftTitle as string | undefined) ?? before.title ?? "", body: generated.payload.draftBody, baseVersion: before.version });
    expect(applied.status).toBe(200);
    expect((await readDraft(book, 1))?.title ?? "").toBe(oldTitle);
  });

  it("写手在正文开头起了名：照候选的章名换上", async () => {
    await save("作者旧名");
    model.text = `# 第1章 · 信到门口\n\n${model.text}`;
    const generated = await call("/api/draft/generate", { projectPath: book, chapter: 1, persist: false, selectedCharacters: ["林远"], requestedDraftLength: 500 });
    expect(generated.payload.draftTitle).toBe("第1章 · 信到门口");
    const applied = await call("/api/draft/apply-candidate", { projectPath: book, chapter: 1, title: generated.payload.draftTitle, body: generated.payload.draftBody, baseVersion: (await readDraftState(book, 1)).version });
    expect(applied.status).toBe(200);
    expect((await readDraft(book, 1))?.title).toBe("第1章 · 信到门口");
  });

  it("写手只写了光秃秃的「第1章」：算没起名", async () => {
    await save("作者的章名");
    model.text = `# 第一章\n\n${model.text}`;
    const generated = await call("/api/draft/generate", { projectPath: book, chapter: 1, persist: false, selectedCharacters: ["林远"], requestedDraftLength: 500 });
    expect(generated.status).toBe(200);
    expect(generated.payload.draftTitle).toBeUndefined();
    expect(String(generated.payload.draftBody)).not.toContain("第一章");
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
    const out = await call("/api/working-draft", { projectPath: book, chapter: 1, body, baseVersion, ...(explicit ? { title: "作者原章名" } : {}) }, "PUT");
    expect(out.status).toBe(200);
    expect(await readDraft(book, 1)).toMatchObject({ title: "作者原章名", body });
  });
});
