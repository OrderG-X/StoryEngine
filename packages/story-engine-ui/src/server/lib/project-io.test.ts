import { describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { IncomingMessage } from "node:http";
import type { FoundationGapSuggestion } from "../../api/types.js";
import {
  chapterWorkspacePath,
  createInitialAssetItems,
  defaultCommittedChapterPath,
  defaultDraftPath,
  isSafeProjectPath,
  limitFoundationChatHistory,
  readJsonBody,
  readChapterWorkspaceSnapshot,
  readWorkspaceMessages,
  readFoundationGapActionType,
  readFoundationGapSuggestions,
  readGeneratedFoundationGapSuggestions,
  readUsageSummary,
  resolveFoundationUpdateTargetId,
  withUiOverviewDetails,
  writeFileAtomic,
  commitFilesAtomically,
} from "./project-io.js";

const EXPECTED_MAX_JSON_BODY_BYTES = 32 * 1024 * 1024;
const EXPECTED_MAX_USAGE_SUMMARY_FILES = 200;
const EXPECTED_MAX_USAGE_SUMMARY_FILE_BYTES = 256 * 1024;

describe("project io asset helpers", () => {
  it("allows normal StoryEngine project locations under user work areas", () => {
    const home = homedir();

    expect(isSafeProjectPath(join(home, "Documents", "New project", "story-book"))).toBe(true);
    expect(isSafeProjectPath(join(home, "Desktop", "story-book"))).toBe(true);
    expect(isSafeProjectPath(join(home, "Projects", "story-book"))).toBe(true);
  });

  it("rejects sensitive home paths and files before project validation", () => {
    const home = homedir();

    expect(isSafeProjectPath(home)).toBe(false);
    expect(isSafeProjectPath(join(home, ".ssh"))).toBe(false);
    expect(isSafeProjectPath(join(home, ".ssh", "story-book"))).toBe(false);
    expect(isSafeProjectPath(join(home, ".aws"))).toBe(false);
    expect(isSafeProjectPath(join(home, ".gnupg"))).toBe(false);
    expect(isSafeProjectPath(join(home, ".npmrc"))).toBe(false);
    expect(isSafeProjectPath(join(home, ".gitconfig"))).toBe(false);
    expect(isSafeProjectPath(join(home, "Library", "Keychains"))).toBe(false);
    expect(isSafeProjectPath(join(home, "Library", "Preferences"))).toBe(false);
  });

  it("keeps existing absolute path safety rejections", () => {
    const home = homedir();

    expect(isSafeProjectPath("/tmp/story-book")).toBe(false);
    expect(isSafeProjectPath(`${home}/Documents/story-book\0`)).toBe(false);
    expect(isSafeProjectPath("/etc/story-book")).toBe(false);
    expect(isSafeProjectPath(`${home}/Documents/../Documents/`)).toBe(false);
  });

  it("reads a small JSON body normally", async () => {
    const body = await readJsonBody(requestFromChunks([Buffer.from("{\"projectPath\":\"/tmp/book\"}")]));

    expect(body).toEqual({ projectPath: "/tmp/book" });
  });

  it("rejects malformed JSON with a controlled parse error", async () => {
    await expect(readJsonBody(requestFromChunks([Buffer.from("{")]))).rejects.toThrow("JSON");
  });

  it("rejects oversized JSON bodies before consuming the remaining stream", async () => {
    let yielded = 0;
    const req = {
      async *[Symbol.asyncIterator]() {
        yielded += 1;
        yield Buffer.alloc(EXPECTED_MAX_JSON_BODY_BYTES, "a");
        yielded += 1;
        yield Buffer.from("aa");
        yielded += 1;
        yield Buffer.from("{}");
      },
    } as unknown as IncomingMessage;

    await expect(readJsonBody(req)).rejects.toThrow("请求 JSON body 超过大小限制");
    expect(yielded).toBe(2);
  });

  it("summarizes a normal small diagnostics folder", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "story-engine-usage-summary-normal-"));
    await mkdir(join(projectDir, "diagnostics"), { recursive: true });
    await writeDiagnostic(projectDir, "first.json", {
      stage: "draft",
      chapter: 1,
      generatedAt: "2026-05-28T10:00:00.000Z",
      tokenUsage: { totalTokens: 30, promptTokens: 10, completionTokens: 20 },
    });
    await writeDiagnostic(projectDir, "second.json", {
      stage: "review",
      chapter: 2,
      generatedAt: "2026-05-28T11:00:00.000Z",
      tokenUsage: { totalTokens: 40, promptTokens: 15, completionTokens: 25 },
      cacheMetrics: { promptCacheHitTokens: 12, promptCacheMissTokens: 8 },
    });

    const summary = await readUsageSummary(projectDir);

    expect(summary).toMatchObject({
      diagnosticsAvailable: true,
      diagnosticsCount: 2,
      totalTokens: 70,
      promptTokens: 25,
      completionTokens: 45,
      cacheHitTokens: 12,
      cacheMissTokens: 8,
    });
    expect(summary.diagnosticsWarnings).toEqual([]);
  });

  it("returns an empty summary for an empty diagnostics folder", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "story-engine-usage-summary-empty-"));
    await mkdir(join(projectDir, "diagnostics"), { recursive: true });

    const summary = await readUsageSummary(projectDir);

    expect(summary).toMatchObject({
      diagnosticsAvailable: false,
      diagnosticsCount: 0,
      totalTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      diagnosticsWarnings: [],
    });
  });

  it("caps diagnostics file count and reports a controlled warning", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "story-engine-usage-summary-count-cap-"));
    await mkdir(join(projectDir, "diagnostics"), { recursive: true });
    await Promise.all(Array.from({ length: EXPECTED_MAX_USAGE_SUMMARY_FILES + 3 }, (_, index) => writeDiagnostic(projectDir, `${String(index).padStart(3, "0")}.json`, {
      stage: "draft",
      chapter: index + 1,
      generatedAt: `2026-05-28T10:${String(index % 60).padStart(2, "0")}:00.000Z`,
      tokenUsage: { totalTokens: 1, promptTokens: 1, completionTokens: 0 },
    })));

    const summary = await readUsageSummary(projectDir);

    expect(summary.diagnosticsCount).toBe(EXPECTED_MAX_USAGE_SUMMARY_FILES);
    expect(summary.totalTokens).toBe(EXPECTED_MAX_USAGE_SUMMARY_FILES);
    expect(summary.diagnosticsWarnings).toContain("diagnostics_file_count_limit");
    expect(JSON.stringify(summary.diagnosticsWarnings)).not.toContain(projectDir);
  });

  it("skips oversized diagnostics files and reports a controlled warning", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "story-engine-usage-summary-size-cap-"));
    await mkdir(join(projectDir, "diagnostics"), { recursive: true });
    await writeDiagnostic(projectDir, "small.json", {
      stage: "draft",
      chapter: 1,
      generatedAt: "2026-05-28T10:00:00.000Z",
      tokenUsage: { totalTokens: 7, promptTokens: 3, completionTokens: 4 },
    });
    await writeFile(join(projectDir, "diagnostics", "oversized.json"), JSON.stringify({
      stage: "oversized",
      payload: "x".repeat(EXPECTED_MAX_USAGE_SUMMARY_FILE_BYTES + 1),
    }), "utf-8");

    const summary = await readUsageSummary(projectDir);

    expect(summary.diagnosticsCount).toBe(1);
    expect(summary.totalTokens).toBe(7);
    expect(summary.diagnosticsWarnings).toContain("diagnostics_file_size_limit");
    expect(JSON.stringify(summary.diagnosticsWarnings)).not.toContain(projectDir);
  });

  it("classifies access cards as key items instead of money", () => {
    const [asset] = createInitialAssetItems({
      ownerCharacterId: "char-test",
      ownerName: "许澄",
      currentLocationName: "海港集团总部顶层会议室",
      initialAssets: ["黑色权限卡"],
      keyItems: ["黑色权限卡"],
      resourceLimits: [],
    });

    expect(asset).toMatchObject({
      name: "黑色权限卡",
      type: "keyItem",
      isPlotCritical: true,
    });
  });

  it("does not let a stale workspace flow hide an already committed chapter", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "story-engine-workspace-snapshot-"));
    await mkdir(join(projectDir, "chapters"), { recursive: true });
    await mkdir(join(projectDir, "drafts", "fast"), { recursive: true });
    await mkdir(join(projectDir, ".story-engine-ui", "chapter-workspaces"), { recursive: true });
    const chapterContent = "# 第二章 纸灰\n\n沈砚从檐影里走出来，她拍了拍林远的肩膀。\n";
    await writeFile(defaultCommittedChapterPath(projectDir, 2), chapterContent, "utf-8");
    await writeFile(defaultDraftPath(projectDir, 2), chapterContent, "utf-8");
    await writeFile(chapterWorkspacePath(projectDir, 2), JSON.stringify({
      chapter: 2,
      flowStatus: "quality_checked",
      draftContent: chapterContent,
      messages: [{ id: "old-quality", role: "assistant", content: "旧质检消息" }],
      selectedAdviceCardKeys: [],
    }), "utf-8");

    const snapshot = await readChapterWorkspaceSnapshot(projectDir, 2);

    expect(snapshot.flowStatus).toBe("committed");
    expect(snapshot.draftContent).toBe(chapterContent);
    expect(snapshot.messages).toEqual([]);
  });

  it("drops stale pre-commit messages from committed snapshots without a completion message", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "story-engine-workspace-committed-"));
    await mkdir(join(projectDir, "chapters"), { recursive: true });
    await mkdir(join(projectDir, "drafts", "fast"), { recursive: true });
    await mkdir(join(projectDir, ".story-engine-ui", "chapter-workspaces"), { recursive: true });
    const chapterContent = "# 第二章 纸灰\n\n沈砚从檐影里走出来，她拍了拍林远的肩膀。\n";
    await writeFile(defaultCommittedChapterPath(projectDir, 2), chapterContent, "utf-8");
    await writeFile(defaultDraftPath(projectDir, 2), chapterContent, "utf-8");
    await writeFile(chapterWorkspacePath(projectDir, 2), JSON.stringify({
      chapter: 2,
      flowStatus: "committed",
      draftContent: chapterContent,
      messages: [{ id: "old-block", role: "assistant", content: "入库被质检拦截" }],
      selectedAdviceCardKeys: [],
    }), "utf-8");

    const snapshot = await readChapterWorkspaceSnapshot(projectDir, 2);

    expect(snapshot.flowStatus).toBe("committed");
    expect(snapshot.messages).toEqual([]);
  });

  it("keeps post-commit foundation Agent chat messages after refresh", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "story-engine-workspace-agent-chat-"));
    await mkdir(join(projectDir, "chapters"), { recursive: true });
    await mkdir(join(projectDir, "drafts", "fast"), { recursive: true });
    await mkdir(join(projectDir, ".story-engine-ui", "chapter-workspaces"), { recursive: true });
    const chapterContent = "# 第二章 纸灰\n\n沈砚从檐影里走出来，她拍了拍林远的肩膀。\n";
    await writeFile(defaultCommittedChapterPath(projectDir, 2), chapterContent, "utf-8");
    await writeFile(defaultDraftPath(projectDir, 2), chapterContent, "utf-8");
    await writeFile(chapterWorkspacePath(projectDir, 2), JSON.stringify({
      chapter: 2,
      flowStatus: "committed",
      draftContent: chapterContent,
      messages: [
        { id: "user-rename", role: "user", content: "把苏晓薇当前目标改成保护主角" },
        {
          id: "assistant-foundation-applied-1",
          role: "assistant",
          content: "已更新苏晓薇的角色资料。\n资料已更新，可撤回本次修改。",
        },
      ],
      selectedAdviceCardKeys: [],
    }), "utf-8");

    const snapshot = await readChapterWorkspaceSnapshot(projectDir, 2);

    expect(snapshot.flowStatus).toBe("committed");
    expect(snapshot.messages).toHaveLength(2);
    expect(snapshot.messages.map((message) => message.content)).toEqual([
      "把苏晓薇当前目标改成保护主角",
      "已更新苏晓薇的角色资料。\n资料已更新，可撤回本次修改。",
    ]);
  });

  it("reports draft and committed file presence separately", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "story-engine-workspace-file-state-"));
    await mkdir(join(projectDir, "chapters"), { recursive: true });
    await mkdir(join(projectDir, "drafts", "fast"), { recursive: true });
    await writeFile(defaultDraftPath(projectDir, 1), "# 第一章 · 草稿\n\n只有工作稿。", "utf-8");
    await writeFile(defaultCommittedChapterPath(projectDir, 2), "# 第二章 · 正式\n\n正式正文。", "utf-8");
    await writeFile(defaultDraftPath(projectDir, 2), "# 第二章 · 草稿改动\n\n工作稿改动。", "utf-8");

    const draftOnly = await readChapterWorkspaceSnapshot(projectDir, 1);
    const committedWithDraft = await readChapterWorkspaceSnapshot(projectDir, 2);

    expect(draftOnly).toMatchObject({
      hasDraftFile: true,
      hasCommittedChapter: false,
      draftTitle: "草稿",
    });
    expect(committedWithDraft).toMatchObject({
      hasDraftFile: true,
      hasCommittedChapter: true,
      draftTitle: "草稿改动",
    });
  });

  it("uses committed chapter content when no draft or workspace snapshot exists", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "story-engine-committed-only-"));
    await mkdir(join(projectDir, "chapters"), { recursive: true });
    await mkdir(join(projectDir, "drafts", "fast"), { recursive: true });
    await writeFile(defaultCommittedChapterPath(projectDir, 1), "# 第一章 · 正式一\n\n正式章节一。", "utf-8");
    await writeFile(defaultCommittedChapterPath(projectDir, 2), "# 第二章 · 正式二\n\n正式章节二。", "utf-8");
    await writeFile(defaultCommittedChapterPath(projectDir, 3), "# 第三章 · 正式三\n\n正式章节三。", "utf-8");

    const snapshot = await readChapterWorkspaceSnapshot(projectDir, 3);

    expect(snapshot).toMatchObject({
      chapter: 3,
      flowStatus: "committed",
      hasCommittedChapter: true,
      hasDraftFile: false,
      draftTitle: "正式三",
    });
    expect(snapshot.draftContent).toContain("# 第三章 · 正式三");
    expect(snapshot.draftContent).toContain("正式章节三。");
    expect(snapshot.draftContent).not.toContain("还没有草稿正文");
    await expect(access(chapterWorkspacePath(projectDir, 3))).rejects.toThrow();
  });

  it("does not let a stale placeholder workspace override committed chapter content", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "story-engine-committed-stale-workspace-"));
    await mkdir(join(projectDir, "chapters"), { recursive: true });
    await mkdir(join(projectDir, ".story-engine-ui", "chapter-workspaces"), { recursive: true });
    await writeFile(defaultCommittedChapterPath(projectDir, 3), "# 第三章 · 正式三\n\n正式章节三。", "utf-8");
    await writeFile(chapterWorkspacePath(projectDir, 3), JSON.stringify({
      chapter: 3,
      flowStatus: "idle",
      draftTitle: "正式一",
      draftContent: "还没有草稿正文。\n\n你可以在右侧章节对话里输入第 1 章方向。",
      messages: [{ id: "stale", role: "assistant", content: "旧占位消息" }],
      selectedAdviceCardKeys: [],
    }), "utf-8");

    const snapshot = await readChapterWorkspaceSnapshot(projectDir, 3);

    expect(snapshot).toMatchObject({
      chapter: 3,
      flowStatus: "committed",
      hasCommittedChapter: true,
      hasDraftFile: false,
      draftTitle: "正式三",
      messages: [],
    });
    expect(snapshot.draftContent).toContain("# 第三章 · 正式三");
    expect(snapshot.draftContent).not.toContain("还没有草稿正文");
  });

  it("生成被打断：workspace 截断但 drafts/fast 更长 → 以文件为准并改成草稿中（dogfood F1）", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "story-engine-gen-interrupt-"));
    await mkdir(join(projectDir, "drafts", "fast"), { recursive: true });
    await mkdir(join(projectDir, ".story-engine-ui", "chapter-workspaces"), { recursive: true });
    const fullDraft = `# 第四章 · 完整\n\n${"完整段落。".repeat(80)}\n`;
    const truncated = "# 第四章 · 完整\n\n开头几个字。\n";
    await writeFile(defaultDraftPath(projectDir, 4), fullDraft, "utf-8");
    await writeFile(chapterWorkspacePath(projectDir, 4), JSON.stringify({
      chapter: 4,
      flowStatus: "draft_generating",
      generationInterrupted: true,
      draftTitle: "第四章 · 完整",
      draftContent: truncated,
      messages: [],
      selectedAdviceCardKeys: [],
    }), "utf-8");

    const snapshot = await readChapterWorkspaceSnapshot(projectDir, 4);

    expect(snapshot.flowStatus).toBe("draft_ready");
    expect(snapshot.draftContent).toBe(fullDraft);
    expect(snapshot.recoveredFromDraftFile).toBe(true);
    expect(snapshot.generationInterrupted).toBe(true);
  });

  it("非生成期故意短写：不因文件更长而强行覆盖 workspace（dogfood F1 护栏）", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "story-engine-intentional-short-"));
    await mkdir(join(projectDir, "drafts", "fast"), { recursive: true });
    await mkdir(join(projectDir, ".story-engine-ui", "chapter-workspaces"), { recursive: true });
    // 无 generationInterrupted、非 draft_generating：读侧仍按既有口径（有草稿文件则用文件）。
    // 本用例验证：没有中断标志时不会额外标 recoveredFromDraftFile。
    const fileDraft = "# 短章\n\n磁盘稿。\n";
    await writeFile(defaultDraftPath(projectDir, 1), fileDraft, "utf-8");
    await writeFile(chapterWorkspacePath(projectDir, 1), JSON.stringify({
      chapter: 1,
      flowStatus: "draft_ready",
      draftContent: "我故意删短了。",
      messages: [],
      selectedAdviceCardKeys: [],
    }), "utf-8");

    const snapshot = await readChapterWorkspaceSnapshot(projectDir, 1);
    expect(snapshot.recoveredFromDraftFile).toBeUndefined();
    expect(snapshot.flowStatus).toBe("draft_ready");
    // 既有口径：有 drafts/fast 时以文件为准（与生成中断恢复无关）
    expect(snapshot.draftContent).toBe(fileDraft);
  });

  it("includes workspace-only snapshots in UI chapter file details", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "story-engine-workspace-only-state-"));
    await mkdir(join(projectDir, ".story-engine-ui", "chapter-workspaces"), { recursive: true });
    await writeFile(chapterWorkspacePath(projectDir, 4), JSON.stringify({
      chapter: 4,
      flowStatus: "draft_ready",
      draftTitle: "第四章工作区",
      draftContent: "# 第四章工作区\n\n尚未保存到 drafts/fast。",
      messages: [],
      selectedAdviceCardKeys: [],
    }), "utf-8");

    const overview = await withUiOverviewDetails(projectDir, {
      project: { title: "测试书", genre: "都市", currentChapter: 1 },
      storyStatus: {},
      hooks: { activeCount: 0, touchedCount: 0, resolvedCount: 0, activeItems: [] },
      threads: { total: 0, open: 0, touched: 0, done: 0, openIntents: 0, cleanupVisibleCount: 0, keyOpenItems: [] },
      arcGoals: { activeCount: 0, touchedCount: 0, completedCount: 0, activeItems: [] },
      timeline: { recentEvents: [], earlierSummary: [], macroSummary: [] },
      characters: { knownCharacters: [] },
      world: { activeLocations: [], importantFacts: [], protectedSecrets: [] },
      maintenance: {
        diagnosticsAvailable: false,
        cleanupVisibleCount: 0,
        markDoneCandidateCount: 0,
        mergeDisabled: true,
        dropDisabled: true,
        confirmPolicy: { markDone: "manual_only", merge: "disabled", drop: "disabled" },
      },
      uiHints: { recommendedNextPanels: [], warnings: [], disabledActions: [] },
    } as unknown as Parameters<typeof withUiOverviewDetails>[1]);

    expect(overview.uiChapterFiles).toContainEqual(expect.objectContaining({
      chapter: 4,
      hasWorkspaceSnapshot: true,
      hasDraftFile: false,
      hasCommittedChapter: false,
      workspaceTitle: "第四章工作区",
    }));
  });

  // 真机谎报 bug 根因：第1章只是被打开过（workspace 文件在）且 drafts/fast/.md 里只有显示用空草稿占位符，
  // 旧逻辑按「文件存在 / 内容非空」判，把它当成「有草稿未入库」→ agent 说「第1章已有内容」、用户打开却是空的。
  // 修后：占位符不算真草稿(hasDraftFile=false)、空 workspace 不算(hasWorkspaceDraft 缺)，但仍记「被打开过」供导航。
  it("占位符 .md / 空 workspace 不算「有草稿」，真 workspace 草稿才算", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "story-engine-placeholder-draft-"));
    await mkdir(join(projectDir, "drafts", "fast"), { recursive: true });
    await mkdir(join(projectDir, ".story-engine-ui", "chapter-workspaces"), { recursive: true });
    await writeFile(defaultDraftPath(projectDir, 1), "还没有草稿正文。\n\n你可以在右侧章节对话里输入第 1 章方向，先整理本章方案，再生成草稿。\n", "utf-8");
    await writeFile(chapterWorkspacePath(projectDir, 1), JSON.stringify({
      chapter: 1, flowStatus: "idle", draftContent: "", messages: [], selectedAdviceCardKeys: [],
    }), "utf-8");
    await writeFile(chapterWorkspacePath(projectDir, 2), JSON.stringify({
      chapter: 2, flowStatus: "draft_ready", draftTitle: "真章", draftContent: "# 真章\n\n这是真的草稿正文，足够长足够真。", messages: [], selectedAdviceCardKeys: [],
    }), "utf-8");

    const overview = await withUiOverviewDetails(projectDir, {
      project: { title: "测试书", genre: "都市", currentChapter: 1 },
      storyStatus: {},
      hooks: { activeCount: 0, touchedCount: 0, resolvedCount: 0, activeItems: [] },
      threads: { total: 0, open: 0, touched: 0, done: 0, openIntents: 0, cleanupVisibleCount: 0, keyOpenItems: [] },
      arcGoals: { activeCount: 0, touchedCount: 0, completedCount: 0, activeItems: [] },
      timeline: { recentEvents: [], earlierSummary: [], macroSummary: [] },
      characters: { knownCharacters: [] },
      world: { activeLocations: [], importantFacts: [], protectedSecrets: [] },
      maintenance: {
        diagnosticsAvailable: false,
        cleanupVisibleCount: 0,
        markDoneCandidateCount: 0,
        mergeDisabled: true,
        dropDisabled: true,
        confirmPolicy: { markDone: "manual_only", merge: "disabled", drop: "disabled" },
      },
      uiHints: { recommendedNextPanels: [], warnings: [], disabledActions: [] },
    } as unknown as Parameters<typeof withUiOverviewDetails>[1]);

    const ch1 = (overview.uiChapterFiles ?? []).find((c) => c.chapter === 1);
    expect(ch1, "第1章应在 uiChapterFiles 里").toBeDefined();
    expect(ch1?.hasDraftFile, "占位符 .md 不算真草稿").toBe(false);
    expect(ch1?.hasWorkspaceDraft ?? false, "空 workspace 不算有草稿").toBe(false);
    expect(ch1?.hasWorkspaceSnapshot, "但确实被打开过(导航仍可用)").toBe(true);

    const ch2 = (overview.uiChapterFiles ?? []).find((c) => c.chapter === 2);
    expect(ch2?.hasWorkspaceDraft, "workspace 里有真草稿则算有草稿").toBe(true);
  });

  it("projects committed character state fields into UI overview details", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "story-engine-character-detail-state-"));
    await mkdir(join(projectDir, "characters", "lin-xiao"), { recursive: true });
    await Promise.all([
      writeFile(join(projectDir, "characters", "lin-xiao", "profile.json"), `${JSON.stringify({
        id: "lin-xiao",
        name: "林晓",
        identity: "守护者",
      }, null, 2)}\n`, "utf-8"),
      writeFile(join(projectDir, "characters", "lin-xiao", "state.json"), `${JSON.stringify({
        characterId: "lin-xiao",
        mood: "冷静",
        currentGoal: "保护主角",
        recentEvents: ["完成角色状态确认写入封测"],
        relationshipToUser: "信任",
      }, null, 2)}\n`, "utf-8"),
    ]);

    const overview = await withUiOverviewDetails(projectDir, {
      project: { title: "测试书", genre: "都市", currentChapter: 1 },
      storyStatus: {},
      hooks: { activeCount: 0, touchedCount: 0, resolvedCount: 0, activeItems: [] },
      threads: { total: 0, open: 0, touched: 0, done: 0, openIntents: 0, cleanupVisibleCount: 0, keyOpenItems: [] },
      arcGoals: { activeCount: 0, touchedCount: 0, completedCount: 0, activeItems: [] },
      timeline: { recentEvents: [], earlierSummary: [], macroSummary: [] },
      characters: { knownCharacters: [] },
      world: { activeLocations: [], importantFacts: [], protectedSecrets: [] },
      maintenance: {
        diagnosticsAvailable: false,
        cleanupVisibleCount: 0,
        markDoneCandidateCount: 0,
        mergeDisabled: true,
        dropDisabled: true,
        confirmPolicy: { markDone: "manual_only", merge: "disabled", drop: "disabled" },
      },
      uiHints: { recommendedNextPanels: [], warnings: [], disabledActions: [] },
    } as unknown as Parameters<typeof withUiOverviewDetails>[1]);

    expect(overview.characterDetails?.[0]).toMatchObject({
      id: "lin-xiao",
      name: "林晓",
      mood: "冷静",
      currentGoal: "保护主角",
      recentEvents: ["完成角色状态确认写入封测"],
      relationshipToUser: "信任",
    });
  });
});

