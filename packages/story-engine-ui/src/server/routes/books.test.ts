import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { buildStateOverview, createStoryProject } from "@actalk/story-engine";
import { makeHomeTempDir, testRunRoot } from "../lib/home-test-tmp.js";
import { assertStoryEngineProject } from "../lib/project-io.js";
import { registerBooksRoutes, resolveBookLastActiveMs, selectRecentDefaultBooks } from "./books.js";

const generatedDeleteRouteProjectDirs = new Set<string>();
const generatedCreateRouteRootDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...generatedDeleteRouteProjectDirs].map((projectDir) => rm(projectDir, { recursive: true, force: true })));
  generatedDeleteRouteProjectDirs.clear();
});

describe("selectRecentDefaultBooks / resolveBookLastActiveMs", () => {
  it("超过 20 本时按 lastActiveMs 降序截取，最近的进、最旧的被挤掉", () => {
    const candidates = Array.from({ length: 25 }, (_, i) => ({
      projectDir: `/books/story-${String(i).padStart(2, "0")}`,
      title: `书${i}`,
      lastActiveMs: i * 1000, // 0 最旧，24 最新
    }));
    const selected = selectRecentDefaultBooks(candidates, 20);
    expect(selected).toHaveLength(20);
    expect(selected[0]?.title).toBe("书24");
    expect(selected[19]?.title).toBe("书5");
    expect(selected.map((b) => b.title)).not.toContain("书0");
    expect(selected.map((b) => b.title)).not.toContain("书4");
    expect(selected.map((b) => b.title)).toContain("书5");
  });

  it("updatedAt 缺失/坏值时回退 mtime；两者取 max", () => {
    expect(resolveBookLastActiveMs(undefined, 5000)).toBe(5000);
    expect(resolveBookLastActiveMs("", 5000)).toBe(5000);
    expect(resolveBookLastActiveMs("not-a-date", 5000)).toBe(5000);
    expect(resolveBookLastActiveMs("2020-01-01T00:00:00.000Z", 9_999_999_999_999)).toBe(9_999_999_999_999);
    const isoMs = Date.parse("2024-06-01T12:00:00.000Z");
    expect(resolveBookLastActiveMs("2024-06-01T12:00:00.000Z", 100)).toBe(isoMs);
  });

  it("多个 mtime 候选（根目录/chapters/drafts）取最大——刚入库一章的书不再显示成几十分钟前", () => {
    // 根目录 mtime 老（建书时），chapters/ 刚写入 → 以 chapters 为准
    expect(resolveBookLastActiveMs(undefined, 1_000, 9_000, 3_000)).toBe(9_000);
    // 候选缺失（目录不存在 → 0）不影响
    expect(resolveBookLastActiveMs(undefined, 5_000, 0, 0)).toBe(5_000);
    expect(resolveBookLastActiveMs(undefined, Number.NaN, 0, 7_000)).toBe(7_000);
  });
});
describe("books route empty-create seeds no arc-goal (V4 护栏)", () => {
  it("空建(仅 title)走 createStoryProject 后 overview.arcGoals.activeCount 为 0——不再种 arc-goal 种子", async () => {
    // handleCreateProject 简化后只剩 createStoryProject 空建，不再 persistCreatedBookDraft。
    // 复刻简化后逻辑：解析默认 premise → createStoryProject。
    const rootDir = await makeHomeTempDir("story-engine-empty-create-");
    generatedDeleteRouteProjectDirs.add(rootDir);

    const { projectDir } = await createStoryProject({
      rootDir,
      title: "空建护栏书",
      genre: "长篇故事",
      premise: "主角进入一个等待展开的故事世界。",
      mainCharacterName: "主角",
    });

    // 引擎建出的项目结构合法。
    await expect(assertStoryEngineProject(projectDir)).resolves.toMatchObject({ title: "空建护栏书" });

    // overview 能正常构建，且没有任何 active arc-goal 种子（这正是 V4 踩的坑：persistCreatedBookDraft 会种 1 个 active 的主线目标）。
    const overview = await buildStateOverview({ projectDir, maxTimelineEvents: 8 });
    expect(overview.arcGoals.activeCount).toBe(0);
    expect(overview.arcGoals.activeItems).toEqual([]);
  });
});

