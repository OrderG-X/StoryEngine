// @vitest-environment node
//
// agent-chat 路由级结构化动作（2026-10-07 拆补丁塔）：用户点「确认定稿」按钮 → body.action →
// 服务端直接执行 commit_apply，不经模型（agent.stream 一次都不调）。真项目 + 真预览票据 + 真落盘。
import { EventEmitter } from "node:events";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { createStoryProject } from "../book/project-store.js";
import { projectBook } from "@actalk/story-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { restoreSnapshot } from "../lib/snapshot.js";

const storyAgentMocks = vi.hoisted(() => ({ getStoryAgent: vi.fn() }));
vi.mock("../agent/story-agent.js", () => ({ getStoryAgent: storyAgentMocks.getStoryAgent }));
// 本文件测「确认定稿」按钮的结构化动作，不定稿后的编辑部后台预热：mock 掉 warmUpReaders，
// 别让单测真去补读笔记（R3 后三个专员常开、没有开关可关）。
const brainMocks = vi.hoisted(() => ({ warmUpReaders: vi.fn(async () => undefined) }));
vi.mock("../editorial/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../editorial/index.js")>()),
  warmUpReaders: brainMocks.warmUpReaders,
}));

import { buildCommitPreviewToolOutput } from "../agent/tools/commit-preview.js";
import { runManageLedger } from "../agent/tools/manage-ledger.js";
import { applyFoundationWriteToolLogic } from "../agent/tools/foundation-write.js";
import type { BrainCallModel } from "../editorial/reader-window.js";
import { registerAgentChatRoutes } from "./agent-chat.js";

const SENTENCE = "林远在会议室外停下脚步，反复掂量手里那份账册的分量，盘算着接下来每一步该怎么走。";
/** 假记账员：要账单就交一份（原句都在正文里），不连网。 */
const fakeKeeper: BrainCallModel = async (messages) =>
  (messages.at(-1)?.content ?? "").includes("交这一章的账单")
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

interface SseEvent {
  readonly event: string;
  readonly data: Record<string, unknown>;
}