describe("limitFoundationChatHistory", () => {
  const message = (index: number, content = `消息${index}`) => ({ role: index % 2 === 0 ? "user" as const : "assistant" as const, content });

  it("keeps at most 40 recent messages", () => {
    const input = Array.from({ length: 60 }, (_, index) => message(index));
    const result = limitFoundationChatHistory(input);
    expect(result).toHaveLength(40);
    expect(result.at(-1)?.content).toBe("消息59");
    expect(result[0]?.content).toBe("消息20");
  });

  it("cuts older messages when the character budget is exceeded but always keeps the newest", () => {
    const big = "字".repeat(20000);
    const input = [message(0, big), message(1, big), message(2, "最新消息")];
    const result = limitFoundationChatHistory(input);
    expect(result.at(-1)?.content).toBe("最新消息");
    expect(result.length).toBeLessThan(3);
  });

  it("returns short histories unchanged", () => {
    const input = [message(0), message(1)];
    expect(limitFoundationChatHistory(input)).toEqual(input);
  });
});

describe("resolveFoundationUpdateTargetId", () => {
  it("treats generic character labels as missing ids and falls back to the only real character", () => {
    const resolved = resolveFoundationUpdateTargetId({
      actionType: "update_character_detail",
      targetId: "角色",
      knownEntities: {
        characters: [{ id: "char-ffe5af", name: "陆沉" }],
        locations: [],
        assets: [],
      },
    });

    expect(resolved).toBe("char-ffe5af");
  });

  it("does not pass generic character labels through when multiple characters exist", () => {
    const resolved = resolveFoundationUpdateTargetId({
      actionType: "update_character_detail",
      targetId: "主角",
      knownEntities: {
        characters: [
          { id: "char-a", name: "陆沉" },
          { id: "char-b", name: "陆溪" },
        ],
        locations: [],
        assets: [],
      },
    });

    expect(resolved).toBeUndefined();
  });
});

