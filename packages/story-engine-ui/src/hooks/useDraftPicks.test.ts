import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentUserAction } from "../api/agentChatClient.js";
import type { ChapterPaper } from "../api/workingDraftClient.js";
import { __resetDraftSyncForTests } from "../drafts/draftSync.js";
import { useDraftStore } from "../stores/draftStore.js";
import { useNavigationStore } from "../stores/navigationStore.js";
import { useUiStore, type DraftCandidate } from "../stores/uiStore.js";
import { useDraftPicks } from "./useDraftPicks.js";

const PROJECT = "/books/钟楼";
const SHA = "a".repeat(64);

function paper(chapter: number, body: string, committed: string | null = null): ChapterPaper {
  return { chapter, draft: { chapter, body, version: "v3" }, committed: committed === null ? null : { body: committed }, editedSinceCommit: null };
}

function picks() {
  const sent: { readonly action: AgentUserAction; readonly echo?: string }[] = [];
  const api = useDraftPicks({ sendUserAction: async (action, options) => { sent.push({ action, ...(options?.echo ? { echo: options.echo } : {}) }); } });
  return { sent, ...api };
}

const version = (chapter: number): DraftCandidate => ({ index: 2, candidateId: `${chapter}-0123456789abcdef`, sha: SHA, body: "第二版。", chapter, projectPath: PROJECT });

beforeEach(() => {
  __resetDraftSyncForTests();
  useDraftStore.getState().reset();
  useNavigationStore.setState({ projectPath: PROJECT, toast: null });
  useUiStore.getState().setDraftCandidates(null);
  // 没改动就不该存稿：一发请求就是错。
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("不该发请求"); }));
});
afterEach(() => vi.unstubAllGlobals());

describe("挑 AI 稿（片 2D）", () => {
  it("「AI 另写几版」：交写稿、作者自己挑两版", async () => {
    useDraftStore.getState().loadPaper(PROJECT, paper(7, "作者的稿。"));
    const { sent, rerollVersions } = picks();
    await rerollVersions();
    expect(sent).toEqual([{ action: expect.objectContaining({ kind: "new", type: "draft.change", mode: "write", params: { chapter: 7, candidates: 2, pick: "author" } }), echo: "第 7 章另写 2 版给我挑" }]);
  });

  it("已定稿的章不另写，如实说", async () => {
    useDraftStore.getState().loadPaper(PROJECT, { ...paper(7, "定稿正文。", "定稿正文。"), draft: null });
    const { sent, rerollVersions } = picks();
    await rerollVersions();
    expect(sent).toEqual([]);
    expect(useNavigationStore.getState().toast).toContain("已定稿");
  });

  it("「用这版」：收起面板，交换上（候选号、指纹、作者眼前那份的版本号）", async () => {
    useDraftStore.getState().loadPaper(PROJECT, paper(7, "作者的稿。"));
    useUiStore.getState().setDraftCandidates([version(7)]);
    const { sent, adoptVersion } = picks();
    await adoptVersion(version(7));
    expect(useUiStore.getState().draftCandidates).toBeNull();
    expect(sent).toEqual([{
      action: expect.objectContaining({ kind: "new", type: "draft.adopt", params: { chapter: 7, candidateId: "7-0123456789abcdef", sha: SHA, baseVersion: "v3" } }),
      echo: "第 7 章换成第 2 版",
    }]);
  });

  it("「用这版」时不在那一章：不交，提示先打开", async () => {
    useDraftStore.getState().loadPaper(PROJECT, paper(8, "别的章。"));
    const { sent, adoptVersion } = picks();
    await adoptVersion(version(7));
    expect(sent).toEqual([]);
    expect(useNavigationStore.getState().toast).toBe("先打开第 7 章。");
  });
});
