// @vitest-environment node
//
// agent-chat 路由级结构化动作（2026-10-07 拆补丁塔）：作者点「定稿」、卡上的「定稿」按钮 → body.action →
// 交给执行器（commit.prepare），不经模型（agent.stream 一次都不调）。真项目 + 真执行器 + 真落盘，记账员、核账员是假的。
// 「确认改设定」「确认改账」（写作版本 P2a：改设定、改账是一次操作，按钮接着那次）、梗概上直接改也在这里走真链。
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { createStoryProject } from "../book/project-store.js";
import { readStoryViews } from "../book/story-views.js";
import { cardWrite, projectBook, readCards, runCommand, type CardOp } from "@actalk/story-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { listSnapshots } from "../lib/snapshot.js";
import { restoreForTest } from "../lib/history-test-helpers.js";

const storyAgentMocks = vi.hoisted(() => ({ getStoryAgent: vi.fn() }));
vi.mock("../agent/story-agent.js", () => ({ getStoryAgent: storyAgentMocks.getStoryAgent, getStoryAgentModel: () => undefined, getStoryAgentToolNames: () => undefined }));
// 本文件测「定稿」按钮的结构化动作，不定稿后的编辑部后台预热：mock 掉 warmUpReaders，
// 别让单测真去补读笔记（R3 后三个专员常开、没有开关可关）。
const brainMocks = vi.hoisted(() => ({ warmUpReaders: vi.fn(async () => undefined) }));
vi.mock("../editorial/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../editorial/index.js")>()),
  warmUpReaders: brainMocks.warmUpReaders,
}));

import { __resetOperationStoreForTests, readOperation } from "../lib/operations/store.js";
import { __drainOperationsForTests, __resetRecipesForTests, registerRecipe, submitOperation } from "../services/operations/executor.js";
import { COMMIT_ASK_ACTION, COMMIT_PREPARE_KIND, createCommitPrepareRecipe } from "../services/operations/recipes/commit-prepare.js";
import { LEDGER_CHANGE_KIND, ledgerChangeRecipe } from "../services/operations/recipes/ledger-change.js";
import { SETTINGS_CHANGE_KIND, settingsChangeRecipe } from "../services/operations/recipes/settings-change.js";
import type { BrainCallModel } from "../editorial/reader-window.js";
import { registerAgentChatRoutes } from "./agent-chat.js";

const SENTENCE = "林远在会议室外停下脚步，反复掂量手里那份账册的分量，盘算着接下来每一步该怎么走。";
/** 假记账员：要账单就交一份（原句都在正文里），不连网。 */
const fakeKeeper: BrainCallModel = async (messages) =>
  ((messages.at(-1)?.content ?? "").includes("交这一章的账单") || (messages.at(-1)?.content ?? "").includes("只记本章东西的去向"))
    ? JSON.stringify({
        summary: { text: "林远在会议室外犹豫", quote: "林远在会议室外停下脚步" },
        presence: [{ name: "林远", nameUsed: "林远", viewpoint: true, quote: "林远在会议室外停下脚步" }],
        facts: [
          { nature: "state", subject: "账册", attribute: "在谁手里", value: "林远", text: "账册在林远手里", quote: "手里那份账册" },
          { nature: "event", text: "林远在会议室外停下脚步", quote: "林远在会议室外停下脚步" },
        ],
        threads: [],
      })
    : "笔记。";
/** 假核账员：什么都没核出来，不连网。 */
const fakeReader: BrainCallModel = async (_messages, call) => (call.json ? JSON.stringify({ checks: [], pairs: [], contradictions: [] }) : "笔记。");

interface SseEvent {
  readonly event: string;
  readonly data: Record<string, unknown>;
}