describe("readWorkspaceMessages self-heals legacy mock seed pollution", () => {
  it("drops legacy mock seed messages (msg-0*) while keeping real messages", () => {
    // Simulates an already-polluted chapter-0001.json snapshot on disk:
    // the two mockData末世种子 (msg-001 / msg-002) plus genuine runtime messages.
    const polluted = [
      {
        id: "msg-001",
        role: "assistant",
        content: "末世来临，丧尸围城，幸存者必须……",
      },
      {
        id: "msg-002",
        role: "user",
        content: "继续推进末世剧情",
      },
      {
        id: "assistant-1716100000000-abc",
        role: "assistant",
        content: "好的，我们来推进这一章。",
      },
      {
        id: "user-1716100001000-def",
        role: "user",
        content: "主角应该先去图书馆。",
      },
    ];

    const result = readWorkspaceMessages(polluted);

    const ids = result.map((message) => message.id);
    expect(ids).not.toContain("msg-001");
    expect(ids).not.toContain("msg-002");
    expect(ids).toContain("assistant-1716100000000-abc");
    expect(ids).toContain("user-1716100001000-def");
    expect(result).toHaveLength(2);
    expect(result.some((message) => message.content.includes("末世"))).toBe(false);
  });

  it("保留 thinking 与 toolSteps，不在 80 条处截断", () => {
    const input = Array.from({ length: 100 }, (_, i) => ({
      id: `assistant-${i}`,
      role: "assistant",
      content: `c${i}`,
    }));
    input[99] = {
      id: "assistant-99",
      role: "assistant",
      content: "末条",
      thinking: "我在想…",
      toolSteps: [{ id: "t1", label: "read_state_overview", status: "done" }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const out = readWorkspaceMessages(input);
    expect(out).toHaveLength(100); // 不再砍到 80
    expect(out[99].thinking).toBe("我在想…"); // thinking 保留
    expect(out[99].toolSteps?.[0]).toMatchObject({ id: "t1", label: "read_state_overview" }); // toolSteps 保留
  });

  it("保留合法 segments（有序分段时间线），丢弃非法项 —— 刷新后历史也分段", () => {
    const input = [
      {
        id: "assistant-1",
        role: "assistant",
        content: "建议先写开场。",
        toolSteps: [{ id: "c1", label: "读取故事状态", status: "completed" }],
        segments: [
          { kind: "reasoning", text: "先读状态。" },
          { kind: "tool", toolCallId: "c1" },
          { kind: "text", text: "建议先写开场。" },
          { kind: "bogus", text: "非法 kind" }, // 丢
          { kind: "reasoning" }, // 缺 text → 丢
          { kind: "tool" }, // 缺 toolCallId → 丢
          "not-an-object", // 丢
        ],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    ];
    const out = readWorkspaceMessages(input);
    expect(out[0].segments).toEqual([
      { kind: "reasoning", text: "先读状态。" },
      { kind: "tool", toolCallId: "c1" },
      { kind: "text", text: "建议先写开场。" },
    ]);
  });

  it("segments 非数组或缺省 → 不带 segments 字段（向后兼容旧消息）", () => {
    const out = readWorkspaceMessages([
      { id: "assistant-1", role: "assistant", content: "你好" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { id: "assistant-2", role: "assistant", content: "你好", segments: "oops" } as any,
    ]);
    expect(out[0].segments).toBeUndefined();
    expect(out[1].segments).toBeUndefined();
  });

  it("turnSnapshots round-trip：合法项保留，坏项剔除，超限截断，空数组不写字段", () => {
    const out = readWorkspaceMessages([
      {
        id: "assistant-snap-1",
        role: "assistant",
        content: "已写入设定。",
        turnSnapshots: [
          { toolName: "foundation_write", snapshotId: "snap-abc", chapterNumber: 2 },
          { toolName: "", snapshotId: "snap-bad-empty-tool" }, // 丢
          { toolName: "generate_draft", snapshotId: "" }, // 丢
          { toolName: "commit_apply", snapshotId: "snap-ok-no-ch" },
          { toolName: "x", snapshotId: "snap-bad-ch", chapterNumber: -1 }, // chapter 非法 → 整项丢
          { toolName: "y", snapshotId: "snap-bad-ch2", chapterNumber: 0 }, // 非正整数 → 丢
          "not-an-object",
          ...Array.from({ length: 25 }, (_, i) => ({
            toolName: `tool-${i}`,
            snapshotId: `snap-${i}`,
          })),
        ],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      {
        id: "assistant-snap-empty",
        role: "assistant",
        content: "无快照",
        turnSnapshots: [],
      },
    ]);

    expect(out[0].turnSnapshots).toEqual([
      { toolName: "foundation_write", snapshotId: "snap-abc", chapterNumber: 2 },
      { toolName: "commit_apply", snapshotId: "snap-ok-no-ch" },
      ...Array.from({ length: 18 }, (_, i) => ({
        toolName: `tool-${i}`,
        snapshotId: `snap-${i}`,
      })),
    ]);
    expect(out[0].turnSnapshots).toHaveLength(20);
    expect(out[1].turnSnapshots).toBeUndefined();
  });

  it("消息级报告/元数据字段 round-trip：卡片与 warnings 保留；旧格式不多不少", () => {
    const aiReviewReport = {
      ok: true,
      summary: "审稿完成",
      issues: [{ id: "i1", severity: "high", title: "节奏偏慢", detail: "…" }],
    };
    const commitReport = { chapter: 3, transactionFinalized: true, changedFiles: ["chapters/003.md"] };
    const qualityReport = {
      ok: true,
      blocking: [{ id: "b1", message: "硬伤" }],
      soft: [{ id: "s1", message: "软提示" }],
    };
    const draftReview = {
      ok: true,
      summary: "审校清单",
      issues: [{ id: "d1", category: "consistency", title: "人名", detail: "…", quote: "顾长风" }],
    };
    const aiFlavorReport = {
      ok: true,
      summary: "有 AI 腔",
      violations: [{ id: "v1", text: "不禁感慨", reason: "套话", severity: "medium" }],
      usedFallback: false,
    };

    const out = readWorkspaceMessages([
      {
        id: "assistant-reports",
        role: "assistant",
        content: "本回合做完了。",
        intentTitle: "审稿并入库",
        affectedScopes: ["full", "foundation", "bogus", 1],
        aiFlavorReport,
        aiFlavorFixedIds: ["v1", "", ...Array.from({ length: 60 }, (_, i) => `fix-${i}`)],
        aiReviewReport,
        draftReview,
        qualityReport,
        commitReport,
        nameConsistencyWarnings: [
          { establishedName: "顾长风", driftedVariant: "顾长峰", message: "疑似写歪" },
          { establishedName: "", driftedVariant: "x", message: "坏" },
          "nope",
        ],
        staleThreadWarnings: [
          {
            kind: "foreshadowing",
            title: "码头暗号",
            lastTouchedChapter: 1,
            chaptersSinceTouched: 4,
            message: "超 3 章未触及",
          },
          { kind: "thread", title: "缺数字", message: "坏" },
        ],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      { id: "assistant-legacy", role: "assistant", content: "旧消息无报告字段" },
    ]);

    const msg = out[0];
    expect(msg.intentTitle).toBe("审稿并入库");
    expect(msg.affectedScopes).toEqual(["full", "foundation"]);
    expect(msg.aiFlavorReport).toEqual(aiFlavorReport);
    expect(msg.aiFlavorFixedIds).toEqual(["v1", ...Array.from({ length: 49 }, (_, i) => `fix-${i}`)]);
    expect(msg.aiReviewReport).toEqual(aiReviewReport);
    expect(msg.draftReview).toEqual(draftReview);
    expect(msg.qualityReport).toEqual(qualityReport);
    expect(msg.commitReport).toEqual(commitReport);
    expect(msg.nameConsistencyWarnings).toEqual([
      { establishedName: "顾长风", driftedVariant: "顾长峰", message: "疑似写歪" },
    ]);
    expect(msg.staleThreadWarnings).toEqual([
      {
        kind: "foreshadowing",
        title: "码头暗号",
        lastTouchedChapter: 1,
        chaptersSinceTouched: 4,
        message: "超 3 章未触及",
      },
    ]);

    const legacy = out[1];
    expect(legacy).toEqual({ id: "assistant-legacy", role: "assistant", content: "旧消息无报告字段" });
    expect(legacy).not.toHaveProperty("turnSnapshots");
    expect(legacy).not.toHaveProperty("aiReviewReport");
    expect(legacy).not.toHaveProperty("commitReport");
    expect(legacy).not.toHaveProperty("intentTitle");
  });

  it("turnStartedAt/turnEndedAt round-trip：有限正数保留，坏值不写", () => {
    const out = readWorkspaceMessages([
      {
        id: "assistant-timed",
        role: "assistant",
        content: "耗时正常",
        turnStartedAt: 1752300000000,
        turnEndedAt: 1752300012345,
      },
      {
        id: "assistant-bad-times",
        role: "assistant",
        content: "坏耗时",
        turnStartedAt: -5,
        turnEndedAt: Number.NaN,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      {
        id: "assistant-string-times",
        role: "assistant",
        content: "字符串耗时",
        turnStartedAt: "1752300000000",
        turnEndedAt: Number.POSITIVE_INFINITY,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    ]);

    expect(out[0].turnStartedAt).toBe(1752300000000);
    expect(out[0].turnEndedAt).toBe(1752300012345);
    expect(out[1]).not.toHaveProperty("turnStartedAt");
    expect(out[1]).not.toHaveProperty("turnEndedAt");
    expect(out[2]).not.toHaveProperty("turnStartedAt");
    expect(out[2]).not.toHaveProperty("turnEndedAt");
  });

  it("nextStepPrompt round-trip：坏 choice 剔除、超限截断、清洗后为空则整字段不写", () => {
    const out = readWorkspaceMessages([
      {
        id: "assistant-next-step",
        role: "assistant",
        content: "接下来做什么？",
        nextStepPrompt: {
          question: "下一步想怎么走？",
          choices: [
            { label: "继续写第 3 章", intent: "写第 3 章草稿", recommended: true },
            { label: "先审稿", intent: "对第 2 章草稿做 AI 审稿" },
            { label: "", intent: "空 label 丢" }, // 丢
            { label: "空 intent 丢", intent: "" }, // 丢
            { label: "坏 recommended 丢", intent: "x", recommended: "yes" }, // 丢
            "not-an-object", // 丢
            ...Array.from({ length: 10 }, (_, i) => ({ label: `选项${i}`, intent: `意图${i}` })),
          ],
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      {
        id: "assistant-empty-choices",
        role: "assistant",
        content: "清洗后为空",
        nextStepPrompt: { question: "有问题但选项全坏", choices: [{ label: "", intent: "" }] },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      {
        id: "assistant-no-question",
        role: "assistant",
        content: "缺 question",
        nextStepPrompt: { question: "", choices: [{ label: "a", intent: "b" }] },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    ]);

    expect(out[0].nextStepPrompt).toEqual({
      question: "下一步想怎么走？",
      choices: [
        { label: "继续写第 3 章", intent: "写第 3 章草稿", recommended: true },
        { label: "先审稿", intent: "对第 2 章草稿做 AI 审稿" },
        ...Array.from({ length: 6 }, (_, i) => ({ label: `选项${i}`, intent: `意图${i}` })),
      ],
    });
    expect(out[0].nextStepPrompt?.choices).toHaveLength(8);
    expect(out[1]).not.toHaveProperty("nextStepPrompt");
    expect(out[2]).not.toHaveProperty("nextStepPrompt");
  });

  it("isErrorNotice/errorDetail round-trip：错误卡字段保留，旧消息不多写", () => {
    const out = readWorkspaceMessages([
      {
        id: "assistant-err",
        role: "assistant",
        content: "AI 服务暂时没响应，本次没有改动。",
        isErrorNotice: true,
        errorDetail: "Error from provider: boom",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      { id: "assistant-ok", role: "assistant", content: "正常回复" },
      {
        id: "assistant-err-false",
        role: "assistant",
        content: "不是错误",
        isErrorNotice: false,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    ]);
    expect(out[0].isErrorNotice).toBe(true);
    expect(out[0].errorDetail).toBe("Error from provider: boom");
    expect(out[1].isErrorNotice).toBeUndefined();
    expect(out[1].errorDetail).toBeUndefined();
    expect(out[2].isErrorNotice).toBeUndefined();
  });
});

function requestFromChunks(chunks: readonly Buffer[]): IncomingMessage {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  } as unknown as IncomingMessage;
}

async function writeDiagnostic(projectDir: string, fileName: string, value: unknown): Promise<void> {
  await writeFile(join(projectDir, "diagnostics", fileName), `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

describe("foundation delete suggestion parsing", () => {
  const fakeReport = { byCategory: { characters: [] } } as unknown as Awaited<ReturnType<typeof import("@actalk/story-engine").buildFoundationGapReport>>;

  it("accepts delete_foundation_entry as a known action type", () => {
    expect(readFoundationGapActionType("delete_foundation_entry")).toBe("delete_foundation_entry");
  });

  it("backfills targetId for update_character_detail from a known-entity name when the model omits it", () => {
    const knownEntities = {
      characters: [{ id: "char-lin-wan", name: "林晚" }],
      locations: [],
      assets: [],
    };
    const parsed = readGeneratedFoundationGapSuggestions([{
      category: "characters",
      actionType: "update_character_detail",
      before: { name: "林晚" },
      after: { extraFields: { 境界: "金丹期" } },
      requiresUserConfirm: true,
    }], [], fakeReport, "林晚突破金丹期了", knownEntities);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.targetId).toBe("char-lin-wan");
  });

  it("backfills targetId from after.name when before.name is absent", () => {
    const knownEntities = {
      characters: [{ id: "char-guo-xu", name: "林远" }],
      locations: [],
      assets: [],
    };
    const parsed = readGeneratedFoundationGapSuggestions([{
      category: "characters",
      actionType: "update_character_detail",
      after: { name: "林远", extraFields: { 境界: "筑基" } },
      requiresUserConfirm: true,
    }], [], fakeReport, "林远突破了", knownEntities);

    expect(parsed[0]?.targetId).toBe("char-guo-xu");
  });

  it("leaves targetId empty when no known character matches the suggestion name", () => {
    const knownEntities = {
      characters: [{ id: "char-lin-wan", name: "林晚" }],
      locations: [],
      assets: [],
    };
    const parsed = readGeneratedFoundationGapSuggestions([{
      category: "characters",
      actionType: "update_character_detail",
      before: { name: "无名氏" },
      after: { extraFields: { 境界: "金丹期" } },
      requiresUserConfirm: true,
    }], [], fakeReport, "无名氏突破金丹期了", knownEntities);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.targetId).toBeUndefined();
  });

  it("改4: leaves targetId empty when two known characters both contain the queried name (ambiguous)", () => {
    // 包含兜底下两个候选都含查询名「林晚」（无精确命中）→ 不赌第一个，诚实留空让下游 skip + 引导点名。
    const knownEntities = {
      characters: [
        { id: "char-lin-wan-a", name: "林晚（雷宗）" },
        { id: "char-lin-wan-b", name: "林晚（外院）" },
      ],
      locations: [],
      assets: [],
    };
    const parsed = readGeneratedFoundationGapSuggestions([{
      category: "characters",
      actionType: "update_character_detail",
      before: { name: "林晚" },
      after: { extraFields: { 境界: "金丹期" } },
      requiresUserConfirm: true,
    }], [], fakeReport, "林晚突破金丹期了", knownEntities);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.targetId).toBeUndefined();
  });

  it("改4: leaves targetId empty when two known characters share the exact same name (ambiguous)", () => {
    // 两个候选精确同名 → 同样不赌第一个。
    const knownEntities = {
      characters: [
        { id: "char-lin-wan-a", name: "林晚" },
        { id: "char-lin-wan-b", name: "林晚" },
      ],
      locations: [],
      assets: [],
    };
    const parsed = readGeneratedFoundationGapSuggestions([{
      category: "characters",
      actionType: "update_character_detail",
      before: { name: "林晚" },
      after: { extraFields: { 境界: "金丹期" } },
      requiresUserConfirm: true,
    }], [], fakeReport, "林晚突破金丹期了", knownEntities);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.targetId).toBeUndefined();
  });

  it("改3: backfills targetId from extractedEntityName when before/after carry no name", () => {
    // 模型只给 extractedEntityName（不在 before/after.name 里）也能回填，与下游名字来源对齐。
    const knownEntities = {
      characters: [{ id: "char-lin-wan", name: "林晚" }],
      locations: [],
      assets: [],
    };
    const parsed = readGeneratedFoundationGapSuggestions([{
      category: "characters",
      actionType: "update_character_detail",
      extractedEntityName: "林晚",
      after: { extraFields: { 境界: "金丹期" } },
      requiresUserConfirm: true,
    }], [], fakeReport, "林晚突破金丹期了", knownEntities);

    expect(parsed[0]?.targetId).toBe("char-lin-wan");
  });

  it("does not override an explicit model-provided targetId", () => {
    const knownEntities = {
      characters: [{ id: "char-lin-wan", name: "林晚" }],
      locations: [],
      assets: [],
    };
    const parsed = readGeneratedFoundationGapSuggestions([{
      category: "characters",
      actionType: "update_character_detail",
      targetId: "char-explicit",
      before: { name: "林晚" },
      after: { extraFields: { 境界: "金丹期" } },
      requiresUserConfirm: true,
    }], [], fakeReport, "林晚突破金丹期了", knownEntities);

    expect(parsed[0]?.targetId).toBe("char-explicit");
  });

  it("backfills targetId for update_location_detail and update_asset_status by name", () => {
    const knownEntities = {
      characters: [],
      locations: [{ id: "loc-thunder-peak", name: "雷霆峰" }],
      assets: [{ id: "asset-thunder-sword", name: "奔雷剑" }],
    };
    const location = readGeneratedFoundationGapSuggestions([{
      category: "locations",
      actionType: "update_location_detail",
      after: { name: "雷霆峰", extraFields: { 灵气浓度: "极盛" } },
      requiresUserConfirm: true,
    }], [], fakeReport, "雷霆峰灵气极盛", knownEntities);
    expect(location[0]?.targetId).toBe("loc-thunder-peak");

    const asset = readGeneratedFoundationGapSuggestions([{
      category: "assets",
      actionType: "update_asset_status",
      after: { name: "奔雷剑", status: "available" },
      requiresUserConfirm: true,
    }], [], fakeReport, "奔雷剑可用", knownEntities);
    expect(asset[0]?.targetId).toBe("asset-thunder-sword");
  });

  it("keeps confirmedByUser when parsing suggestions from request bodies", () => {
    const parsed = readFoundationGapSuggestions([{
      id: "ai-delete-1",
      gapId: "ai-gap-delete",
      category: "characters",
      actionType: "delete_foundation_entry",
      targetFile: "story/character-bible.json",
      targetPath: "$",
      targetId: "char-abc",
      before: { name: "苏晓薇" },
      after: null,
      rationale: "用户要求删除。",
      risk: "warning",
      requiresUserConfirm: true,
      confirmedByUser: true,
    }]);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.confirmedByUser).toBe(true);
  });

  it("normalizes model delete suggestions and drops invalid ones", () => {
    const valid = readGeneratedFoundationGapSuggestions([{
      category: "characters",
      actionType: "delete_foundation_entry",
      targetId: "char-abc",
      before: { name: "苏晓薇" },
      after: null,
      requiresUserConfirm: true,
    }], [], fakeReport, "删除角色苏晓薇");
    expect(valid).toHaveLength(1);
    expect(valid[0]?.targetFile).toBe("story/character-bible.json");
    expect(valid[0]?.targetPath).toBe("$");
    expect(valid[0]?.after).toBeNull();

    const missingTargetId = readGeneratedFoundationGapSuggestions([{
      category: "characters",
      actionType: "delete_foundation_entry",
      after: null,
      requiresUserConfirm: true,
    }], [], fakeReport, "删除角色");
    expect(missingTargetId).toHaveLength(0);

    const missingRuleText = readGeneratedFoundationGapSuggestions([{
      category: "world",
      actionType: "delete_foundation_entry",
      after: null,
      requiresUserConfirm: true,
    }], [], fakeReport, "删除世界观规则");
    expect(missingRuleText).toHaveLength(0);

    const validRule = readGeneratedFoundationGapSuggestions([{
      category: "world",
      actionType: "delete_foundation_entry",
      before: "规则A",
      after: null,
      requiresUserConfirm: true,
    }], [], fakeReport, "删除世界观规则：规则A");
    expect(validRule).toHaveLength(1);
    expect(validRule[0]?.targetFile).toBe("story/world-bible.json");
  });

  it("G2: gives same-category model suggestions distinct ids even when one existing suggestion can be reused for both", () => {
    // 真机复现：「他师父是云隐宗的长老」→ directArchive 一次产出两条同 characters 建议
    // （create_character 新增师父 + create_relationship 师徒关系），模型未带 id，触发 reusable 复用路径。
    // existingSuggestions 里有一条同 characters 建议，category-only 兜底会让两条都匹配它 →
    // 若两条共用同一 reusableSuggestion.id，下游按 id 去重会把师父那条吞掉。断言两条 id 互不相同。
    const existing: FoundationGapSuggestion[] = [{
      id: "ai-existing-char",
      gapId: "ai-gap-characters",
      category: "characters",
      actionType: "fill_missing_field",
      targetFile: "story/character-bible.json",
      targetPath: "$",
      before: {},
      after: {},
      rationale: "已有的同类建议。",
      risk: "warning",
      requiresUserConfirm: true,
    }];
    const parsed = readGeneratedFoundationGapSuggestions([
      {
        category: "characters",
        actionType: "create_character",
        after: { name: "云隐宗长老", identity: "师父" },
        requiresUserConfirm: true,
      },
      {
        category: "characters",
        actionType: "create_relationship",
        after: { from: "主角", to: "云隐宗长老", type: "师徒" },
        requiresUserConfirm: true,
      },
    ], existing, fakeReport, "他师父是云隐宗的长老");

    expect(parsed).toHaveLength(2);
    const ids = parsed.map((suggestion) => suggestion.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("G2: still reuses the stable existing id when a single suggestion updates the same existing entry", () => {
    // 正常语义保护：只有一条新建议、且精确匹配（category+actionType）到一条已有 suggestion 时，
    // 仍复用其稳定 id，以便下游把它当作「更新同一条资料」而非新增一条。
    const existing: FoundationGapSuggestion[] = [{
      id: "ai-stable-detail",
      gapId: "ai-gap-characters",
      category: "characters",
      actionType: "update_character_detail",
      targetFile: "story/character-bible.json",
      targetPath: "$",
      targetId: "char-lin-wan",
      before: { name: "林晚" },
      after: {},
      rationale: "已有的更新建议。",
      risk: "warning",
      requiresUserConfirm: true,
    }];
    const parsed = readGeneratedFoundationGapSuggestions([{
      category: "characters",
      actionType: "update_character_detail",
      before: { name: "林晚" },
      after: { extraFields: { 境界: "金丹期" } },
      requiresUserConfirm: true,
    }], existing, fakeReport, "林晚突破金丹期了");

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.id).toBe("ai-stable-detail");
  });
});


// 原子写口径锁（agent-41 审计：手写 tmp+rename 失败会留 .tmp 残留，三个 threads 工具已统一改用本助手）：
// 失败必须自清临时文件——残留 tmp 不只脏目录，还会被下一次快照 commit 扫进历史。
describe("writeFileAtomic 原子写（失败不留 tmp 残留）", () => {
  it("正常写：内容原子落盘", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-engine-atomic-ok-"));
    const target = join(dir, "threads.json");
    await writeFileAtomic(target, "{\"threads\":[]}\n");
    expect(await readFile(target, "utf-8")).toBe("{\"threads\":[]}\n");
  });

  it("rename 失败（目标是已存在目录）→ 抛错且同目录不留任何 .tmp 残留", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-engine-atomic-fail-"));
    const target = join(dir, "threads.json");
    await mkdir(target); // rename(文件, 已存在目录) 必失败（EISDIR/ENOTDIR），确定性地命中 catch 分支

    await expect(writeFileAtomic(target, "x")).rejects.toThrow();

    const residue = (await readdir(dir)).filter((entry) => entry.endsWith(".tmp"));
    expect(residue).toEqual([]);
  });
});

describe("commitFilesAtomically 多文件原子提交（失败不留 tmp 残留）", () => {
  it("全部就绪：逐文件原子落盘", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-engine-atomic-multi-ok-"));
    await commitFilesAtomically([
      { path: join(dir, "a.json"), content: "{\"a\":1}\n" },
      { path: join(dir, "b.json"), content: "{\"b\":2}\n" },
    ]);

    expect(await readFile(join(dir, "a.json"), "utf-8")).toBe("{\"a\":1}\n");
    expect(await readFile(join(dir, "b.json"), "utf-8")).toBe("{\"b\":2}\n");
    const residue = (await readdir(dir)).filter((entry) => entry.endsWith(".tmp"));
    expect(residue).toEqual([]);
  });

  it("提交段 rename 中途失败 → 抛错、已提交文件不回滚、未提交的 tmp 全清", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-engine-atomic-multi-fail-"));
    const committedTarget = join(dir, "a.json");
    const blockedTarget = join(dir, "blocked.json");
    await mkdir(blockedTarget); // rename(文件, 已存在目录) 必失败，确定性命中提交段 catch

    await expect(commitFilesAtomically([
      { path: committedTarget, content: "{\"a\":1}\n" },
      { path: blockedTarget, content: "{\"b\":2}\n" },
    ])).rejects.toThrow();

    // 文档口径：「部分提交」窗口不回滚已 rename 的文件，但绝不留 tmp 残渣（会被快照扫进 git）。
    expect(await readFile(committedTarget, "utf-8")).toBe("{\"a\":1}\n");
    const residue = (await readdir(dir)).filter((entry) => entry.endsWith(".tmp"));
    expect(residue).toEqual([]);
  });

  it("staging 段失败 → 已 staged 的 tmp 也全清（旧口径回归锁）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "story-engine-atomic-stage-fail-"));
    const missingDirTarget = join(dir, "no-such-dir", "b.json"); // 目录不存在 → writeFile 直接 ENOENT

    await expect(commitFilesAtomically([
      { path: join(dir, "a.json"), content: "{\"a\":1}\n" },
      { path: missingDirTarget, content: "{\"b\":2}\n" },
    ])).rejects.toThrow();

    const residue = (await readdir(dir)).filter((entry) => entry.endsWith(".tmp"));
    expect(residue).toEqual([]);
    // staging 段失败时原文件分毫未动
    await expect(readFile(join(dir, "a.json"), "utf-8")).rejects.toThrow();
  });
});
