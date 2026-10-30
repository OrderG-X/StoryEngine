import { describe, expect, it } from "vitest";
import { buildInboxTodos } from "./inboxTodos.js";

const ch = (n: number, title: string, status: "committed" | "current" | "planned" = "committed") => ({ id: `c${n}`, chapterNumber: n, title, status });
const overview = (over: { cleanup?: number; arcs?: { id: string; title: string; lastTouchedChapter?: number }[]; timeChecks?: unknown[] } = {}) => ({
  ...(over.timeChecks ? { timeChecks: over.timeChecks } : {}),
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
      "36 条线索好几章没动",
      "主线目标 29 章没推进",
      "第 49 章还没起标题",
      "3 章用了同一个标题「看手」",
    ]);
    expect(todos[3]?.prefill).toContain("第 19、20、32 章");
  });

  it("正在写、还没定稿的章不提「还没起标题」（标题出稿或定稿时才起）", () => {
    const todos = buildInboxTodos({ chapters: [ch(8, "雾港"), ch(9, "第9章", "current")], overview: overview(), currentChapterNumber: 9 });
    expect(todos).toEqual([]);
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

  it("还没标主角：视角最多的人排第一条，点了直接改设定本（有卡就标主角，没卡就建一张）；通读没记完不提", () => {
    const suggest = (carded: boolean) => ({ ...(overview() as object), protagonistSuggestion: { name: "许微", viewpointChapters: 8, carded } }) as never;
    const carded = buildInboxTodos({ chapters: [ch(1, "死信")], overview: suggest(true), currentChapterNumber: 8 });
    expect(carded[0]).toMatchObject({ title: "还没标主角", sub: "8 章跟着许微的视角走", action: "设许微为主角" });
    expect(carded[0]?.ops).toEqual([{ op: "card.protagonist", card: "许微" }]);
    const uncarded = buildInboxTodos({ chapters: [ch(1, "死信")], overview: suggest(false), currentChapterNumber: 8 });
    expect(uncarded[0]?.ops).toEqual([{ op: "card.create", kind: "character", name: "许微", protagonist: true }]);
    expect(buildInboxTodos({ chapters: [ch(1, "死信")], overview: suggest(true), currentChapterNumber: 8, rereading: true })).toEqual([]);
  });

  it("别的待办不带 ops：照旧只把一句话放进输入框", () => {
    const todos = buildInboxTodos({ chapters: [ch(49, "待补")], overview: overview({ cleanup: 3 }), currentChapterNumber: 49 });
    expect(todos.every((todo) => todo.ops === undefined)).toBe(true);
  });

  it("天数要你看的：导入时记成你定的 →「对，是这天」直接改账；对不上 →「以我定的为准」；换天规矩改了 → 让 AI 对；多了只列前 3 处", () => {
    const checks = [
      { chapter: 3, kind: "unproven", day: 4, text: "导入时记成你定的第 4 天，证明不了是你定的，现在算不知道" },
      { chapter: 5, kind: "conflict", text: "你定的第 9 天，和按上一章、这章开头推出来的第 6 天对不上" },
      { chapter: 6, kind: "boundary", text: "天数是按天亮换日判的" },
      { chapter: 8, kind: "boundary", text: "天数是按天亮换日判的" },
    ];
    const todos = buildInboxTodos({ chapters: [ch(8, "雾港")], overview: overview({ timeChecks: checks }), currentChapterNumber: 8 });
    expect(todos.map((t) => [t.title, t.action])).toEqual([
      ["第 3 章是第 4 天吗", "对，是第 4 天"],
      ["第 5 章的天数对不上", "以我定的为准"],
      ["第 6 章是哪天不知道了", "让 AI 对一下"],
      ["还有 1 处天数要你看", "让 AI 列给我"],
    ]);
    expect(todos[0]?.userAction).toMatchObject({ kind: "new", type: "ledger.change", mode: "author", params: { changes: [{ op: "day", chapter: 3, day: 4 }] } });
    expect(todos[1]?.userAction).toMatchObject({ params: { changes: [{ op: "keepDay", chapter: 5 }] } });
    expect(todos[2]?.userAction).toBeUndefined();
    expect(todos[2]?.prefill).toContain("第 6 章");
  });
});
