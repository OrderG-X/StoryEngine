// @vitest-environment node
//
// read_timeline：按章/区间查询 timeline 事件，给 agent 精确查询早期内容的只读入口。
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ToolExecutionContext } from "@mastra/core/tools";

const { readStoryViews, readCharacterNameById } = vi.hoisted(() => ({
  readStoryViews: vi.fn(),
  // participants 解析用：老镜像里的参与者可能还是老格式人物编号（char-a→林明 / char-b→周冬，验「裸 char-id → 角色名」）。
  readCharacterNameById: vi.fn(async () => new Map([["char-a", "林明"], ["char-b", "周冬"]])),
}));
vi.mock("../../book/story-views.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readStoryViews,
}));
vi.mock("../../writing/presence/entity-labels.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readCharacterNameById,
}));

import { buildProjectRequestContext } from "../request-context.js";
import { readTimelineTool } from "./read-timeline.js";

const eventsView = (events: unknown) => ({ events });

const ctx = { requestContext: buildProjectRequestContext("/tmp/proj") } as unknown as ToolExecutionContext;
const ctxWithChapter = { requestContext: buildProjectRequestContext("/tmp/proj", 5) } as unknown as ToolExecutionContext;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (input: Record<string, unknown>, context: ToolExecutionContext) => (readTimelineTool as any).execute(input, context);

const mockEvents = [
  {
    id: "ch0001-001",
    chapter: 1,
    summary: "第1章事件摘要",
    participants: ["protagonist"],
    effects: {
      semanticSummary: {
        mainEvent: "第1章核心事件",
      },
    },
  },
  {
    id: "ch0002-001",
    chapter: 2,
    summary: "第2章事件摘要",
    participants: ["protagonist", "antagonist"],
    effects: {
      semanticSummary: {
        mainEvent: "第2章核心事件",
      },
    },
  },
  {
    id: "ch0005-001",
    chapter: 5,
    summary: "第5章事件摘要",
    participants: ["protagonist"],
    effects: {},
  },
];