describe("agent-chat route：结构化动作「定稿」", () => {
  const rootDirs = new Set<string>();

  beforeEach(() => {
    brainMocks.warmUpReaders.mockClear();
    storyAgentMocks.getStoryAgent.mockResolvedValue({
      stream: vi.fn(async () => {
        throw new Error("结构化动作不应调用模型");
      }),
    });
  });

  afterEach(async () => {
    await __drainOperationsForTests();
    __resetRecipesForTests();
    __resetOperationStoreForTests();
    storyAgentMocks.getStoryAgent.mockReset();
    await Promise.all([...rootDirs].map((dir) => rm(dir, { recursive: true, force: true })));
    rootDirs.clear();
  });

  it("点「定稿」→ 核账、记账、定稿一路走完，一句结论 + 下一步卡；模型零调用", { timeout: 30_000 }, async () => {
    const projectDir = await makeProjectWithDraft(1);
    const { events } = await commitByButton(projectDir, 1, fakeKeeper);
    expect(textOf(events)).toBe("第 1 章定稿了。");
    expect(events.some((e) => e.event === "tool-result" && e.data.toolName === "suggest_next_steps")).toBe(true);
    expect(events.at(-1)?.event).toBe("done");
    await expect(access(join(projectDir, "chapters", "0001.md"))).resolves.toBeUndefined();
    const agent = await storyAgentMocks.getStoryAgent.mock.results[0]?.value;
    expect(agent?.stream).not.toHaveBeenCalled();
  });

  it("对话里交的定稿停在「定稿？」、书没动；点卡上的「定稿」→ 定稿落盘、一句结论；模型零调用", { timeout: 30_000 }, async () => {
    const projectDir = await makeProjectWithDraft(1);
    registerRecipe(createCommitPrepareRecipe({ callModel: fakeKeeper, readerCallModel: fakeReader, modelProblem: () => undefined }));
    const asked = await submitOperation(projectDir, {
      kind: COMMIT_PREPARE_KIND,
      params: { chapter: 1 },
      requestKey: randomUUID(),
      issuedAt: new Date().toISOString(),
      origin: { kind: "chat", messageId: randomUUID() },
    });
    if (!asked.ok || !("record" in asked)) throw new Error("没受理");
    await __drainOperationsForTests();
    expect(await readOperation(projectDir, asked.record.opId)).toMatchObject({ kind: "record", record: { state: "waiting_author" } });
    await expect(access(join(projectDir, "chapters", "0001.md"))).rejects.toThrow();

    const { handlerPromise, res } = callAgentChatRoute({
      projectPath: projectDir,
      messages: [{ role: "user", content: "定稿" }],
      action: { kind: "resume", opId: asked.record.opId, answer: { actionId: COMMIT_ASK_ACTION, decision: "commit" } },
    });
    await handlerPromise;
    await __drainOperationsForTests();
    expect(textOf(parseSse(res.written.join("")))).toContain("第 1 章定稿了。");
    await expect(access(join(projectDir, "chapters", "0001.md"))).resolves.toBeUndefined();
    const agent = await storyAgentMocks.getStoryAgent.mock.results[0]?.value;
    expect(agent?.stream).not.toHaveBeenCalled();
  });

  it("老的「确认定稿」按钮（按工具名、带票号）→ 400，不定稿", async () => {
    const projectDir = await makeProjectWithDraft(1);
    const { handlerPromise, res } = callAgentChatRoute({
      projectPath: projectDir,
      messages: [{ role: "user", content: "确认定稿第 1 章" }],
      action: { toolName: "commit_apply", chapter: 1, previewToken: "0123456789abcdef" },
    });
    await handlerPromise;
    expect(res.statusCode).toBe(400);
    await expect(access(join(projectDir, "chapters", "0001.md"))).rejects.toThrow();
  });

  it("「确认改账」：AI 提的改账停着等作者 → 点了记成作者裁定、写手读的事实跟着变；点两次只记一次；撤销点只退这一步", { timeout: 30_000 }, async () => {
    const projectDir = await makeProjectWithDraft(1);
    await commitByButton(projectDir, 1, fakeKeeper);

    registerRecipe(ledgerChangeRecipe);
    const proposal = await submitOperation(projectDir, {
      kind: LEDGER_CHANGE_KIND,
      mode: "edit",
      params: { changes: [{ op: "remove", targetText: "停下脚步" }] },
      requestKey: randomUUID(),
      issuedAt: new Date().toISOString(),
      origin: { kind: "chat", messageId: randomUUID() },
    });
    if (!proposal.ok || !("record" in proposal)) throw new Error("没受理");
    await __drainOperationsForTests();
    const opId = proposal.record.opId;
    const waiting = await readOperation(projectDir, opId);
    expect(waiting).toMatchObject({ kind: "record", record: { state: "waiting_author" } });
    const lines = waiting.kind === "record" ? (waiting.record.pendingActions[0]?.preview as { lines: string[] }).lines : [];
    expect(lines).toEqual(["删掉第 1 章记错的事实「林远在会议室外停下脚步」"]);
    expect((await projectBook(projectDir)).facts.every((fact) => fact.status !== "retracted")).toBe(true);

    const action = { kind: "resume", opId, answer: { actionId: "confirm-ledger", decision: "apply" } };
    const snapshots: number[] = [];
    for (let click = 0; click < 2; click += 1) {
      const { handlerPromise, res } = callAgentChatRoute({ projectPath: projectDir, messages: [{ role: "user", content: "确认改账" }], action });
      await handlerPromise;
      const text = parseSse(res.written.join("")).filter((e) => e.event === "text-delta").map((e) => e.data.text).join("");
      expect(text).toContain("账改好了：删掉第 1 章记错的事实「林远在会议室外停下脚步」（可撤销）。");
      expect(text).not.toMatch(/c1-|d-\d/u);
      snapshots.push((await listSnapshots(projectDir)).length);
    }
    expect(snapshots[1]).toBe(snapshots[0]);
    const view = await projectBook(projectDir);
    expect(view.facts.find((fact) => fact.text === "林远在会议室外停下脚步")?.status).toBe("retracted");
    // 写手、核账读的事实跟着变（从账现算）。
    expect((await readStoryViews(projectDir)).facts.facts.map((fact) => fact.text)).toEqual(["账册在林远手里"]);
    const agent = await storyAgentMocks.getStoryAgent.mock.results[0]?.value;
    expect(agent?.stream).not.toHaveBeenCalled();

    // 按这次改账的撤销点撤销：只退改账，第 1 章定稿还在（10-18 走查：曾把前一回合的定稿一起撤了）。
    const stored = await readOperation(projectDir, opId);
    const snapshotId = stored.kind === "record" ? (stored.record.result as { body?: { snapshotId?: string } } | undefined)?.body?.snapshotId : undefined;
    expect((await listSnapshots(projectDir)).find((entry) => entry.id === snapshotId)?.label.startsWith("core:decision.record:")).toBe(true);
    await restoreForTest(projectDir, snapshotId as string);
    const undone = await projectBook(projectDir);
    expect(undone.chapters.map((chapter) => chapter.chapter)).toEqual([1]);
    expect(undone.facts.find((fact) => fact.text === "林远在会议室外停下脚步")?.status).toBe("current");
  });

  it("梗概上「改」：直接改账（不再问），对话里如实说改好了", { timeout: 30_000 }, async () => {
    const projectDir = await makeProjectWithDraft(1);
    await commitByButton(projectDir, 1, fakeKeeper);
    registerRecipe(ledgerChangeRecipe);
    const { handlerPromise, res } = callAgentChatRoute({
      projectPath: projectDir,
      messages: [{ role: "user", content: "改第 1 章的梗概" }],
      action: { kind: "new", type: LEDGER_CHANGE_KIND, mode: "author", params: { changes: [{ op: "summary", chapter: 1, text: "林远决定先不进会议室。" }] }, requestKey: randomUUID(), issuedAt: new Date().toISOString() },
    });
    await handlerPromise;
    const text = parseSse(res.written.join("")).filter((e) => e.event === "text-delta").map((e) => e.data.text).join("");
    expect(text).toContain("账改好了：第 1 章的梗概改成：林远决定先不进会议室（可撤销）。");
    expect((await projectBook(projectDir)).chapters[0]?.summary).toBe("林远决定先不进会议室。");
  });

  it("「确认改设定」：AI 改作者写的 / 删作者建的卡整批等作者 → 作者点了按作者身份 card.write、带存档点；点两次只做一次；撤销点只退这一步", { timeout: 30_000 }, async () => {
    const projectDir = await makeProjectWithDraft(1);
    await authorWrite(projectDir, [
      { op: "field.set", card: "林远", label: "身份", value: "审计员" },
      { op: "card.create", kind: "character", name: "顾明", fields: [{ label: "身份", value: "配角" }] },
    ]);
    const card = async (name: string) => (await readCards(projectDir))?.cards.find((item) => item.name === name);

    registerRecipe(settingsChangeRecipe);
    const proposal = await submitOperation(projectDir, {
      kind: SETTINGS_CHANGE_KIND,
      params: { ops: [{ op: "field.set", card: "林远", label: "身份", value: "记者" }, { op: "card.delete", card: "顾明" }] },
      requestKey: randomUUID(),
      issuedAt: new Date().toISOString(),
      origin: { kind: "chat", messageId: randomUUID() },
    });
    if (!proposal.ok || !("record" in proposal)) throw new Error("没受理");
    await __drainOperationsForTests();
    const opId = proposal.record.opId;
    expect((await readOperation(projectDir, opId))).toMatchObject({ kind: "record", record: { state: "waiting_author" } });
    expect(await card("顾明")).toBeDefined();
    expect((await card("林远"))?.fields.find((field) => field.label === "身份")?.value).toBe("审计员");

    const action = { kind: "resume", opId, answer: { actionId: "confirm-settings", decision: "apply" } };
    const snapshots: number[] = [];
    for (let click = 0; click < 2; click += 1) {
      const { handlerPromise, res } = callAgentChatRoute({ projectPath: projectDir, messages: [{ role: "user", content: "确认改设定" }], action });
      await handlerPromise;
      const events = parseSse(res.written.join(""));
      const text = events.filter((e) => e.event === "text-delta").map((e) => e.data.text).join("");
      expect(text).toContain("改好了：「林远」的「身份」改了；删了人物卡「顾明」（可撤销）。");
      expect(text).not.toMatch(/k-\d/u);
      snapshots.push((await listSnapshots(projectDir)).length);
    }
    expect(snapshots[1]).toBe(snapshots[0]);
    expect(await card("顾明")).toBeUndefined();
    expect((await card("林远"))?.fields.find((field) => field.label === "身份")).toMatchObject({ value: "记者", by: "author" });
    // 作者身份走的 card.write：存档点标签带命令名（操作历史归「设定」类）。
    const stored = await readOperation(projectDir, opId);
    const snapshotId = stored.kind === "record" ? (stored.record.result as { body?: { snapshotId?: string } } | undefined)?.body?.snapshotId : undefined;
    const snapshot = (await listSnapshots(projectDir)).find((entry) => entry.id === snapshotId);
    expect(snapshot?.label.startsWith("core:card.write:")).toBe(true);
    const agent = await storyAgentMocks.getStoryAgent.mock.results[0]?.value;
    expect(agent?.stream).not.toHaveBeenCalled();

    await restoreForTest(projectDir, snapshotId as string);
    expect(await card("顾明")).toBeDefined();
    expect((await card("林远"))?.fields.find((field) => field.label === "身份")?.value).toBe("审计员");
  });

  it("「认下」按钮指的那次改设定不存在 → 如实说按钮旧了、不写盘", { timeout: 30_000 }, async () => {
    const projectDir = await makeProjectWithDraft(1);
    registerRecipe(settingsChangeRecipe);
    const before = await readFile(join(projectDir, "ledger", "cards.json"), "utf-8");
    const { handlerPromise, res } = callAgentChatRoute({
      projectPath: projectDir,
      messages: [{ role: "user", content: "认下" }],
      action: { kind: "new", type: SETTINGS_CHANGE_KIND, params: { accept: "op-0123456789abcdef0123" }, requestKey: randomUUID(), issuedAt: new Date().toISOString() },
    });
    await handlerPromise;
    const text = parseSse(res.written.join("")).filter((e) => e.event === "text-delta").map((e) => e.data.text).join("");
    expect(text).toContain("这个「认下」按钮旧了");
    expect(await readFile(join(projectDir, "ledger", "cards.json"), "utf-8")).toBe(before);
  });

  it("非法动作（白名单外工具）→ 400，不当普通对话处理", async () => {
    const projectDir = await makeProjectWithDraft(1);

    const { handlerPromise, res } = callAgentChatRoute({
      projectPath: projectDir,
      messages: [{ role: "user", content: "写第 1 章" }],
      action: { toolName: "foundation_decision", chapter: 1 },
    });
    await handlerPromise;

    expect(res.statusCode).toBe(400);
    expect(storyAgentMocks.getStoryAgent).not.toHaveBeenCalled();
  });

  async function makeProjectWithDraft(chapter: number): Promise<string> {
    const rootDir = await makeHomeTempDir("story-engine-agent-user-action-");
    rootDirs.add(rootDir);
    const { projectDir } = await createStoryProject({
      rootDir,
      title: "按钮定稿测试书",
      genre: "都市",
      logline: "主角进入权力中心。",
      protagonistName: "林远",
    });
    // 建书不再建 drafts/（P9 起只写 project.json、chapters/、ledger/cards.json）。
    await mkdir(join(projectDir, "drafts", "fast"), { recursive: true });
    await writeFile(
      join(projectDir, "drafts", "fast", `chapter-${String(chapter).padStart(4, "0")}.md`),
      `# 第${chapter}章\n\n${Array.from({ length: 12 }, () => SENTENCE).join("")}\n`,
      "utf-8",
    );
    return projectDir;
  }

  async function authorWrite(projectDir: string, ops: CardOp[]): Promise<void> {
    const outcome = await runCommand(projectDir, cardWrite, { ops }, { caller: "author", idempotencyKey: `seed-${ops.length}-${Math.random()}` });
    if (!outcome.ok) throw new Error(outcome.message);
  }
});

