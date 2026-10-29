// @vitest-environment node
//
// R7.7·报告 4.6：「AI 这次只看最近 12 条对话…」提示——同一本书（会话）只发一次，不再每回合都弹。
// 路由级：真 handler + 假 agent 流；第一回合带 status 事件，第二回合（同一本书）不再带；换一本书各自有一次。
import { EventEmitter } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { resetHistoryTrimNoticesForTests, shouldSendHistoryTrimNoticeOnce } from "../lib/history-trim-notice.js";

const storyAgentMocks = vi.hoisted(() => ({
  getStoryAgent: vi.fn(),
}));

vi.mock("../agent/story-agent.js", () => ({
  getStoryAgent: storyAgentMocks.getStoryAgent,
  getStoryAgentModel: () => undefined,
  getStoryAgentToolNames: () => undefined,
}));

import { registerAgentChatRoutes } from "./agent-chat.js";

describe("history-trim-notice 进程内一次登记（纯函数）", () => {
  beforeEach(() => resetHistoryTrimNoticesForTests());

  it("同一本书第一次 true、之后一律 false；不同书互不影响；空串不算", () => {
    expect(shouldSendHistoryTrimNoticeOnce("/books/a")).toBe(true);
    expect(shouldSendHistoryTrimNoticeOnce("/books/a")).toBe(false);
    expect(shouldSendHistoryTrimNoticeOnce("/books/a")).toBe(false);
    expect(shouldSendHistoryTrimNoticeOnce("/books/b")).toBe(true);
    expect(shouldSendHistoryTrimNoticeOnce("  ")).toBe(false);
  });

  it("resetHistoryTrimNoticesForTests 清空后可以再提示（服务重启的等价物）", () => {
    expect(shouldSendHistoryTrimNoticeOnce("/books/a")).toBe(true);
    resetHistoryTrimNoticesForTests();
    expect(shouldSendHistoryTrimNoticeOnce("/books/a")).toBe(true);
  });
});

describe("agent-chat route：历史裁剪提示只发一次（R7.7）", () => {
  const projectDirs = new Set<string>();

  beforeEach(() => {
    resetHistoryTrimNoticesForTests();
    storyAgentMocks.getStoryAgent.mockResolvedValue({
      stream: vi.fn(async () => ({
        fullStream: (async function* () {
          yield { type: "text-delta", payload: { text: "好的。" } };
        })(),
      })),
    });
  });

  afterEach(async () => {
    storyAgentMocks.getStoryAgent.mockReset();
    await Promise.all([...projectDirs].map((dir) => rm(dir, { recursive: true, force: true })));
    projectDirs.clear();
  });

  it("同一本书：第一回合（历史超 12 条被裁）带 status 提示，第二回合不再带", async () => {
    const projectDir = await createMinimalProject("甲");
    projectDirs.add(projectDir);
    const longHistory = Array.from({ length: 16 }, (_, index) => ({ role: "user", content: `话${index}` }));

    const first = await runChatTurn(projectDir, longHistory);
    const statusFirst = first.filter((e) => e.event === "status");
    expect(statusFirst).toHaveLength(1);
    expect(String(statusFirst[0]!.data.message)).toContain("AI 这次只看最近 12 条对话");

    const second = await runChatTurn(projectDir, [...longHistory, { role: "assistant", content: "好的。" }]);
    expect(second.filter((e) => e.event === "status")).toHaveLength(0);
    // 提示没了，但裁剪照旧发生（消息数还是 12，不能为了不提示就连裁剪也不做）。
    expect(second.some((e) => e.event === "done")).toBe(true);
  });

  it("换一本书：各自得到自己的第一次提示", async () => {
    const bookA = await createMinimalProject("乙");
    const bookB = await createMinimalProject("丙");
    projectDirs.add(bookA).add(bookB);
    const longHistory = Array.from({ length: 15 }, (_, index) => ({ role: "user", content: `话${index}` }));

    expect((await runChatTurn(bookA, longHistory)).filter((e) => e.event === "status")).toHaveLength(1);
    expect((await runChatTurn(bookB, longHistory)).filter((e) => e.event === "status")).toHaveLength(1);
  });

  it("历史没超 12 条：本来就不提示（口径不变）", async () => {
    const projectDir = await createMinimalProject("丁");
    projectDirs.add(projectDir);
    const events = await runChatTurn(projectDir, [{ role: "user", content: "你好" }]);
    expect(events.filter((e) => e.event === "status")).toHaveLength(0);
  });

  async function runChatTurn(projectDir: string, messages: readonly { role: string; content: string }[]) {
    const { handlerPromise, res } = callAgentChatRoute({ projectPath: projectDir, messages });
    await handlerPromise;
    return parseSse(res.written.join(""));
  }

  async function createMinimalProject(label: string): Promise<string> {
    const projectDir = await makeHomeTempDir(`story-engine-agent-trim-notice-${label}-`);
    await Promise.all([
      mkdir(join(projectDir, "story"), { recursive: true }),
      mkdir(join(projectDir, "timeline"), { recursive: true }),
      mkdir(join(projectDir, "world"), { recursive: true }),
      mkdir(join(projectDir, "characters"), { recursive: true }),
    ]);
    await writeFile(join(projectDir, "project.json"), `${JSON.stringify({ title: `裁剪提示测试书${label}` }, null, 2)}\n`, "utf-8");
    return projectDir;
  }
});

interface SseEvent {
  readonly event: string;
  readonly data: Record<string, unknown>;
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
  readonly res: ServerResponse & EventEmitter & { writableEnded: boolean; written: string[] };
} {
  let handler: ((req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => unknown) | undefined;
  registerAgentChatRoutes({
    use(nextHandler) {
      handler = nextHandler;
    },
  });
  if (!handler) throw new Error("agent-chat route handler was not registered");

  const written: string[] = [];
  const res = new EventEmitter() as EventEmitter & {
    statusCode: number;
    headersSent: boolean;
    writableEnded: boolean;
    written: string[];
    setHeader: (...args: unknown[]) => void;
    writeHead: (statusCode: number) => void;
    write: (chunk: string) => boolean;
    end: (value?: string) => void;
  };
  res.statusCode = 0;
  res.headersSent = false;
  res.writableEnded = false;
  res.written = written;
  res.setHeader = () => {};
  res.writeHead = (statusCode: number) => {
    res.statusCode = statusCode;
    res.headersSent = true;
  };
  res.write = (chunk: string) => {
    written.push(chunk);
    return true;
  };
  res.end = (value?: string) => {
    if (typeof value === "string") written.push(value);
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
  return { handlerPromise, res: res as unknown as ServerResponse & EventEmitter & { writableEnded: boolean; written: string[] } };
}