describe("books route create path guard（建书路径闸）", () => {
  const ORIGINAL_BOOKS_DIR = process.env.SE_BOOKS_DIR;

  afterEach(async () => {
    if (ORIGINAL_BOOKS_DIR === undefined) delete process.env.SE_BOOKS_DIR;
    else process.env.SE_BOOKS_DIR = ORIGINAL_BOOKS_DIR;
    await Promise.all([...generatedCreateRouteRootDirs].map((dir) => rm(dir, { recursive: true, force: true })));
    generatedCreateRouteRootDirs.clear();
  });

  it("拒绝客户端传入的家目录外 rootDir（与姊妹路由同一错误形态），且不落盘", async () => {
    const evilRoot = join(tmpdir(), `story-engine-evil-root-${Date.now()}`);
    const response = await callBooksRoute("/api/projects/create", {
      rootDir: evilRoot,
      draft: { title: "越界书" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.payload).toMatchObject({ ok: false });
    expect(String(response.payload.error)).toContain("不安全的项目路径");
    await expect(stat(evilRoot)).rejects.toThrow();
  });

  it("拒绝家目录敏感段（~/.ssh 下）的 rootDir，且不落盘", async () => {
    const evilRoot = join(homedir(), ".ssh", `story-engine-guard-probe-${Date.now()}`);
    const response = await callBooksRoute("/api/projects/create", {
      rootDir: evilRoot,
      draft: { title: "敏感目录书" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.payload).toMatchObject({ ok: false });
    expect(String(response.payload.error)).toContain("不安全的项目路径");
    await expect(stat(evilRoot)).rejects.toThrow();
  });

  it("home 内合法 rootDir 照常建书（闸不误伤合法客户端路径）", async () => {
    const rootDir = await makeHomeTempDir("story-engine-create-route-");
    generatedCreateRouteRootDirs.add(rootDir);
    const response = await callBooksRoute("/api/projects/create", {
      rootDir,
      draft: { title: "路径闸合法书" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.payload).toMatchObject({ ok: true });
    const projectDir = String(response.payload.projectDir);
    expect(projectDir.startsWith(rootDir)).toBe(true);
    await expect(stat(projectDir)).resolves.toBeTruthy();
  });

  it("不传 rootDir 时用默认书库根（SE_BOOKS_DIR 指向 home 内）照常建书", async () => {
    const booksRoot = await makeHomeTempDir("story-engine-create-default-");
    generatedCreateRouteRootDirs.add(booksRoot);
    process.env.SE_BOOKS_DIR = booksRoot;
    const response = await callBooksRoute("/api/projects/create", {
      draft: { title: "默认根建书" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.payload).toMatchObject({ ok: true });
    expect(String(response.payload.projectDir).startsWith(booksRoot)).toBe(true);
  });

  it("SE_BOOKS_DIR 指到家目录外时，默认书库根仍能通过闸（回归：默认路径绝不被拒）", async () => {
    // isSafeProjectPath 的覆盖分支只放行书库根【之下】的项目路径；建书入口校验的是根本身，
    // 没有例外会把「覆盖书库根后建书」整个拒掉——这条用例锁死该回归。
    const booksRoot = await mkdtemp(join(tmpdir(), "story-engine-books-root-"));
    generatedCreateRouteRootDirs.add(booksRoot);
    process.env.SE_BOOKS_DIR = booksRoot;
    const response = await callBooksRoute("/api/projects/create", {
      draft: { title: "覆盖根建书" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.payload).toMatchObject({ ok: true });
    expect(String(response.payload.projectDir).startsWith(booksRoot)).toBe(true);
  });
});

describe("books route destructive confirmation", () => {
  it("rejects project deletion without strong confirmation fields", async () => {
    const projectDir = await createDeleteRouteProject("未确认删除");

    const response = await callBooksRoute("/api/books/delete", {
      projectPath: projectDir,
      confirm: true,
    });

    expect(response.statusCode).toBe(400);
    expect(response.payload).toMatchObject({ ok: false });
    expect(String(response.payload.error)).toContain("确认书名");
    await expect(readFile(join(projectDir, "project.json"), "utf-8")).resolves.toContain("未确认删除");
    await rm(projectDir, { recursive: true, force: true });
  });

  it("rejects project deletion when confirmTitle does not match", async () => {
    const projectDir = await createDeleteRouteProject("目标书籍");

    const response = await callBooksRoute("/api/books/delete", {
      projectPath: projectDir,
      confirmDelete: true,
      confirmTitle: "其他书籍",
      confirmProjectPath: projectDir,
    });

    expect(response.statusCode).toBe(400);
    expect(response.payload).toMatchObject({ ok: false });
    expect(String(response.payload.error)).toContain("确认书名不匹配");
    expect(String(response.payload.error)).not.toContain(projectDir);
    expect(String(response.payload.error)).not.toContain("目标书籍");
    expect(String(response.payload.error)).not.toContain("其他书籍");
    await expect(readFile(join(projectDir, "project.json"), "utf-8")).resolves.toContain("目标书籍");
    await rm(projectDir, { recursive: true, force: true });
  });

  it("rejects project deletion when confirmProjectPath does not match", async () => {
    const projectDir = await createDeleteRouteProject("路径确认书籍");

    const response = await callBooksRoute("/api/books/delete", {
      projectPath: projectDir,
      confirmDelete: true,
      confirmTitle: "路径确认书籍",
      confirmProjectPath: join(testRunRoot(), "other-project"),
    });

    expect(response.statusCode).toBe(400);
    expect(response.payload).toMatchObject({ ok: false });
    expect(String(response.payload.error)).toContain("确认项目标识不匹配");
    expect(String(response.payload.error)).not.toContain(projectDir);
    await expect(readFile(join(projectDir, "project.json"), "utf-8")).resolves.toContain("路径确认书籍");
    await rm(projectDir, { recursive: true, force: true });
  });

  it("deletes a project only when title and project identity confirmations match", async () => {
    const projectDir = await createDeleteRouteProject("可删除书籍");

    const response = await callBooksRoute("/api/books/delete", {
      projectPath: projectDir,
      confirmDelete: true,
      confirmTitle: "可删除书籍",
      confirmProjectPath: projectDir,
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload).toEqual({ ok: true });
    await expect(readFile(join(projectDir, "project.json"), "utf-8")).rejects.toThrow();
  });

  it("deletes a freshly created book that only has a title and no further content", async () => {
    // 兜底印证：用户只给书名进台、还没写任何内容就回首页删除——该空建书应能被删除路径安全移除，不抛错。
    const { projectDir, title } = await createEmptyEngineBook("空建的新书");

    // 删除前确认这就是一本仅有标题、尚无正文/章节内容的空书。
    await expect(readFile(join(projectDir, "project.json"), "utf-8")).resolves.toContain("空建的新书");
    await expect(readFile(join(projectDir, "story", "core.json"), "utf-8")).resolves.toBeTruthy();

    const response = await callBooksRoute("/api/books/delete", {
      projectPath: projectDir,
      confirmDelete: true,
      confirmTitle: title,
      confirmProjectPath: projectDir,
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload).toEqual({ ok: true });
    await expect(stat(projectDir)).rejects.toThrow();
  });
});

describe("usage-summary route path guard（用量汇总补齐路径闸）", () => {
  it("拒绝家目录外的 project 查询参数（与其余路由同一错误形态）", async () => {
    const evilProject = join(tmpdir(), `story-engine-usage-evil-${Date.now()}`);
    const response = await callBooksGetRoute(`/api/usage-summary?project=${encodeURIComponent(evilProject)}`);
    expect(response.statusCode).toBe(400);
    expect(response.payload).toMatchObject({ ok: false });
    expect(String(response.payload.error)).toContain("不安全的项目路径");
  });

  it("拒绝家目录敏感段（~/.ssh 下）的 project 查询参数", async () => {
    const evilProject = join(homedir(), ".ssh", `story-engine-usage-probe-${Date.now()}`);
    const response = await callBooksGetRoute(`/api/usage-summary?project=${encodeURIComponent(evilProject)}`);
    expect(response.statusCode).toBe(400);
    expect(response.payload).toMatchObject({ ok: false });
    expect(String(response.payload.error)).toContain("不安全的项目路径");
  });

  it("合法项目路径照常返回用量汇总（闸不误伤）", async () => {
    const projectDir = await createDeleteRouteProject("用量汇总书");
    const response = await callBooksGetRoute(`/api/usage-summary?project=${encodeURIComponent(projectDir)}`);
    expect(response.statusCode).toBe(200);
    expect(response.payload).toMatchObject({
      ok: true,
      summary: { diagnosticsCount: 0, totalTokens: 0 },
    });
  });
});

async function createEmptyEngineBook(title: string): Promise<{ readonly projectDir: string; readonly title: string }> {
  // rootDir 必须落在用户目录内，否则 guardProjectPath 会以"不安全路径"拒绝删除；
  // makeHomeTempDir 落在 $HOME 下隐藏测试基目录的本次运行 run 目录内，满足这一约束。
  const rootDir = await makeHomeTempDir("story-engine-empty-book-");
  generatedDeleteRouteProjectDirs.add(rootDir);
  // 用引擎真实建书：仅给标题，其余字段留空——模拟"只问书名进台、还没搭任何内容"的空建书。
  const { projectDir } = await createStoryProject({
    rootDir,
    title,
    genre: "",
    premise: "",
    mainCharacterName: "",
  });
  return { projectDir, title };
}

async function createDeleteRouteProject(title: string): Promise<string> {
  const projectDir = await makeHomeTempDir("story-engine-delete-route-");
  generatedDeleteRouteProjectDirs.add(projectDir);
  await Promise.all([
    mkdir(join(projectDir, "story"), { recursive: true }),
    mkdir(join(projectDir, "timeline"), { recursive: true }),
    mkdir(join(projectDir, "world"), { recursive: true }),
    mkdir(join(projectDir, "characters"), { recursive: true }),
  ]);
  await writeFile(join(projectDir, "project.json"), `${JSON.stringify({ title }, null, 2)}\n`, "utf-8");
  return projectDir;
}

async function callBooksRoute(url: string, body: Record<string, unknown>): Promise<{
  readonly statusCode: number;
  readonly payload: Record<string, unknown>;
}> {
  return invokeBooksRoute("POST", url, body);
}

async function callBooksGetRoute(url: string): Promise<{
  readonly statusCode: number;
  readonly payload: Record<string, unknown>;
}> {
  return invokeBooksRoute("GET", url);
}

async function invokeBooksRoute(method: string, url: string, body?: Record<string, unknown>): Promise<{
  readonly statusCode: number;
  readonly payload: Record<string, unknown>;
}> {
  let handler: ((req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => unknown) | undefined;
  registerBooksRoutes({
    use(nextHandler) {
      handler = nextHandler;
    },
  });
  if (!handler) throw new Error("books route handler was not registered");

  let raw = "";
  const res = {
    statusCode: 0,
    setHeader: vi.fn(),
    end(value: string) {
      raw += value;
    },
  } as unknown as ServerResponse & { statusCode: number };
  const req = {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body), "utf-8");
    },
  } as unknown as IncomingMessage;

  await handler(req, res, (error?: unknown) => {
    if (error) throw error;
  });

  return {
    statusCode: res.statusCode,
    payload: JSON.parse(raw) as Record<string, unknown>,
  };
}