const textOf = (events: readonly SseEvent[]): string => events.filter((e) => e.event === "text-delta").map((e) => e.data.text).join("");

/** 点「定稿」：核账、记账、定稿一路走完（记账员、核账员用假的）。 */
async function commitByButton(projectDir: string, chapter: number, keeper: BrainCallModel): Promise<{ readonly events: SseEvent[] }> {
  registerRecipe(createCommitPrepareRecipe({ callModel: keeper, readerCallModel: fakeReader, modelProblem: () => undefined }));
  const { handlerPromise, res } = callAgentChatRoute({
    projectPath: projectDir,
    messages: [{ role: "user", content: `定稿第 ${chapter} 章` }],
    action: { kind: "new", type: COMMIT_PREPARE_KIND, params: { chapter }, requestKey: randomUUID(), issuedAt: new Date().toISOString() },
  });
  await handlerPromise;
  await __drainOperationsForTests();
  const events = parseSse(res.written.join(""));
  const operations = events.filter((e) => e.event === "operation").map((e) => e.data.operation as Record<string, unknown> | undefined).filter((op) => op !== undefined);
  expect(operations.at(-1)).toMatchObject({ state: "succeeded" });
  return { events };
}

function parseSse(raw: string): SseEvent[] {
  return raw
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.startsWith("event:"))
    .map((block) => {
      const [eventLine, ...dataLines] = block.split("\n");
      const data = dataLines.map((line) => line.replace(/^data:\s?/u, "")).join("\n");
      return { event: eventLine!.slice("event:".length).trim(), data: JSON.parse(data) as Record<string, unknown> };
    });
}

