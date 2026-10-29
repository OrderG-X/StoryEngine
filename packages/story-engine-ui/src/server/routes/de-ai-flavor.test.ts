import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import type { Middleware } from "../lib/project-io.js";

const llmMocks = vi.hoisted(() => ({
  resolveConfiguredChatModel: vi.fn(),
  streamChatModelToText: vi.fn(),
}));
const snapshotMocks = vi.hoisted(() => ({ createSnapshot: vi.fn() }));

vi.mock("../lib/llm-client.js", () => ({
  resolveConfiguredChatModel: llmMocks.resolveConfiguredChatModel,
  streamChatModelToText: llmMocks.streamChatModelToText,
}));
vi.mock("../lib/snapshot.js", () => ({
  createSnapshot: snapshotMocks.createSnapshot,
  // 写作版本 P1b：改写走 AI 写稿唯一通道，换上前（真要写才）打存档点：mock 经 createSnapshot 建「快照」。
  runWithLazySnapshot: async (
    projectDir: string,
    fn: (snapshot: (label: string, command: string) => Promise<void>) => Promise<unknown>,
    fixedLabel?: string,
  ) => {
    let id: string | undefined;
    const result = await fn(async (label) => {
      if (id) return;
      id = ((await snapshotMocks.createSnapshot(projectDir, fixedLabel ?? label)) as { id: string }).id;
    });
    return { ...(id ? { snapshotId: id } : {}), result };
  },
}));

const { registerDeAiFlavorRoutes } = await import("./de-ai-flavor.js");

let projectDir: string;

async function makeProject(draftBody: string): Promise<void> {
  projectDir = await makeHomeTempDir("story-engine-ui-deai-");
  await writeFile(join(projectDir, "project.json"), JSON.stringify({ title: "测试书" }), "utf-8");
  for (const d of ["story", "timeline", "world", "characters", "drafts", "drafts/fast"]) {
    await mkdir(join(projectDir, d), { recursive: true });
  }
  await writeFile(join(projectDir, "drafts/fast/chapter-0001.md"), draftBody, "utf-8");
  await writeFile(join(projectDir, "story/writing-rules.json"), JSON.stringify({ doNotDo: ["不要写流水账"] }), "utf-8");
}

beforeEach(() => {
  llmMocks.resolveConfiguredChatModel.mockResolvedValue({ profile: { id: "p", model: "m", temperature: 0.3 } });
  snapshotMocks.createSnapshot.mockResolvedValue({ id: "snap-1" });
});
afterEach(async () => {
  vi.clearAllMocks();
  if (projectDir) await rm(projectDir, { recursive: true, force: true });
});

async function call(body: Record<string, unknown>): Promise<{ statusCode: number; payload: Record<string, unknown> }> {
  const handlers: Middleware[] = [];
  registerDeAiFlavorRoutes({ use: (h) => handlers.push(h) });
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: "POST", url: "/api/draft/de-ai-flavor/apply",
  }) as IncomingMessage;
  const chunks: Buffer[] = [];
  const res = {
    statusCode: 200,
    setHeader: () => res as unknown as ServerResponse,
    end: (chunk?: string | Buffer) => { if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); return res as unknown as ServerResponse; },
  } as unknown as ServerResponse;
  await new Promise<void>((resolve, reject) => {
    const r = handlers[0]?.(req, res, (e?: unknown) => (e ? reject(e) : resolve())) as unknown;
    Promise.resolve(r).then(() => resolve(), reject);
  });
  return { statusCode: res.statusCode, payload: JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown> };
}

