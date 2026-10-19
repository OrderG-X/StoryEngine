import { describe, expect, it } from "vitest";
import { buildInboxTodos } from "./inboxTodos.js";

const ch = (n: number, title: string, status: "committed" | "planned" = "committed") => ({ id: `c${n}`, chapterNumber: n, title, status });
const overview = (over: { cleanup?: number; arcs?: { id: string; title: string; lastTouchedChapter?: number }[] } = {}) => ({
  threads: { total: 0, open: 0, touched: 0, done: 0, openIntents: 0, cleanupVisibleCount: over.cleanup ?? 0, keyOpenItems: [] },
  arcGoals: { activeCount: 0, touchedCount: 0, completedCount: 0, activeItems: (over.arcs ?? []).map((a) => ({ ...a, status: "active" })) },
}) as never;

describe("改版 buildInboxTodos：AI 栏「待处理」", () => {
  it("可清理线索、久未推进的主线、占位章名、重名章节各出一条", () => {
    const todos = buildInboxTodos({
      chapters: [ch(19, "看手"), ch(20, "看手"), ch(32, "看手"), ch(49, "待补"), ch(58, "第58章 · 西侧二层"), ch(59, "下一章", "planned")],
      overview: overview({ cleanup: 36, arcs: [{ id: "g1", title: "沈栀调查这栋民国老宅", lastTouchedChapter: 29 }, { id: "g2", title: "近期目标", lastTouchedChapter: 57 }] }),
      currentChapterNumber: 58,
    });
    expect(todos.map((t) => t.title)).toEqual([
      "36 条线索可以清理",
      "主线目标 29 章没推进",
      "第 49 章还没起标题",
      "3 章用了同一个标题「看手」",
    ]);
    expect(todos[3]?.prefill).toContain("第 19、20、32 章");
  });

  it("什么都不缺 → 空列表；重名只有两章不算", () => {
    expect(buildInboxTodos({ chapters: [ch(1, "开端"), ch(2, "开端")], overview: overview(), currentChapterNumber: 2 })).toEqual([]);
    expect(buildInboxTodos({ chapters: [], overview: null, currentChapterNumber: 1 })).toEqual([]);
  });

  it("导入的书还在通读记账：线索清理、主线没推进先不提（后面的章还没记账，看着没推进是假的）", () => {
    const todos = buildInboxTodos({
      chapters: [ch(1, "死信"), ch(8, "待补")],
      overview: overview({ cleanup: 7, arcs: [{ id: "g1", title: "找父亲", lastTouchedChapter: 0 }] }),
      currentChapterNumber: 8,
      rereading: true,
    });
    expect(todos.map((t) => t.title)).toEqual(["第 8 章还没起标题"]);
  });

  it("主角卡还是开书占位：给视角最多的人当候选，排第一条；通读没记完不提", () => {
    const withProtagonist = { ...(overview() as object), placeholderProtagonist: { placeholderName: "主角", suggestedName: "许微", viewpointChapters: 8 } } as never;
    const todos = buildInboxTodos({ chapters: [ch(1, "死信")], overview: withProtagonist, currentChapterNumber: 8 });
    expect(todos[0]).toMatchObject({ title: "主角卡还叫「主角」", sub: "8 章跟着许微的视角走", prefill: "把主角卡改成「许微」，只改名字，别的不动" });
    expect(buildInboxTodos({ chapters: [ch(1, "死信")], overview: withProtagonist, currentChapterNumber: 8, rereading: true })).toEqual([]);
  });
});