function callAgentChatRoute(body: Record<string, unknown>): {
  readonly handlerPromise: Promise<void>;
  readonly res: EventEmitter & { statusCode: number; writableEnded: boolean; written: string[] };
} {
  let handler: ((req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => unknown) | undefined;
  registerAgentChatRoutes({
    use(nextHandler) {
      handler = nextHandler;
    },
  });
  if (!handler) throw new Error("agent-chat route handler was not registered");

  const res = new EventEmitter() as EventEmitter & {
    statusCode: number;
    headersSent: boolean;
    writableEnded: boolean;
    destroyed: boolean;
    written: string[];
    setHeader: (...args: unknown[]) => void;
    writeHead: (statusCode: number) => void;
    write: (chunk: string) => boolean;
    end: (value?: string) => void;
  };
  res.statusCode = 0;
  res.headersSent = false;
  res.writableEnded = false;
  res.destroyed = false;
  res.written = [];
  res.setHeader = () => {};
  res.writeHead = (statusCode: number) => {
    res.statusCode = statusCode;
    res.headersSent = true;
  };
  res.write = (chunk: string) => {
    res.written.push(chunk);
    return true;
  };
  res.end = (value?: string) => {
    if (typeof value === "string") res.written.push(value);
    res.writableEnded = true;
  };
  const req = {
    method: "POST",
    url: "/api/agent/chat",
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body), "utf-8");
    },
  } as unknown as IncomingMessage;

  const handlerPromise = (async () => {
    await handler!(req, res as unknown as ServerResponse, (error?: unknown) => {
      if (error) throw error;
    });
  })();
  return { handlerPromise, res };
}
