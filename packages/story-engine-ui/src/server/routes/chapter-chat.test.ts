// @vitest-environment node
//
// chapter-chat 路由级测试（审计返工 B5）：流式分支 catch 里的 error.message 直拼
// 进用户可见面（500 JSON / SSE error 帧）——fs/git 报错常内嵌本地绝对路径，
// 进用户可见面前必须过 scrubLocalAbsolutePaths。两条分支各钉一条。
import { mkdir, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeHomeTempDir } from "../lib/home-test-tmp.js";

const storyEngineMocks = vi.hoisted(() => ({
  buildStateOverview: vi.fn(),
}));

vi.mock("@actalk/story-engine", async () => {
  const actual = await vi.importActual<typeof import("@actalk/story-engine")>("@actalk/story-engine");
  return {
    ...actual,
    buildStateOverview: storyEngineMocks.buildStateOverview,
  };
});

import { registerChapterChatRoutes } from "./chapter-chat.js";

const ABS_PATH_PATTERN = /\/(?:Users|home|var|tmp|private)\//u;

describe("chapter-chat stream 错误路径消毒（B5）", () => {
  const projectDirs = new Set<string>();

  afterEach(async () => {
    storyEngineMocks.buildStateOverview.mockReset();
    await Promise.all([...projectDirs].map((dir) => rm(dir, { recursive: true, force: true })));
    projectDirs.clear();
  });

  it("headersSent 前抛错 → 500 JSON 的 error 不含本地绝对路径", async () => {
    // 目录存在但没有 project.json → assertStoryEngineProject 的 readFile 裸抛 ENOENT，
    // message 内嵌绝对路径（macOS tmp 目录走 /var/folders/...）。
    const projectDir = await makeHomeTempDir("story-engine-chapter-chat-err-");
    projectDirs.add(projectDir);

    const { handlerPromise, res, written } = callChapterChatStream({
      projectPath: projectDir,
      message: "帮我看看这章",
    });
    await handlerPromise;

    expect(res.statusCode).toBe(500);
    const body = written.join("");
    expect(body, `500 body 仍含绝对路径：${body}`).not.toMatch(ABS_PATH_PATTERN);
    expect(body).toContain("(本地路径)"); // 证明 scrub 真跑过（不是碰巧没路径）
  });

  it("headersSent 后抛错 → SSE error 帧的 error 不含本地绝对路径", async () => {
    const projectDir = await createMinimalProject();
    projectDirs.add(projectDir);
    storyEngineMocks.buildStateOverview.mockRejectedValueOnce(
      new Error("ENOENT: no such file or directory, open '/Users/tester/secret/notes.json'"),
    );

    const { handlerPromise, written } = callChapterChatStream({
      projectPath: projectDir,
      message: "帮我看看这章",
    });
    await handlerPromise;

    const body = written.join("");
    expect(body).toContain("event: error"); // 走的是 SSE error 帧分支（不是 500）
    expect(body, `SSE 帧仍含绝对路径：${body}`).not.toMatch(ABS_PATH_PATTERN);
    expect(body).toContain("(本地路径)");
  });

  async function createMinimalProject(): Promise<string> {
    const projectDir = await makeHomeTempDir("story-engine-chapter-chat-");
    await Promise.all([
      mkdir(join(projectDir, "story"), { recursive: true }),
      mkdir(join(projectDir, "timeline"), { recursive: true }),
      mkdir(join(projectDir, "world"), { recursive: true }),
      mkdir(join(projectDir, "characters"), { recursive: true }),
    ]);
    await writeFile(join(projectDir, "project.json"), `${JSON.stringify({ title: "章节对话测试书" }, null, 2)}\n`, "utf-8");
    return projectDir;
  }
});

function callChapterChatStream(body: Record<string, unknown>): {
  readonly handlerPromise: Promise<void>;
  readonly res: ServerResponse & { statusCode: number; headersSent: boolean; writableEnded: boolean };
  readonly written: string[];
} {
  let handler: ((req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => unknown) | undefined;
  registerChapterChatRoutes({
    use(nextHandler) {
      handler = nextHandler;
    },
  });
  if (!handler) throw new Error("chapter-chat route handler was not registered");

  const written: string[] = [];
  const res = {
    statusCode: 0,
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    setHeader: () => {},
    writeHead: (statusCode: number) => {
      res.statusCode = statusCode;
      res.headersSent = true;
    },
    write: (chunk: string) => {
      written.push(chunk);
      return true;
    },
    end: (value?: string) => {
      if (typeof value === "string") written.push(value);
      res.writableEnded = true;
    },
  } as unknown as ServerResponse & { statusCode: number; headersSent: boolean; writableEnded: boolean };
  const req = {
    method: "POST",
    url: "/api/chapter-chat/stream",
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body), "utf-8");
    },
  } as unknown as IncomingMessage;

  const handlerPromise = (async () => {
    await handler!(req, res, (error?: unknown) => {
      if (error) throw error;
    });
  })();

  return { handlerPromise, res, written };
}
