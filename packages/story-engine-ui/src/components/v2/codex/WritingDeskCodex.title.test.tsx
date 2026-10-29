// 写作台顶栏的章名只认稿纸读进来的那份（写作版本 P1 第 14 轮复核 AB5，Astra 探针改写）：
// 真写作台、真稿纸、真存稿路由、真核心事务；只把 fetch 接到路由上。
import { rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { draftSave, readDraft, readDraftState, runCommand } from "@actalk/story-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { __resetDraftSyncForTests, acceptPaperIncoming, editDraft, flushDraftSave, openPaper } from "../../../drafts/draftSync.js";
import { mockWorkspaceData } from "../../../mockData.js";
import { createStoryProject } from "../../../server/book/project-store.js";
import { makeHomeTempDir } from "../../../server/lib/home-test-tmp.js";
import type { Middleware } from "../../../server/lib/project-io.js";
import { registerWorkingDraftRoutes } from "../../../server/routes/working-draft.js";
import { useBookStore } from "../../../stores/bookStore.js";
import { useDraftStore } from "../../../stores/draftStore.js";
import WritingDeskCodex from "./WritingDeskCodex.js";

let rootDir: string;
let book: string;
beforeEach(async () => {
  rootDir = await makeHomeTempDir("desk-title-");
  ({ projectDir: book } = await createStoryProject({ rootDir, title: "章名显示", genre: "都市", protagonistName: "张三" }));
  __resetDraftSyncForTests();
  useDraftStore.getState().reset();
});
afterEach(async () => {
  cleanup();
  __resetDraftSyncForTests();
  useDraftStore.getState().reset();
  vi.unstubAllGlobals();
  await rm(rootDir, { recursive: true, force: true });
});

async function save(body: string): Promise<void> {
  const outcome = await runCommand(book, draftSave, { chapter: 1, body, baseVersion: (await readDraftState(book, 1)).version }, { caller: "author" });
  if (!outcome.ok) throw new Error(outcome.message);
}

function wireRealRoutes(): void {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const handlers: Middleware[] = [];
    registerWorkingDraftRoutes({ use: (handler) => handlers.push(handler) });
    const chunks: Buffer[] = [];
    const response = {
      statusCode: 200,
      setHeader: () => response,
      end: (chunk?: string | Buffer) => {
        if (chunk) chunks.push(Buffer.from(chunk));
        return response;
      },
    } as unknown as ServerResponse;
    const request = Object.assign(Readable.from(init?.body ? [Buffer.from(String(init.body))] : []), { method: init?.method ?? "GET", url }) as IncomingMessage;
    await handlers[0]!(request, response, () => { throw new Error("没进存稿路由"); });
    return new Response(Buffer.concat(chunks).toString("utf-8"), { status: response.statusCode, headers: { "content-type": "application/json" } });
  }));
}

it("AB5：改名 C 后换成没章名的 B：顶栏、章节栏都不再显示 C 的章名", async () => {
  await save("最早的 A。");
  wireRealRoutes();
  await openPaper(book, 1);
  const chapter = { id: "ch-001", chapterNumber: 1, title: "第1章", status: "current" as const };
  useBookStore.getState().setWorkspace({ ...mockWorkspaceData, currentChapter: chapter, chapters: [chapter] });
  function Desk() {
    const workspace = useBookStore((s) => s.workspace);
    return <WritingDeskCodex workspace={workspace} projectPath={book} themeMode="dark" steeringDirection="" onSteeringDirectionChange={() => undefined} onDraftContentChange={editDraft} />;
  }
  render(<Desk />);
  await save("无章名的 B。");
  await act(async () => {
    editDraft("作者 C。");
    fireEvent.click(screen.getByTitle("点一下改章名"));
  });
  await act(async () => {
    const input = screen.getByRole("textbox", { name: "章名" });
    fireEvent.change(input, { target: { value: "作者给 C 的章名" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await flushDraftSave();
  });
  expect(useBookStore.getState().workspace.currentChapter.title).toBe("作者给 C 的章名");
  expect(useDraftStore.getState().incoming?.body).toBe("无章名的 B。");
  await act(async () => {
    expect(await acceptPaperIncoming()).toEqual({ ok: true });
    await flushDraftSave();
  });
  expect((await readDraft(book, 1))?.title).toBeUndefined();
  expect(screen.getByTitle("点一下改章名").textContent).not.toContain("作者给 C 的章名");
  const workspace = useBookStore.getState().workspace;
  expect(workspace.currentChapter.title).toBe("");
  expect(workspace.chapters.find((c) => c.chapterNumber === 1)?.title ?? "").not.toContain("作者给 C 的章名");
});
