import { describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { IncomingMessage } from "node:http";
import {
  chapterWorkspacePath,
  readUiChapterFileStates,
  defaultCommittedChapterPath,
  defaultDraftPath,
  isSafeProjectPath,
  readJsonBody,
  readWorkspaceMessages,
  writeFileAtomic,
} from "./project-io.js";
import { cardOf, hasCard } from "../../utils/messageCards.js";

const EXPECTED_MAX_JSON_BODY_BYTES = 32 * 1024 * 1024;

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

  // 重构 P5：章节状态只看工作稿 / 定稿文件。旧版写作台缓存（chapter-workspaces/*.json）不再更新，
  // 读它会在撤销后谎报「有工作稿」，所以不再参与；显示用空草稿占位符也不算真草稿。
  it("章节状态只看工作稿 / 定稿文件：旧版写作台缓存不算，占位符 .md 不算有草稿", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "story-engine-chapter-files-"));
    await mkdir(join(projectDir, "drafts", "fast"), { recursive: true });
    await mkdir(join(projectDir, ".story-engine-ui", "chapter-workspaces"), { recursive: true });
    await writeFile(defaultDraftPath(projectDir, 1), "还没有草稿正文。\n\n你可以在右侧章节对话里输入第 1 章方向，先整理本章方案，再生成草稿。\n", "utf-8");
    await writeFile(defaultDraftPath(projectDir, 3), "# 真章\n\n这是真的草稿正文。", "utf-8");
    await writeFile(chapterWorkspacePath(projectDir, 4), JSON.stringify({
      chapter: 4, flowStatus: "draft_ready", draftTitle: "旧缓存", draftContent: "# 旧缓存\n\n只在旧缓存里的正文。", messages: [], selectedAdviceCardKeys: [],
    }), "utf-8");

    const states = await readUiChapterFileStates(projectDir);

    expect(states.find((c) => c.chapter === 1)?.hasDraftFile, "占位符 .md 不算真草稿").toBe(false);
    expect(states.find((c) => c.chapter === 3)).toMatchObject({ hasDraftFile: true, hasCommittedChapter: false, draftTitle: "真章" });
    expect(states.some((c) => c.chapter === 4), "只在旧缓存里出现的章不算").toBe(false);
  });

  it("P11：定稿后工作稿又改过才标 editedSinceCommit；一样的不标", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "story-engine-chapter-edited-"));
    await mkdir(join(projectDir, "drafts", "fast"), { recursive: true });
    await mkdir(join(projectDir, "chapters"), { recursive: true });
    await writeFile(defaultCommittedChapterPath(projectDir, 1), "# 一\n\n定稿正文。", "utf-8");
    await writeFile(defaultDraftPath(projectDir, 1), "# 一\n\n定稿正文。", "utf-8");
    await writeFile(defaultCommittedChapterPath(projectDir, 2), "# 二\n\n定稿正文。", "utf-8");
    await writeFile(defaultDraftPath(projectDir, 2), "# 二\n\n定稿后又改了一句。", "utf-8");

    const states = await readUiChapterFileStates(projectDir);

    expect(states.find((c) => c.chapter === 1)?.editedSinceCommit).toBeUndefined();
    expect(states.find((c) => c.chapter === 2)).toMatchObject({ hasCommittedChapter: true, editedSinceCommit: true });
  });

});

describe("readWorkspaceMessages 存盘不丢卡（2026-10-10）", () => {
  it("核账卡、本轮用量、定稿预览的账本清单都随消息存下来", () => {
    const [message] = readWorkspaceMessages([{
      id: "assistant-1",
      role: "assistant",
      content: "核了第 8 章",
      continuityCheck: { chapter: 8, source: "draft", sure: [], maybe: [{ quote: "a", earlierQuote: "b", earlierChapter: 7, reason: "c" }] },
      tokenUsage: { input: 90000, cachedInput: 43000, output: 4000 },
      commitPreview: {
        chapter: 8,
        canCommit: true,
        ledgerChecklist: [{ id: "fact:0", kind: "fact", label: "记下：x", removable: true }, { id: "", label: "坏条目" }],
      },
    }]);
    expect(cardOf(message, "continuity")?.check).toMatchObject({ chapter: 8 });
    expect(message.tokenUsage).toEqual({ input: 90000, cachedInput: 43000, output: 4000 });
    expect(cardOf(message, "commit-preview")?.preview?.ledgerChecklist).toEqual([{ id: "fact:0", kind: "fact", label: "记下：x", removable: true }]);
  });
});