describe("agent-chat route：结构化动作「确认定稿」", () => {
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
    storyAgentMocks.getStoryAgent.mockReset();
    await Promise.all([...rootDirs].map((dir) => rm(dir, { recursive: true, force: true })));
    rootDirs.clear();
  });

  it("有效预览 + 点按钮 → 直接定稿落盘，事件同 agent 回合（tool-call/tool-result/文本/下一步卡），模型零调用", { timeout: 30_000 }, async () => {
    const projectDir = await makeProjectWithDraft(1);
    const preview = await buildCommitPreviewToolOutput({ projectDir, chapter: 1, callModel: fakeKeeper });
    expect(preview.canCommit).toBe(true);

    const { handlerPromise, res } = callAgentChatRoute({
      projectPath: projectDir,
      messages: [{ role: "user", content: "确认定稿第 1 章" }],
      currentChapter: 1,
      action: { toolName: "commit_apply", chapter: 1, previewToken: preview.previewToken },
    });
    await handlerPromise;

    const events = parseSse(res.written.join(""));
    const commitResult = events.find((e) => e.event === "tool-result" && e.data.toolName === "commit_apply");
    expect(commitResult?.data.output).toMatchObject({ ok: true, committed: true, chapter: 1 });
    expect(events.some((e) => e.event === "tool-result" && e.data.toolName === "suggest_next_steps")).toBe(true);
    expect(events.at(-1)?.event).toBe("done");
    await expect(access(join(projectDir, "chapters", "0001.md"))).resolves.toBeUndefined();
    const agent = await storyAgentMocks.getStoryAgent.mock.results[0]?.value;
    expect(agent?.stream).not.toHaveBeenCalled();
    expect(res.writableEnded).toBe(true);
  });

  it("没有预览就点按钮 → 如实拒绝不落盘，给「重新预览」选项", { timeout: 30_000 }, async () => {
    const projectDir = await makeProjectWithDraft(1);

    const { handlerPromise, res } = callAgentChatRoute({
      projectPath: projectDir,
      messages: [{ role: "user", content: "确认定稿第 1 章" }],
      action: { toolName: "commit_apply", chapter: 1 },
    });
    await handlerPromise;

    const events = parseSse(res.written.join(""));
    const commitResult = events.find((e) => e.event === "tool-result" && e.data.toolName === "commit_apply");
    expect(commitResult?.data.output).toMatchObject({ ok: false, committed: false });
    const text = events.filter((e) => e.event === "text-delta").map((e) => e.data.text).join("");
    expect(text).toContain("没定稿");
    expect(text).not.toContain("commit_preview");
    await expect(access(join(projectDir, "chapters", "0001.md"))).rejects.toThrow();
  });

  it("「确认改账」：AI 提的裁定草案原样带回 → 记成作者裁定、老格式账本跟着变；点两次只记一次", { timeout: 30_000 }, async () => {
    const projectDir = await makeProjectWithDraft(1);
    const preview = await buildCommitPreviewToolOutput({ projectDir, chapter: 1, callModel: fakeKeeper });
    const committed = callAgentChatRoute({
      projectPath: projectDir,
      messages: [{ role: "user", content: "确认定稿第 1 章" }],
      action: { toolName: "commit_apply", chapter: 1, previewToken: preview.previewToken },
    });
    await committed.handlerPromise;

    const proposal = await runManageLedger(projectDir, { op: "remove", targetText: "停下脚步" });
    expect(proposal).toMatchObject({ ok: false, needsConfirmation: true, blockedReason: "awaiting_user_confirmation" });
    expect(proposal.summary).toContain("「林远在会议室外停下脚步」");
    expect(proposal.summary).not.toMatch(/c1-|d-\d/u);
    expect((await projectBook(projectDir)).facts.every((fact) => fact.status !== "retracted")).toBe(true);

    const action = { toolName: "ledger_decision", ...proposal.ledgerConfirm };
    const snapshotIds: unknown[] = [];
    for (let click = 0; click < 2; click += 1) {
      const { handlerPromise, res } = callAgentChatRoute({ projectPath: projectDir, messages: [{ role: "user", content: "确认改账" }], action });
      await handlerPromise;
      const events = parseSse(res.written.join(""));
      const result = events.find((e) => e.event === "tool-result" && e.data.toolName === "manage_ledger");
      expect(result?.data.output).toMatchObject({ ok: true, refreshScope: "full" });
      snapshotIds.push((result?.data.output as { snapshotId?: unknown } | undefined)?.snapshotId);
      const text = events.filter((e) => e.event === "text-delta").map((e) => e.data.text).join("");
      expect(text).toContain(click === 0 ? "账改好了" : "已经记过了");
    }
    // 真改了账才带撤销点（界面凭它登记成一步）；第二次点没改任何东西，不带。
    expect(typeof snapshotIds[0]).toBe("string");
    expect(snapshotIds[1]).toBeUndefined();
    const view = await projectBook(projectDir);
    expect(view.facts.find((fact) => fact.text === "林远在会议室外停下脚步")?.status).toBe("retracted");
    const legacy = JSON.parse(await readFile(join(projectDir, "story", "fact-ledger.json"), "utf-8")) as { facts: { text: string }[] };
    expect(legacy.facts.map((fact) => fact.text)).toEqual(["账册在林远手里"]);
    const agent = await storyAgentMocks.getStoryAgent.mock.results[0]?.value;
    expect(agent?.stream).not.toHaveBeenCalled();

    // 按这次改账的撤销点撤销：只退改账，第 1 章定稿还在（10-18 走查：曾把前一回合的定稿一起撤了）。
    await restoreSnapshot(projectDir, snapshotIds[0] as string);
    const undone = await projectBook(projectDir);
    expect(undone.chapters.map((chapter) => chapter.chapter)).toEqual([1]);
    expect(undone.facts.find((fact) => fact.text === "林远在会议室外停下脚步")?.status).toBe("current");
  });

  it("「确认改设定」：AI 删角色只出按钮不删 → 作者点了才删；点两次只删一次；撤销点只退这一步", { timeout: 30_000 }, async () => {
    const projectDir = await makeProjectWithDraft(1);
    const created = await applyFoundationWriteToolLogic({
      projectDir,
      toolInput: { actionType: "create_character", category: "characters", after: { name: "顾明", identity: "配角" } },
    });
    expect(created.ok).toBe(true);
    const readNames = async (): Promise<string[]> => {
      const bible = JSON.parse(await readFile(join(projectDir, "story", "character-bible.json"), "utf-8")) as { characters: { name: string }[] };
      return bible.characters.map((character) => character.name);
    };
    const bible = JSON.parse(await readFile(join(projectDir, "story", "character-bible.json"), "utf-8")) as { characters: { id: string; name: string }[] };
    const targetId = bible.characters.find((character) => character.name === "顾明")?.id;
    const proposal = await applyFoundationWriteToolLogic({
      projectDir,
      toolInput: { actionType: "delete_foundation_entry", category: "characters", targetId, targetName: "顾明", before: { name: "顾明" }, after: {} },
    });
    expect(proposal).toMatchObject({ ok: false, needsConfirmation: true });
    expect(proposal.foundationConfirm?.key).toBeTruthy();
    expect(await readNames()).toContain("顾明");

    const action = { toolName: "foundation_decision", ...proposal.foundationConfirm };
    const snapshotIds: unknown[] = [];
    for (let click = 0; click < 2; click += 1) {
      const { handlerPromise, res } = callAgentChatRoute({ projectPath: projectDir, messages: [{ role: "user", content: "确认改设定" }], action });
      await handlerPromise;
      const events = parseSse(res.written.join(""));
      const result = events.find((e) => e.event === "tool-result" && e.data.toolName === "foundation_write");
      expect(result?.data.output).toMatchObject({ ok: true, refreshScope: "foundation" });
      snapshotIds.push((result?.data.output as { snapshotId?: unknown } | undefined)?.snapshotId);
      const text = events.filter((e) => e.event === "text-delta").map((e) => e.data.text).join("");
      if (click === 1) expect(text).toContain("已经做过了");
    }
    expect(typeof snapshotIds[0]).toBe("string");
    expect(snapshotIds[1]).toBeUndefined();
    expect(await readNames()).not.toContain("顾明");
    const agent = await storyAgentMocks.getStoryAgent.mock.results[0]?.value;
    expect(agent?.stream).not.toHaveBeenCalled();

    await restoreSnapshot(projectDir, snapshotIds[0] as string);
    expect(await readNames()).toContain("顾明");
  });

  it("非法动作（白名单外工具）→ 400，不当普通对话处理", async () => {
    const projectDir = await makeProjectWithDraft(1);

    const { handlerPromise, res } = callAgentChatRoute({
      projectPath: projectDir,
      messages: [{ role: "user", content: "写第 1 章" }],
      action: { toolName: "foundation_write", chapter: 1 },
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
      premise: "主角进入权力中心。",
      mainCharacterName: "林远",
    });
    await writeFile(
      join(projectDir, "drafts", "fast", `chapter-${String(chapter).padStart(4, "0")}.md`),
      `# 第${chapter}章\n\n${Array.from({ length: 12 }, () => SENTENCE).join("")}\n`,
      "utf-8",
    );
    return projectDir;
  }
});

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
