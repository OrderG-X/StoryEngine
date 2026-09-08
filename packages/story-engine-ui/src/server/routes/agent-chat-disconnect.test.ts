// @vitest-environment node
//
// agent-chat 路由级断开收尾（问题：客户端「停止」/90s 空闲看门狗只在前端掐 fetch，
// 服务端 agent.stream 与工具写盘会继续跑）。假 req/res：模拟 res 'close'（writableEnded=false）
// → 断言传给 agent.stream 的 abortSignal 被中止、且断开后不再开重做轮（新工具步骤）。
import { EventEmitter } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeHomeTempDir } from "../lib/home-test-tmp.js";

const storyAgentMocks = vi.hoisted(() => ({
  getStoryAgent: vi.fn(),
}));

vi.mock("../agent/story-agent.js", () => ({
  getStoryAgent: storyAgentMocks.getStoryAgent,
}));

import { registerAgentChatRoutes } from "./agent-chat.js";

interface CapturedStreamCall {
  readonly messages: readonly unknown[];
  readonly options: { readonly abortSignal?: AbortSignal } | undefined;
}

describe("agent-chat route：客户端断开 → abort 本轮 agent.stream", () => {
  const projectDirs = new Set<string>();

  afterEach(async () => {
    storyAgentMocks.getStoryAgent.mockReset();
    await Promise.all([...projectDirs].map((dir) => rm(dir, { recursive: true, force: true })));
    projectDirs.clear();
  });

  it("SSE 途中 res close（writableEnded=false）→ abortSignal 中止、流收尾、不开重做轮", async () => {
    const projectDir = await createMinimalProject();
    projectDirs.add(projectDir);

    const streamCalls: CapturedStreamCall[] = [];
    let streamStarted!: () => void;
    const streamStartedPromise = new Promise<void>((resolvePromise) => {
      streamStarted = resolvePromise;
    });

    storyAgentMocks.getStoryAgent.mockResolvedValue({
      stream: async (messages: readonly unknown[], options?: CapturedStreamCall["options"]) => {
        streamCalls.push({ messages, options });
        streamStarted();
        return {
          fullStream: (async function* () {
            // 先发一条「空转声称」（零工具调用——正常流程会触发自动重做），
            // 然后挂在 in-flight 生成里，直到 abort 才收。
            yield { type: "text-delta", payload: { text: "第 1 章已正式入库。" } };
            for (let i = 0; i < 400 && !options?.abortSignal?.aborted; i += 1) {
              await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
            }
          })(),
        };
      },
    });

    const { handlerPromise, res } = callAgentChatRoute({
      projectPath: projectDir,
      messages: [{ role: "user", content: "正式入库第1章。" }],
    });

    await streamStartedPromise;
    expect(streamCalls).toHaveLength(1);
    const signal = streamCalls[0]?.options?.abortSignal;
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(false);

    // 客户端掐 fetch → 连接在响应未完成时关闭。
    res.emit("close");
    await handlerPromise;

    expect(signal?.aborted).toBe(true);
    // 断开后「空转声称」不得再触发自动重做——不再开新一轮 agent.stream（新工具步骤）。
    expect(streamCalls).toHaveLength(1);
    // 路由正常收尾（res.end 被调用），没有挂死。
    expect(res.writableEnded).toBe(true);
  });

  it("正常流完（无断开）→ abortSignal 保持未中止", async () => {
    const projectDir = await createMinimalProject();
    projectDirs.add(projectDir);

    const streamCalls: CapturedStreamCall[] = [];
    storyAgentMocks.getStoryAgent.mockResolvedValue({
      stream: async (messages: readonly unknown[], options?: CapturedStreamCall["options"]) => {
        streamCalls.push({ messages, options });
        return {
          fullStream: (async function* () {
            yield { type: "text-delta", payload: { text: "目前写到第 1 章。" } };
          })(),
        };
      },
    });

    const { handlerPromise, res } = callAgentChatRoute({
      projectPath: projectDir,
      messages: [{ role: "user", content: "这本书目前什么进展？" }],
    });
    await handlerPromise;

    expect(streamCalls).toHaveLength(1);
    expect(streamCalls[0]?.options?.abortSignal?.aborted).toBe(false);
    expect(res.writableEnded).toBe(true);
  });

  async function createMinimalProject(): Promise<string> {
    const projectDir = await makeHomeTempDir("story-engine-agent-disconnect-");
    await Promise.all([
      mkdir(join(projectDir, "story"), { recursive: true }),
      mkdir(join(projectDir, "timeline"), { recursive: true }),
      mkdir(join(projectDir, "world"), { recursive: true }),
      mkdir(join(projectDir, "characters"), { recursive: true }),
    ]);
    await writeFile(join(projectDir, "project.json"), `${JSON.stringify({ title: "断开测试书" }, null, 2)}\n`, "utf-8");
    return projectDir;
  }
});

function callAgentChatRoute(body: Record<string, unknown>): {
  readonly handlerPromise: Promise<void>;
  readonly res: ServerResponse & EventEmitter & { writableEnded: boolean };
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

  return { handlerPromise, res: res as unknown as ServerResponse & EventEmitter & { writableEnded: boolean } };
}