describe("POST /api/draft/de-ai-flavor/apply · 一键全修端点", () => {
  it("批量改写 → 落盘更新草稿 + 建快照 + 诚实回报 changes", async () => {
    await makeProject("他深吸一口气，压下怒火。\n窗外，带着潮湿的风。");
    llmMocks.streamChatModelToText.mockResolvedValue({ content: JSON.stringify({ rewrites: [
      { text: "他深吸一口气，压下怒火。", afterText: "他胸口起伏了一下。" },
      { text: "窗外，带着潮湿的风。", afterText: "窗外刮着湿风。" },
    ] }) });
    const { statusCode, payload } = await call({
      projectPath: projectDir, chapter: 1, confirm: true,
      violations: [
        { id: "a", text: "他深吸一口气，压下怒火。", reason: "动作套路", severity: "medium", suggestedFix: "换具体反应" },
        { id: "b", text: "窗外，带着潮湿的风。", reason: "万能状语", severity: "low" },
      ],
    });
    expect(statusCode).toBe(200);
    expect(payload.ok).toBe(true);
    const result = payload.result as Record<string, unknown>;
    expect(result.detected).toBe(2);
    expect(result.rewritten).toBe(2);
    expect((result.changes as unknown[]).length).toBe(2);
    expect(snapshotMocks.createSnapshot).toHaveBeenCalledTimes(1);
    const onDisk = await readFile(join(projectDir, "drafts/fast/chapter-0001.md"), "utf-8");
    expect(onDisk).toContain("他胸口起伏了一下。");
    expect(onDisk).toContain("窗外刮着湿风。");
    expect(onDisk).not.toContain("深吸一口气");
  });

  it("模型一处没给改写 → 诚实计 skipped、只改能改的、不谎报全改", async () => {
    await makeProject("他深吸一口气，压下怒火。\n窗外，带着潮湿的风。");
    llmMocks.streamChatModelToText.mockResolvedValue({ content: JSON.stringify({ rewrites: [
      { text: "他深吸一口气，压下怒火。", afterText: "他胸口起伏了一下。" },
    ] }) });
    const { payload } = await call({
      projectPath: projectDir, chapter: 1, confirm: true,
      violations: [
        { id: "a", text: "他深吸一口气，压下怒火。", reason: "x", severity: "medium" },
        { id: "b", text: "窗外，带着潮湿的风。", reason: "y", severity: "low" },
      ],
    });
    const result = payload.result as Record<string, unknown>;
    expect(result.rewritten).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it("一处都没改成 → 不建快照、不写盘、诚实回报", async () => {
    await makeProject("他深吸一口气，压下怒火。");
    llmMocks.streamChatModelToText.mockResolvedValue({ content: "{}" });
    const { payload } = await call({
      projectPath: projectDir, chapter: 1, confirm: true,
      violations: [{ id: "a", text: "他深吸一口气，压下怒火。", reason: "x", severity: "medium" }],
    });
    const result = payload.result as Record<string, unknown>;
    expect(result.rewritten).toBe(0);
    expect(snapshotMocks.createSnapshot).not.toHaveBeenCalled();
    const onDisk = await readFile(join(projectDir, "drafts/fast/chapter-0001.md"), "utf-8");
    expect(onDisk).toContain("他深吸一口气，压下怒火。"); // 原稿没动
  });

  it("改写的途中作者存了稿 → 不换上、如实说（409 draft_kept），AI 那版留成候选，作者那份不动", async () => {
    await makeProject("他深吸一口气，压下怒火。");
    llmMocks.streamChatModelToText.mockImplementation(async () => {
      await writeFile(join(projectDir, "drafts/fast/chapter-0001.md"), "作者在这期间存的。\n", "utf-8");
      return { content: JSON.stringify({ rewrites: [{ text: "他深吸一口气，压下怒火。", afterText: "他胸口起伏了一下。" }] }) };
    });
    const { statusCode, payload } = await call({
      projectPath: projectDir, chapter: 1, confirm: true,
      violations: [{ id: "a", text: "他深吸一口气，压下怒火。", reason: "x", severity: "medium" }],
    });
    expect(statusCode).toBe(409);
    expect(payload).toMatchObject({ ok: false, code: "draft_kept" });
    expect(String(payload.error)).toContain("AI 这版没换上");
    expect(snapshotMocks.createSnapshot).not.toHaveBeenCalled();
    expect(await readFile(join(projectDir, "drafts/fast/chapter-0001.md"), "utf-8")).toBe("作者在这期间存的。\n");
    const candidate = JSON.parse(await readFile(join(projectDir, "agents/drafts/candidates", `${String(payload.candidateId)}.json`), "utf-8")) as { body: string; reason: string };
    expect(candidate).toMatchObject({ body: "他胸口起伏了一下。", reason: "draft_moved" });
  });

  it("confirm 不为 true → 400 拒绝", async () => {
    await makeProject("正文。");
    const { statusCode, payload } = await call({ projectPath: projectDir, chapter: 1, violations: [] });
    expect(statusCode).toBe(400);
    expect(payload.ok).toBe(false);
  });
});
