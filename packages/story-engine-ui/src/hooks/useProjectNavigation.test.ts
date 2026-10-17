import { describe, expect, it } from "vitest";
import { __useProjectNavigationTest } from "./useProjectNavigation.js";
import { bookCreationPromptText } from "../utils/bookCreationPrompt.js";
import type { ChapterMessage, ChapterNavItem, ChapterWorkspaceData } from "../types.js";
import type { StateOverview } from "../api/types.js";

const cleanGreeting: readonly ChapterMessage[] = [
  { id: "state-overview-connected", role: "assistant", kind: "scaffolding", content: "已进入《测试项目》的章节工作区。" },
];

/**
 * 刚建好、还没动过的空书 overview（无章节·仅占位主角·无草稿）。
 * 历史上建书会种 1 个 active arc-goal（该种子来源已随极简空建退役），这里仍带上 arcGoals.activeCount=1，
 * 锁住「即便带这种建书噪声/历史项目，isFreshBook 也不被误判为『非空书』」这条护栏。
 */
const freshBookOverview = {
  project: { currentChapter: null },
  characters: { knownCharacters: [{ id: "protagonist", name: "主角" }] },
  hooks: { activeCount: 0 },
  threads: { total: 0 },
  arcGoals: { activeCount: 1 },
} as unknown as StateOverview;

/** 已有内容的书（有章节）。 */
const contentBookOverview = {
  project: { currentChapter: 3 },
  characters: { knownCharacters: [{ id: "protagonist", name: "主角" }, { id: "c2", name: "对手" }] },
  hooks: { activeCount: 2 },
  threads: { total: 4 },
  arcGoals: { activeCount: 1 },
} as unknown as StateOverview;

const mockSeed: readonly ChapterMessage[] = [
  { id: "msg-001", role: "user", content: "我想让主角去地下车库确认无线电信号源，但不要立刻揭开真相。" },
  { id: "msg-002", role: "assistant", content: "可以。当前主角昨晚通宵，状态疲惫……" },
];

const baseChapters: readonly ChapterNavItem[] = [
  { id: "ch-1", chapterNumber: 1, title: "第一章", status: "current" },
  { id: "ch-2", chapterNumber: 2, title: "下一章", status: "planned" },
];

