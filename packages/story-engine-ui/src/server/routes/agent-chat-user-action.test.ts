// @vitest-environment node
//
// agent-chat 路由级结构化动作（2026-10-07 拆补丁塔）：用户点「确认定稿」按钮 → body.action →
// 服务端直接执行 commit_apply，不经模型（agent.stream 一次都不调）。真项目 + 真预览票据 + 真落盘。
import { EventEmitter } from "node:events";
import { access, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { createStoryProject } from "@actalk/story-engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeHomeTempDir } from "../lib/home-test-tmp.js";

const storyAgentMocks = vi.hoisted(() => ({ getStoryAgent: vi.fn() }));
vi.mock("../agent/story-agent.js", () => ({ getStoryAgent: storyAgentMocks.getStoryAgent }));
// 本文件测「确认定稿」按钮的结构化动作，不定稿后的编辑部后台预热：mock 掉 warmUpReaders，
// 别让单测真去补读笔记（R3 后三个专员常开、没有开关可关）。
const brainMocks = vi.hoisted(() => ({ warmUpReaders: vi.fn(async () => undefined) }));
vi.mock("../brain/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../brain/index.js")>()),
  warmUpReaders: brainMocks.warmUpReaders,
}));

import { buildCommitPreviewToolOutput } from "../agent/tools/commit-preview.js";
import { __resetCommitPreviewStore } from "../agent/tools/commit-preview-store.js";
import { registerAgentChatRoutes } from "./agent-chat.js";

interface SseEvent {
  readonly event: string;
  readonly data: Record<string, unknown>;
}

describe("agent-chat route：结构化动作「确认定稿」", () => {
  const rootDirs = new Set<string>();

  beforeEach(() => {
    __resetCommitPreviewStore();
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
    const preview = await buildCommitPreviewToolOutput({ projectDir, chapter: 1 });
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
    expect(text).toContain("未定稿");
    expect(text).not.toContain("commit_preview");
    await expect(access(join(projectDir, "chapters", "0001.md"))).rejects.toThrow();
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
    const sentence = "林远在会议室外停下脚步，反复掂量手里那份账册的分量，盘算着接下来每一步该怎么走。";
    await writeFile(
      join(projectDir, "drafts", "fast", `chapter-${String(chapter).padStart(4, "0")}.md`),
      `# 第${chapter}章\n\n${Array.from({ length: 12 }, () => sentence).join("")}\n`,
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