describe("readWorkspaceMessages 作者的话记着在看哪一章（重构 P6 第 6 步）", () => {
  it("正整数章号读回；坏值丢掉", () => {
    const [kept, zero, junk] = readWorkspaceMessages([
      { id: "u1", role: "user", content: "改一下", chapter: 12 },
      { id: "u2", role: "user", content: "改一下", chapter: 0 },
      { id: "u3", role: "user", content: "改一下", chapter: "12" },
    ]);
    expect(kept.chapter).toBe(12);
    expect(zero.chapter).toBeUndefined();
    expect(junk.chapter).toBeUndefined();
  });
});

describe("readWorkspaceMessages 卡按 type 校验（重构 P5）", () => {
  it("新格式的卡原样读回；认不出的 type、形状不对的卡丢掉；同一种只留最后一张", () => {
    const [message] = readWorkspaceMessages([{
      id: "assistant-cards",
      role: "assistant",
      content: "看卡",
      cards: [
        { type: "commit-preview", preview: { chapter: 3, canCommit: false, blockingReasons: ["缺稿"] } },
        { type: "continuity", check: { chapter: 3, sure: [{ quote: "a", earlierQuote: "b", earlierChapter: 1, reason: "c" }], maybe: [] } },
        { type: "error", detail: "boom" },
        { type: "status-notes", notes: ["历史窗口被裁剪", ""] },
        { type: "made-up", data: 1 },
        { type: "name-drift", warnings: [{ establishedName: "顾长风", driftedVariant: "顾长峰", message: "疑似写歪" }] },
        { type: "commit-preview", preview: { chapter: 3, canCommit: true } },
        "nope",
      ],
    }]);
    expect(message.cards).toEqual([
      { type: "continuity", check: { chapter: 3, sure: [{ quote: "a", earlierQuote: "b", earlierChapter: 1, reason: "c" }], maybe: [] } },
      { type: "error", detail: "boom" },
      { type: "status-notes", notes: ["历史窗口被裁剪"] },
      { type: "commit-preview", preview: { chapter: 3, canCommit: true } },
    ]);
  });

  it("核账卡带「不是问题」和核的稿纸版本（重构 P6）：读回；坏值丢掉", () => {
    const check = { chapter: 3, sure: [{ quote: "a", earlierQuote: "b", earlierChapter: 1, reason: "c" }], maybe: [] };
    const [kept, nulled, junk] = readWorkspaceMessages([
      { id: "c1", role: "assistant", content: "", cards: [{ type: "continuity", check, dismissed: ["a#b", "", 3], checkedVersion: "abc123" }] },
      { id: "c2", role: "assistant", content: "", cards: [{ type: "continuity", check, dismissed: [], checkedVersion: null }] },
      { id: "c3", role: "assistant", content: "", cards: [{ type: "continuity", check, dismissed: "a#b", checkedVersion: 7 }] },
    ]);
    expect(kept.cards).toEqual([{ type: "continuity", check, dismissed: ["a#b"], checkedVersion: "abc123" }]);
    expect(nulled.cards).toEqual([{ type: "continuity", check, checkedVersion: null }]);
    expect(junk.cards).toEqual([{ type: "continuity", check }]);
  });

  it("定稿预览卡带预览时的稿纸版本和记账员提醒（重构 P6）：读回；坏值丢掉", () => {
    const [kept, junk] = readWorkspaceMessages([
      { id: "p1", role: "assistant", content: "", cards: [{ type: "commit-preview", preview: { chapter: 3, canCommit: true, notes: ["还在读前文", "", 5] }, checkedVersion: "v9" }] },
      { id: "p2", role: "assistant", content: "", cards: [{ type: "commit-preview", preview: { chapter: 3, canCommit: true, notes: "还在读前文" }, checkedVersion: 9 }] },
    ]);
    expect(kept.cards).toEqual([{ type: "commit-preview", preview: { chapter: 3, canCommit: true, notes: ["还在读前文"] }, checkedVersion: "v9" }]);
    // 单个字符串照别的清单字段的读法收成一条；版本号不是字符串就丢。
    expect(junk.cards).toEqual([{ type: "commit-preview", preview: { chapter: 3, canCommit: true, notes: ["还在读前文"] } }]);
  });

  it("老会话的分散字段读成卡；adviceCards 认出来丢掉", () => {
    const [message] = readWorkspaceMessages([{
      id: "assistant-legacy-cards",
      role: "assistant",
      content: "老格式",
      isErrorNotice: true,
      errorDetail: "provider down",
      adviceCards: [{ id: "a1", type: "risk", title: "t", content: "c", defaultAction: "include" }],
      nextStepPrompt: { question: "下一步？", choices: [{ label: "写下一章", intent: "写下一章" }] },
    }]);
    expect(message.cards).toEqual([
      { type: "next-steps", prompt: { question: "下一步？", choices: [{ label: "写下一章", intent: "写下一章" }] } },
      { type: "error", detail: "provider down" },
    ]);
    expect(message).not.toHaveProperty("adviceCards");
    expect(message).not.toHaveProperty("isErrorNotice");
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
        // 早已不出的「名字写歪」「线索久未推进」两种老提醒卡（2026-10-22 删）：认出来丢掉。
        nameConsistencyWarnings: [{ establishedName: "顾长风", driftedVariant: "顾长峰", message: "疑似写歪" }],
        staleThreadWarnings: [{ kind: "foreshadowing", title: "码头暗号", lastTouchedChapter: 1, chaptersSinceTouched: 4, message: "超 3 章未触及" }],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      { id: "assistant-legacy", role: "assistant", content: "旧消息无报告字段" },
    ]);

    const msg = out[0];
    expect(msg.intentTitle).toBe("审稿并入库");
    expect(msg.affectedScopes).toEqual(["full", "foundation"]);
    expect(cardOf(msg, "ai-flavor")?.report).toEqual(aiFlavorReport);
    expect(cardOf(msg, "ai-flavor")?.fixedIds).toEqual(["v1", ...Array.from({ length: 49 }, (_, i) => `fix-${i}`)]);
    // 已没人写、也不再渲染的老字段：迁移时认出来丢掉。
    expect(msg).not.toHaveProperty("aiReviewReport");
    expect(msg.cards?.map((card) => card.type)).not.toContain("ai-review");
    expect(cardOf(msg, "draft-review")?.review).toEqual(draftReview);
    expect(cardOf(msg, "quality")?.report).toEqual(qualityReport);
    expect(cardOf(msg, "commit-report")?.report).toEqual(commitReport);
    expect(msg.cards?.map((card) => card.type)).not.toContain("name-drift");
    expect(msg.cards?.map((card) => card.type)).not.toContain("stale-threads");

    const legacy = out[1];
    expect(legacy).toEqual({ id: "assistant-legacy", role: "assistant", content: "旧消息无报告字段" });
    expect(legacy).not.toHaveProperty("turnSnapshots");
    expect(legacy).not.toHaveProperty("aiReviewReport");
    expect(legacy).not.toHaveProperty("commitReport");
    expect(legacy).not.toHaveProperty("intentTitle");
  });

  it("老会话的定稿预览 commitPreview 读成只看的清单卡；老「确认定稿」按钮不再摆（定稿清单上点）；坏卡不要", () => {
    const out = readWorkspaceMessages([
      {
        id: "assistant-preview",
        role: "assistant",
        content: "预览通过，点按钮定稿。",
        commitPreview: {
          chapter: 2,
          canCommit: true,
          blockingReasons: ["", "x"],
          summary: "可以定稿。",
          draftIssueCount: 0,
          semanticIssueCount: -1,
          previewToken: "tok-2",
        },
        suggestedActions: [
          {
            id: "commit-apply",
            label: "确认定稿",
            description: "写入定稿章节",
            permission: "formal_state_write",
            requiresConfirmation: false,
            commitTarget: { chapter: 2, previewToken: "tok-2", junk: 1 },
          },
          {
            id: "prune-confirm",
            label: "确认裁剪",
            description: "裁剪操作历史",
            permission: "formal_state_write",
            requiresConfirmation: false,
          },
        ],
      },
      { id: "assistant-bad-preview", role: "assistant", content: "坏卡", commitPreview: { chapter: 2 } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);

    expect(cardOf(out[0]!, "commit-preview")).toEqual({ type: "commit-preview", preview: { chapter: 2, canCommit: true, blockingReasons: ["x"], summary: "可以定稿。" } });
    expect(out[0]!.suggestedActions?.map((action) => action.id)).toEqual(["prune-confirm"]);
    expect(cardOf(out[1]!, "commit-preview")).toBeUndefined();
  });

  it("「确认裁剪」按钮的 pruneTarget 持久化（刷新后按钮仍按预览的保留条数裁）；坏 keep 丢掉但按钮还在", () => {
    const out = readWorkspaceMessages([
      {
        id: "assistant-prune",
        role: "assistant",
        content: "预览：将裁 12 条，点确认裁剪。",
        suggestedActions: [
          { id: "prune-confirm", label: "确认裁剪", description: "裁剪操作历史", permission: "destructive_write", requiresConfirmation: false, pruneTarget: { keep: 20, junk: 1 } },
          { id: "prune-confirm-bad", label: "确认裁剪", description: "裁剪操作历史", permission: "destructive_write", requiresConfirmation: false, pruneTarget: { keep: -3 } },
        ],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);
    expect(out[0]!.suggestedActions?.[0]?.pruneTarget).toEqual({ keep: 20 });
    expect(out[0]!.suggestedActions?.[1]?.pruneTarget).toEqual({});
  });

  it("建议动作的 disabledReason 持久化：重开书后「还不能点」的按钮仍是灰的", () => {
    const out = readWorkspaceMessages([
      {
        id: "assistant-quality",
        role: "assistant",
        content: "质检完成。",
        suggestedActions: [
          { id: "quality-check", label: "硬伤检查", description: "检查", permission: "safe_read", requiresConfirmation: false, disabledReason: "先写出这一章。" },
          { id: "ai-review", label: "内容审阅", description: "审阅", permission: "safe_read", requiresConfirmation: false, disabledReason: "" },
        ],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);
    expect(out[0]!.suggestedActions?.[0]?.disabledReason).toBe("先写出这一章。");
    expect(out[0]!.suggestedActions?.[1]).not.toHaveProperty("disabledReason");
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

    expect(cardOf(out[0], "next-steps")?.prompt).toEqual({
      question: "下一步想怎么走？",
      choices: [
        { label: "继续写第 3 章", intent: "写第 3 章草稿", recommended: true },
        { label: "先审稿", intent: "对第 2 章草稿做 AI 审稿" },
        ...Array.from({ length: 6 }, (_, i) => ({ label: `选项${i}`, intent: `意图${i}` })),
      ],
    });
    expect(cardOf(out[0], "next-steps")?.prompt?.choices).toHaveLength(8);
    expect(out[1]).not.toHaveProperty("nextStepPrompt");
    expect(out[2]).not.toHaveProperty("nextStepPrompt");
  });

  it("nextStepPrompt 的 choice.action（R4.7）：白名单内随存档 round-trip（刷新/重开后照旧直达），白名单外丢掉、选项保留", () => {
    const out = readWorkspaceMessages([
      {
        id: "assistant-next-step-action",
        role: "assistant",
        content: "核账做完了，接下来？",
        nextStepPrompt: {
          question: "核账做完了，接下来？",
          choices: [
            { label: "定稿", intent: "定稿第 5 章", recommended: true, action: { kind: "new", type: "commit.prepare", params: { chapter: 5 }, requestKey: "rk-0", issuedAt: "2026-10-29T00:00:00.000Z" } },
            { label: "再细核一遍", intent: "再细核一遍：这一章重新对一遍前文", action: { kind: "new", type: "inspect.run", mode: "continuity", params: { chapter: 5, fresh: true }, requestKey: "rk-1", issuedAt: "2026-10-29T00:00:00.000Z" } },
            { label: "缺请求号丢", intent: "c", action: { kind: "new", type: "inspect.run", mode: "quality", params: { chapter: 5 } } },
            { label: "我自己改", intent: "我自己改，先放着" },
            { label: "老动作丢", intent: "a", action: { toolName: "commit_preview", chapter: 5 } },
            { label: "残缺动作丢", intent: "b", action: { kind: "new", type: "commit.prepare", params: {}, requestKey: "rk-9", issuedAt: "2026-10-29T00:00:00.000Z" } },
          ],
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    ]);
    const choices = cardOf(out[0], "next-steps")!.prompt.choices;
    expect(choices[0]).toEqual({ label: "定稿", intent: "定稿第 5 章", recommended: true, action: { kind: "new", type: "commit.prepare", params: { chapter: 5 }, requestKey: "rk-0", issuedAt: "2026-10-29T00:00:00.000Z" } });
    expect(choices[1]).toEqual({
      label: "再细核一遍",
      intent: "再细核一遍：这一章重新对一遍前文",
      action: { kind: "new", type: "inspect.run", mode: "continuity", params: { chapter: 5, fresh: true }, requestKey: "rk-1", issuedAt: "2026-10-29T00:00:00.000Z" },
    });
    for (const index of [2, 3, 4, 5]) expect(choices[index]).not.toHaveProperty("action");
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
    expect(hasCard(out[0], "error")).toBe(true);
    expect(cardOf(out[0], "error")?.detail).toBe("Error from provider: boom");
    expect(hasCard(out[1], "error")).toBe(false);
    expect(cardOf(out[1], "error")?.detail).toBeUndefined();
    expect(hasCard(out[2], "error")).toBe(false);
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

describe("readWorkspaceMessages：操作历史里恢复记的那一行存盘不丢标记（2026-10-25）", () => {
  it("kind=restore 原样留着；认不出的 kind 丢掉", () => {
    const [note, other] = readWorkspaceMessages([
      { id: "system-restore-1", role: "system", kind: "restore", content: "已恢复到「定稿：第9章」之前。" },
      { id: "a1", role: "assistant", kind: "whatever", content: "好" },
    ]);
    expect(note).toMatchObject({ role: "system", kind: "restore" });
    expect(other).not.toHaveProperty("kind");
  });
});