describe("read_timeline 按章/区间查询 timeline 事件", () => {
  beforeEach(() => readStoryViews.mockReset());

  it("查单章 chapter=2 → 只返回第 2 章事件，ok=true", async () => {
    readStoryViews.mockResolvedValue(eventsView(mockEvents));
    const out = await run({ chapter: 2 }, ctx);
    expect(out.ok).toBe(true);
    expect(out.events).toHaveLength(1);
    expect(out.events[0].chapter).toBe(2);
    expect(out.events[0].id).toBe("ch0002-001");
    expect(out.events[0].summary).toBe("第2章事件摘要");
    expect(out.events[0].mainEvent).toBe("第2章核心事件");
    expect(out.events[0].participants).toEqual(["protagonist", "antagonist"]);
    expect(out.summary).toContain("第 2 章");
    expect(out.summary).toContain("共 1 件");
  });

  it("查区间 fromChapter=1 toChapter=2 → 返回第 1-2 章事件，ok=true", async () => {
    readStoryViews.mockResolvedValue(eventsView(mockEvents));
    const out = await run({ fromChapter: 1, toChapter: 2 }, ctx);
    expect(out.ok).toBe(true);
    expect(out.events).toHaveLength(2);
    expect(out.events.map((e: { chapter: number }) => e.chapter)).toEqual([1, 2]);
    expect(out.summary).toContain("第 1–2 章");
  });

  it("无参数（无 context chapter）→ 返回全部事件，ok=true", async () => {
    readStoryViews.mockResolvedValue(eventsView(mockEvents));
    const out = await run({}, ctx);
    expect(out.ok).toBe(true);
    expect(out.events).toHaveLength(3);
    expect(out.summary).toContain("全书");
  });

  it("context 里有 currentChapter=5，input 没给 chapter → 用 context 里的章（5）", async () => {
    readStoryViews.mockResolvedValue(eventsView(mockEvents));
    const out = await run({}, ctxWithChapter);
    expect(out.ok).toBe(true);
    expect(out.events).toHaveLength(1);
    expect(out.events[0].chapter).toBe(5);
  });

  it("查不存在的章 → ok=true, events 空, summary 说没有事件", async () => {
    readStoryViews.mockResolvedValue(eventsView(mockEvents));
    const out = await run({ chapter: 99 }, ctx);
    expect(out.ok).toBe(true);
    expect(out.events).toHaveLength(0);
    expect(out.summary).toContain("没有记下的事");
  });

  it("mainEvent 为空时 participants 仍把裸 char-id 解析成角色名（绝不泄露 char-xxx）", async () => {
    // 验证没有 semanticSummary.mainEvent 的事件也能正确返回；participants 裸 char-id → 角色名。
    readStoryViews.mockResolvedValue(eventsView([{
      id: "ch0003-001",
      chapter: 3,
      summary: "第3章事件无mainEvent",
      participants: ["char-a", "char-b", "char-deadbeef"],
      effects: {}, // 无 semanticSummary
    }] as never));
    const out = await run({ chapter: 3 }, ctx);
    expect(out.ok).toBe(true);
    expect(out.events).toHaveLength(1);
    expect(out.events[0].mainEvent).toBeUndefined();
    // char-a/char-b → 名字；未登记的 char-hash → 中性占位（不泄露裸 id）。
    expect(out.events[0].participants).toEqual(["林明", "周冬", "「未知角色」"]);
    expect(out.events[0].participants.join("")).not.toContain("char-");
  });

  it("账里的参与者就是名字：原样给，不当成编号去解析", async () => {
    readStoryViews.mockResolvedValue(eventsView([{
      id: "ch0004-001",
      chapter: 4,
      summary: "第4章",
      participants: ["沈青禾", "周守义"],
      effects: { semanticSummary: { mainEvent: "钥匙锁进铜盒", participants: ["沈青禾"] } },
    }] as never));
    const out = await run({ chapter: 4 }, ctx);
    expect(out.events[0].participants).toEqual(["沈青禾", "周守义"]);
    expect(out.events[0].semanticSummary.participants).toEqual(["沈青禾"]);
  });

  it("缺 projectDir → 抛错（绝不静默失败）", async () => {
    const emptyCtx = { requestContext: { get: () => undefined } } as unknown as ToolExecutionContext;
    await expect(run({}, emptyCtx)).rejects.toThrow(/缺少 projectDir/u);
  });

  it("题材中立：summary 不含任何题材词", async () => {
    readStoryViews.mockResolvedValue(eventsView([{
      id: "ch0001-001",
      chapter: 1,
      summary: "某章事件",
      participants: [],
      effects: {},
    }]));
    const out = await run({ chapter: 1 }, ctx);
    expect(out.summary).not.toMatch(/玄幻|修仙|武侠|霸总|穿越|科幻|言情/u);
  });

  it("[regression] context 有 currentChapter=50，但 caller 传 fromChapter=1/toChapter=10 → 应返回第1-10章而非只第50章", async () => {
    // 构造 currentChapter=50 的 context
    const ctxAt50 = { requestContext: buildProjectRequestContext("/tmp/proj", 50) } as unknown as ToolExecutionContext;

    // mock 数据：1-10章各一条 + 第50章一条
    const eventsWithEarly = [
      ...Array.from({ length: 10 }, (_, i) => ({
        id: `ch${String(i + 1).padStart(4, "0")}-001`,
        chapter: i + 1,
        summary: `第${i + 1}章事件`,
        participants: ["hero"],
        effects: {},
      })),
      {
        id: "ch0050-001",
        chapter: 50,
        summary: "第50章事件",
        participants: ["hero"],
        effects: {},
      },
    ];
    readStoryViews.mockResolvedValue(eventsView(eventsWithEarly));

    // 传 fromChapter=1, toChapter=10，不传 chapter
    const out = await run({ fromChapter: 1, toChapter: 10 }, ctxAt50);

    expect(out.ok).toBe(true);
    // 必须是区间查询结果（10条），而不是被 context 章号=50 覆盖成 1 条
    expect(out.events).toHaveLength(10);
    expect(out.events.map((e: { chapter: number }) => e.chapter)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // 不应包含第50章
    expect(out.events.some((e: { chapter: number }) => e.chapter === 50)).toBe(false);
    expect(out.summary).toContain("第 1–10 章");
  });
});