describe("useProjectNavigation chapter status helpers", () => {
  it("restores the latest draft-only chapter on project open", () => {
    const chapterNumber = __useProjectNavigationTest.resolveInitialChapterNumber(
      Array.from({ length: 10 }, (_, index) => ({
        id: `ch-${index + 1}`,
        chapterNumber: index + 1,
        title: `第${index + 1}章`,
        status: index === 0 ? "current" as const : "draft" as const,
        hasDraftFile: true,
        hasCommittedChapter: false,
      })),
      1,
    );

    expect(chapterNumber).toBe(10);
  });

  it("restores the latest committed chapter when no working draft exists", () => {
    const chapterNumber = __useProjectNavigationTest.resolveInitialChapterNumber([
      { id: "ch-1", chapterNumber: 1, title: "第一章", status: "committed", hasCommittedChapter: true },
      { id: "ch-2", chapterNumber: 2, title: "第二章", status: "committed", hasCommittedChapter: true },
      { id: "ch-3", chapterNumber: 3, title: "下一章", status: "planned" },
    ], 1);

    expect(chapterNumber).toBe(2);
  });

  it("uses workspace snapshots only after draft and committed files", () => {
    const chapterNumber = __useProjectNavigationTest.resolveInitialChapterNumber([
      { id: "ch-1", chapterNumber: 1, title: "第一章", status: "current" },
      { id: "ch-4", chapterNumber: 4, title: "第四章", status: "draft", hasWorkspaceSnapshot: true },
    ], 1);

    expect(chapterNumber).toBe(4);
  });

  it("does not auto-mark previous draft chapters as committed when switching active chapter", () => {
    const chapters = __useProjectNavigationTest.updateChapterListForActive(
      baseChapters,
      2,
      "第二章",
      new Map([[1, { hasDraftFile: true, hasCommittedChapter: false }]]),
    );

    expect(chapters[0]).toMatchObject({
      chapterNumber: 1,
      status: "draft",
      hasDraftFile: true,
      hasCommittedChapter: false,
    });
    expect(chapters[1]).toMatchObject({
      chapterNumber: 2,
      status: "current",
      title: "第二章",
    });
  });

  it("keeps previous chapters committed only when a committed chapter file exists", () => {
    const chapters = __useProjectNavigationTest.updateChapterListForActive(
      baseChapters,
      2,
      "第二章",
      new Map([[1, { hasDraftFile: true, hasCommittedChapter: true }]]),
    );

    expect(chapters[0]).toMatchObject({
      chapterNumber: 1,
      status: "committed",
      hasDraftFile: true,
      hasCommittedChapter: true,
    });
  });

  it("keeps a manually selected chapter active even when newer drafts exist", () => {
    const chapters = __useProjectNavigationTest.updateChapterListForActive(
      Array.from({ length: 10 }, (_, index) => ({
        id: `ch-${index + 1}`,
        chapterNumber: index + 1,
        title: `第${index + 1}章`,
        status: "draft" as const,
        hasDraftFile: true,
        hasCommittedChapter: false,
      })),
      3,
      "第三章",
    );

    expect(chapters.find((chapter) => chapter.chapterNumber === 3)).toMatchObject({ status: "current", title: "第三章" });
    expect(chapters.find((chapter) => chapter.chapterNumber === 10)).toMatchObject({ status: "draft" });
  });

  it("uses the adapter clean greeting (not store residue) when opening a real project with no backend snapshot", () => {
    const messages = __useProjectNavigationTest.selectOpenProjectMessages({
      snapshotMessages: null,
      sessionMessages: mockSeed,
      workspaceMessages: cleanGreeting,
    });

    // No backend snapshot + residual mock seed in store → must fall back to the
    // adapter's clean greeting, never the end-of-world demo seed.
    expect(messages.some((m) => m.id === "msg-001" || m.id === "msg-002")).toBe(false);
    expect(messages.some((m) => m.content.includes("地下车库") || m.content.includes("无线电"))).toBe(false);
    expect(messages).toEqual(cleanGreeting);
  });

  it("prefers backend snapshot messages over everything when present", () => {
    const snapshotMessages: readonly ChapterMessage[] = [
      { id: "user-real", role: "user", content: "继续写下一章" },
    ];
    const messages = __useProjectNavigationTest.selectOpenProjectMessages({
      snapshotMessages,
      sessionMessages: mockSeed,
      workspaceMessages: cleanGreeting,
    });

    expect(messages).toEqual(snapshotMessages);
  });

  it("preserves a genuine prior session (real user turn) when no backend snapshot exists", () => {
    const realSession: readonly ChapterMessage[] = [
      { id: "user-1718000000", role: "user", content: "把主角名字改成林远" },
      { id: "assistant-1718000001", role: "assistant", content: "已把主角名改为林远。" },
    ];
    const messages = __useProjectNavigationTest.selectOpenProjectMessages({
      snapshotMessages: null,
      sessionMessages: realSession,
      workspaceMessages: cleanGreeting,
    });

    expect(messages).toEqual(realSession);
  });

  it("ignores workflow-only scaffolding sessions and uses the clean greeting", () => {
    const scaffolding: readonly ChapterMessage[] = [
      { id: "assistant-workflow-idle-1", role: "assistant", content: "我已读取当前故事状态。" },
    ];
    const messages = __useProjectNavigationTest.selectOpenProjectMessages({
      snapshotMessages: null,
      sessionMessages: scaffolding,
      workspaceMessages: cleanGreeting,
    });

    expect(messages).toEqual(cleanGreeting);
  });

  it("再入空书（无 backend snapshot·无真实历史）走开书语气开场白，而非章节 greeting", () => {
    const messages = __useProjectNavigationTest.selectOpenProjectMessages({
      snapshotMessages: null,
      sessionMessages: [],
      workspaceMessages: cleanGreeting,
      overview: freshBookOverview,
    });

    // 单条 assistant 开书开场白，与 handleCreateBook 同款文案。
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("assistant");
    expect(messages[0]?.content).toBe(bookCreationPromptText());
    // 不是章节 idle 的 workspace greeting。
    expect(messages[0]?.content).not.toBe(cleanGreeting[0]?.content);
  });

  it("有内容的书（有章节）即便无 snapshot/历史，仍走章节 greeting，不注入开书语气", () => {
    const messages = __useProjectNavigationTest.selectOpenProjectMessages({
      snapshotMessages: null,
      sessionMessages: [],
      workspaceMessages: cleanGreeting,
      overview: contentBookOverview,
    });

    expect(messages).toEqual(cleanGreeting);
    expect(messages[0]?.content).not.toBe(bookCreationPromptText());
  });

  it("空书但有 backend snapshot：绝不覆盖，沿用 snapshot 不注开书语气", () => {
    const snapshotMessages: readonly ChapterMessage[] = [
      { id: "user-real", role: "user", content: "继续写下一章" },
    ];
    const messages = __useProjectNavigationTest.selectOpenProjectMessages({
      snapshotMessages,
      sessionMessages: [],
      workspaceMessages: cleanGreeting,
      overview: freshBookOverview,
    });

    expect(messages).toEqual(snapshotMessages);
  });

  it("空书但有真实历史会话：绝不覆盖，沿用历史不注开书语气", () => {
    const realSession: readonly ChapterMessage[] = [
      { id: "user-1718000000", role: "user", content: "把主角名字改成林远" },
      { id: "assistant-1718000001", role: "assistant", content: "已把主角名改为林远。" },
    ];
    const messages = __useProjectNavigationTest.selectOpenProjectMessages({
      snapshotMessages: null,
      sessionMessages: realSession,
      workspaceMessages: cleanGreeting,
      overview: freshBookOverview,
    });

    expect(messages).toEqual(realSession);
  });

  // H5：「撤销到此」reload 时，磁盘对话文件被 git restore 还原成回合起点脏态（含刚撤销的孤儿消息）。
  // preferSession=true 让 openProject 忽略磁盘 snapshotMessages、改用 sessionStorage 的干净截断，避免孤儿复活。
  it("preferSession=true：忽略磁盘脏对话，用 sessionStorage 的干净截断（撤销后不复活孤儿气泡）", () => {
    const orphanOnDisk: readonly ChapterMessage[] = [
      { id: "user-orphan", role: "user", content: "删掉顾明" },
      { id: "assistant-orphan", role: "assistant", content: "已删除顾明。" },
    ];
    const cleanTruncated: readonly ChapterMessage[] = [
      { id: "user-1718000000", role: "user", content: "继续写下一章" },
      { id: "assistant-1718000001", role: "assistant", content: "好的。" },
    ];
    const messages = __useProjectNavigationTest.selectOpenProjectMessages({
      snapshotMessages: orphanOnDisk, // 磁盘还原成脏态
      sessionMessages: cleanTruncated, // sessionStorage 的干净截断
      workspaceMessages: cleanGreeting,
      preferSession: true,
    });
    expect(messages).toEqual(cleanTruncated);
    expect(messages.some((m) => m.id === "user-orphan" || m.id === "assistant-orphan")).toBe(false);
  });

  it("preferSession=true 且截断到空（撤销首个回合）：落到干净开场白，绝不回退磁盘孤儿", () => {
    const orphanOnDisk: readonly ChapterMessage[] = [
      { id: "user-orphan", role: "user", content: "删掉顾明" },
    ];
    const messages = __useProjectNavigationTest.selectOpenProjectMessages({
      snapshotMessages: orphanOnDisk,
      sessionMessages: [], // 撤销首个回合后对话被清空
      workspaceMessages: cleanGreeting,
      preferSession: true,
    });
    // 不是磁盘孤儿，而是干净开场白。
    expect(messages).toEqual(cleanGreeting);
    expect(messages.some((m) => m.id === "user-orphan")).toBe(false);
  });

  it("preferSession 缺省（普通开书）：磁盘 snapshot 仍优先（行为不变）", () => {
    const onDisk: readonly ChapterMessage[] = [{ id: "user-real", role: "user", content: "继续写下一章" }];
    const messages = __useProjectNavigationTest.selectOpenProjectMessages({
      snapshotMessages: onDisk,
      sessionMessages: [{ id: "user-stale", role: "user", content: "旧 session" }],
      workspaceMessages: cleanGreeting,
    });
    expect(messages).toEqual(onDisk);
  });

  it("不传 overview 时行为不变（仍回退到 workspace greeting）", () => {
    const messages = __useProjectNavigationTest.selectOpenProjectMessages({
      snapshotMessages: null,
      sessionMessages: [],
      workspaceMessages: cleanGreeting,
    });

    expect(messages).toEqual(cleanGreeting);
  });

  // 同名删后重建 / 新书串台 bug：书目录名按书名确定性生成(toSafeId)，同名删后重建拿到同一 projectPath，
  // 开书时后端没读到会话历史就回退内存消息，会把上一本书残留的对话误当本书历史端出来。
  // messagesWhenBackendSessionMissing：刚建的新书一律不用旧内存；非新书也只有重开同项目才允许回退。
  it("messagesWhenBackendSessionMissing：刚建的新书绝不沿用内存旧消息(防同名重建串台)，用开书开场白", () => {
    const messages = __useProjectNavigationTest.messagesWhenBackendSessionMissing({
      overview: freshBookOverview,
      storeMessages: mockSeed, // 内存里上一本书的真实对话
      allowStoreFallback: false,
    });
    expect(messages).not.toEqual(mockSeed);
    expect(messages.length).toBe(1);
    expect(__useProjectNavigationTest.isBookCreationGreeting(messages)).toBe(true);
  });

  it("messagesWhenBackendSessionMissing：重开同一已有内容项目时可回退内存消息", () => {
    const messages = __useProjectNavigationTest.messagesWhenBackendSessionMissing({
      overview: contentBookOverview,
      storeMessages: mockSeed,
      allowStoreFallback: true,
    });
    expect(messages).toEqual(mockSeed);
  });

  // 进来就干净（用户 2026-06-16 反馈）：开书「先跟 AI 聊天」流程已下线，进入工作台时没有真实历史对话
  // 就空着进——不塞开书/章节开场白、也不追加 idle 招呼，由空状态提示接管。
  it("entry：选中开书开场白(无真实对话) → 空着进", () => {
    const greeting: readonly ChapterMessage[] = [
      { id: "assistant-book-creation-1718000000", role: "assistant", content: bookCreationPromptText() },
    ];
    expect(__useProjectNavigationTest.entryChatMessages(greeting)).toEqual([]);
  });

  it("entry：真实历史对话 → 原样恢复，不再追加任何 idle 招呼", () => {
    const realSession: readonly ChapterMessage[] = [
      { id: "user-1", role: "user", content: "继续写下一章" },
    ];
    const result = __useProjectNavigationTest.entryChatMessages(realSession);

    expect(result).toEqual(realSession);
    // 不再被追加章节 idle「这章想写什么」招呼
    expect(result.some((m: ChapterMessage) => m.content.includes("这章想写什么"))).toBe(false);
  });

  it("entry：工作区「已进入《X》的章节工作区」开场白(无真实对话) → 空着进(用户实测场景)", () => {
    expect(__useProjectNavigationTest.entryChatMessages(cleanGreeting)).toEqual([]);
  });

  it("entry：按消息自带的 kind 认脚手架，不按文案（重构 P4）——AI 真回复里写了「已进入《X》」也照留", () => {
    const reply: ChapterMessage = { id: "assistant-agent-2", role: "assistant", content: "已进入《测试项目》的第二卷，接下来写哪章？" };
    expect(__useProjectNavigationTest.entryChatMessages([reply])).toEqual([reply]);
  });

  it("entry：真实对话里夹着注入脚手架(开书开场白/idle招呼/系统提示) → 只留真实发言与 AI 回复", () => {
    const mixed: readonly ChapterMessage[] = [
      { id: "assistant-book-creation-1", role: "assistant", content: bookCreationPromptText() },
      { id: "user-1", role: "user", content: "主角叫林远" },
      { id: "assistant-workflow-idle-1", role: "assistant", content: "我已读取当前故事状态。" },
      { id: "assistant-agent-1", role: "assistant", content: "好，已把主角改名为林远。" },
      { id: "sys-recover-1", role: "system", content: "已将误入聊天区的正文移回左侧草稿区。" },
    ];
    const result = __useProjectNavigationTest.entryChatMessages(mixed);
    expect(result.map((m: ChapterMessage) => m.id)).toEqual(["user-1", "assistant-agent-1"]);
  });

  it("entry：带卡片的 AI 真实产物(整理资料卡等)不会被当脚手架误删", () => {
    const withCard = [
      {
        id: "assistant-agent-2",
        role: "assistant",
        content: "整理资料卡",
        agentCards: [{ id: "c1", kind: "foundation", agentName: "foundationAgent", status: "completed", title: "整理资料卡" }],
      },
    ] as unknown as readonly ChapterMessage[];
    expect(__useProjectNavigationTest.entryChatMessages(withCard)).toHaveLength(1);
  });

  // V4 真机根因（headless 复现实证）：新建空书的开书开场白会被 autosave 写进 chapter-workspace 缓存，
  // 但该快照对「草稿恢复」不算可恢复 → snapshotMessages 为空；同时建书种的 arc-goal + 占位草稿致 hasDraftFile
  // 让 isFreshBook(overview) 也误判 false。唯一可靠的 ground truth = 原始快照里持久化的那条开书开场白。
  it("persistedMessages 是开书开场白（缓存里捞回）→ 直接返回它，不落章节语气", () => {
    const persisted: readonly ChapterMessage[] = [
      { id: "assistant-book-creation-1781548839985", role: "assistant", content: bookCreationPromptText() },
    ];
    const messages = __useProjectNavigationTest.selectOpenProjectMessages({
      snapshotMessages: undefined, // 空书快照不可恢复
      persistedMessages: persisted,
      sessionMessages: [],
      workspaceMessages: cleanGreeting,
      overview: contentBookOverview, // 即便 overview 因 hasDraftFile/arc-goal 看起来「非空书」
    });
    expect(messages).toEqual(persisted);
    // 选择层仍命中 persisted（捞回了那条开书开场白），但进入展示层 entryChatMessages 因「无真实对话」清空它 → 空着进。
    const finalized = __useProjectNavigationTest.entryChatMessages(messages);
    expect(finalized).toEqual([]);
  });

  it("persistedMessages 是真实对话（不止开书开场白）→ 不误判，走正常分支", () => {
    const persisted: readonly ChapterMessage[] = [
      { id: "assistant-book-creation-1", role: "assistant", content: bookCreationPromptText() },
      { id: "user-1", role: "user", content: "主角叫林晚" },
    ];
    const messages = __useProjectNavigationTest.selectOpenProjectMessages({
      snapshotMessages: undefined,
      persistedMessages: persisted,
      sessionMessages: [],
      workspaceMessages: cleanGreeting,
      overview: contentBookOverview,
    });
    // 不是单条开书开场白 → persisted 分支不命中 → 落到 workspace greeting。
    expect(messages).toEqual(cleanGreeting);
  });

  it("有真实历史会话时优先于 persistedMessages（绝不覆盖用户对话）", () => {
    const realSession: readonly ChapterMessage[] = [
      { id: "user-1718000000", role: "user", content: "把主角名字改成林远" },
    ];
    const persisted: readonly ChapterMessage[] = [
      { id: "assistant-book-creation-1", role: "assistant", content: bookCreationPromptText() },
    ];
    const messages = __useProjectNavigationTest.selectOpenProjectMessages({
      snapshotMessages: undefined,
      persistedMessages: persisted,
      sessionMessages: realSession,
      workspaceMessages: cleanGreeting,
      overview: freshBookOverview,
    });
    expect(messages).toEqual(realSession);
  });

  // H4：foundation_write 的资料刷新（refreshScope:"foundation"）走本 hook 的
  // refreshWorkspaceFromOverview。历史上它铺开 workspaceFromStateOverview(overview)（含 overview 最新章的
  // currentChapter/chapters）却没保留用户当前停留章 → 在第2章顺手记资料会被顶部跳到最新章、草稿仍停第2章。
  // 抽出的 mergeFoundationRefreshWorkspace 必须保留 currentChapter/chapters/messages/draft/flowStatus，
  // 与 useFoundationGaps 版同款，资料刷新只动资料/侧栏派生字段。
  it("资料刷新合并：保留用户当前章/章节列表/对话/草稿/流程态，不被 overview 最新章覆盖（H4：记资料不跳章）", () => {
    const nextBase = {
      projectName: "记资料测试书",
      currentChapter: { chapterNumber: 5, title: "第五章", id: "ch-5", status: "current" },
      chapters: [{ id: "ch-5", chapterNumber: 5, title: "第五章", status: "current" }],
      messages: [{ id: "base-greeting", role: "assistant", content: "已进入工作区。" }],
      flowStatus: "committed",
      draft: { chapterNumber: 5, title: "第五章", status: "draft", content: "overview 占位草稿", savedContent: "overview 占位草稿" },
    } as unknown as ChapterWorkspaceData;
    const current = {
      projectName: "记资料测试书",
      currentChapter: { chapterNumber: 2, title: "第二章", id: "ch-2", status: "current" },
      chapters: [
        { id: "ch-1", chapterNumber: 1, title: "第一章", status: "committed" },
        { id: "ch-2", chapterNumber: 2, title: "第二章", status: "current" },
      ],
      messages: [
        { id: "user-real", role: "user", content: "把主角左手有疤记进角色卡" },
        { id: "assistant-real", role: "assistant", content: "已写入。" },
      ],
      flowStatus: "draft_ready",
      draft: { chapterNumber: 2, title: "第二章", status: "draft", content: "用户正在第2章写的草稿正文", savedContent: "用户正在第2章写的草稿正文" },
    } as unknown as ChapterWorkspaceData;

    const merged = __useProjectNavigationTest.mergeFoundationRefreshWorkspace(nextBase, current);

    // 用户停留章/章节列表/对话/草稿/流程态 全部保留 current（按引用相等），不被 overview 的第5章覆盖。
    expect(merged.currentChapter).toBe(current.currentChapter);
    expect(merged.chapters).toBe(current.chapters);
    expect(merged.messages).toBe(current.messages);
    expect(merged.draft).toBe(current.draft);
    expect(merged.flowStatus).toBe(current.flowStatus);
    // 其余资料/派生字段仍来自 overview base（如 projectName）。
    expect(merged.projectName).toBe("记资料测试书");
  });

  it("derives previous working draft context from the active chapter after restore", () => {
    const state = __useProjectNavigationTest.workingDraftChainState(
      Array.from({ length: 10 }, (_, index) => ({
        id: `ch-${index + 1}`,
        chapterNumber: index + 1,
        title: `第${index + 1}章`,
        status: "draft" as const,
        hasDraftFile: true,
        hasCommittedChapter: false,
      })),
      10,
    );

    expect(state).toMatchObject({
      hasUncommittedDrafts: true,
      workingDraftChain: true,
      previousUncommittedDraftContext: true,
      latestUncommittedDraftChapter: 10,
    });
  });
});
