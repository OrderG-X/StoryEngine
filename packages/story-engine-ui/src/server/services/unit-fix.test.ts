// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { fixByUnits } from "./unit-fix.js";

const goal = "和第 3 章「他那年二十九」对上";
const reply = (edits: readonly { id: number | string; for?: number; to: string }[]) => JSON.stringify({ edits });

describe("fixByUnits：按编号整句换（P12 编号句子）", () => {
  const draft = "# 第五章 雾\n\n“我出。”杜卫平说，“我爹的账上沾了那船的钱，他那本手账里一笔一笔都记着。这些年这钱在我手里压着，花在当年那条船的人身上，不亏心。”\n许微没接话。\n";

  it("核账抄的是半句：提示里点名那几句的编号，模型回整句、按编号换，不留两遍；收引号对齐原句", async () => {
    const callModel = vi.fn(async (prompt: string) => {
      expect(prompt).toContain("1. [2][3]：和第 3 章");
      expect(prompt).toContain("\n[4]许微没接话。");
      return reply([{ id: 3, to: "这些年这钱在我手里压着，花在当年那条船的人身上，我心里不亏。" }]);
    });
    const out = await fixByUnits({ chapter: 5, text: draft, fixes: [{ quote: "他那本手账里一笔一笔都记着。这些年这钱在我手里压着", goal }], callModel });
    expect(out.applied).toEqual([0]);
    expect(out.failed).toEqual([]);
    expect(out.text).toBe(draft.replace("不亏心。”", "我心里不亏。”"));
  });

  it("新句抄进了前一句：去掉抄的那截；编号写成「[2]」也认", async () => {
    const text = "他走了。\n许微没接话。\n";
    const out = await fixByUnits({ chapter: 5, text, fixes: [{ quote: "许微没接话", goal }], callModel: async () => reply([{ id: "[2]", to: "他走了。许微点了点头。" }]) });
    expect(out).toMatchObject({ text: "他走了。\n许微点了点头。\n", applied: [0] });
  });

  // 换题材长篇实跑 2026-10-28：改法照编号正文整段抄回（「上一句[2]这一句」），整条被当成一句改成了几句丢掉。
  it("新写法带着别的编号（整段抄回来）：按编号拆开，点名那句照换", async () => {
    const text = "他走了。\n许微没接话。\n";
    const out = await fixByUnits({ chapter: 5, text, fixes: [{ quote: "许微没接话", goal }], callModel: async () => reply([{ id: 1, to: "他走了。[2]许微点了点头。" }]) });
    expect(out).toMatchObject({ text: "他走了。\n许微点了点头。\n", applied: [0] });
  });

  it("两处报的是同一句：合成一条交给模型，只问一次，两处都算改了", async () => {
    const callModel = vi.fn(async (_prompt: string) => reply([{ id: 1, to: "甲乙丁。" }]));
    const out = await fixByUnits({ chapter: 5, text: "甲乙丙。戊己。\n", fixes: [{ quote: "甲乙", goal: "一" }, { quote: "乙丙", goal: "二" }], callModel });
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(callModel.mock.calls[0]![0]).toContain("1. [1]：一；二");
    expect(out).toMatchObject({ text: "甲乙丁。戊己。\n", applied: [0, 1], failed: [] });
  });

  it("原句找不到 / 出现四次以上 / 太长：不问模型，照实说为什么", async () => {
    const callModel = vi.fn(async () => reply([]));
    const out = await fixByUnits({
      chapter: 5,
      text: "他走了。他走了。他走了。他走了。一。二。三。四。五。\n",
      fixes: [{ quote: "不在稿里", goal }, { quote: "他走了", goal }, { quote: "一。二。三。四。五", goal }],
      callModel,
    });
    expect(callModel).not.toHaveBeenCalled();
    expect(out.text).toBe("他走了。他走了。他走了。他走了。一。二。三。四。五。\n");
    expect(out.failed.map((item) => item.why)).toEqual([
      "原句在稿里找不到了（可能已经改过）",
      "原句在稿里不止一处，不知道改哪一处",
      "核账引的原句太长，没法只改那几句",
    ]);
  });

  it("同一句在稿里出现两次（作者稿整段重复，考台 2026-11-04）：两次都编号交模型、说清出现了几次；只改了一次也算改了，原句还在交复核", async () => {
    let prompt = "";
    const out = await fixByUnits({
      chapter: 5,
      text: "钟停在三点。他走了。钟停在三点。\n",
      fixes: [{ quote: "钟停在三点", goal }],
      callModel: async (sent) => {
        prompt = sent;
        return reply([{ id: 3, to: "钟停在四点。" }]);
      },
    });
    expect(prompt).toContain("1. [1][3]：");
    expect(prompt).toContain("这句在稿里出现了 2 次：[1]、[3]，只改真和前文对不上的那一次；几次都对不上就都改");
    expect(out).toMatchObject({ text: "钟停在三点。他走了。钟停在四点。\n", applied: [0], failed: [], revisit: [0] });

    const both = await fixByUnits({ chapter: 5, text: "钟停在三点。他走了。钟停在三点。\n", fixes: [{ quote: "钟停在三点", goal }], callModel: async () => reply([{ id: 1, to: "钟停在四点。" }, { id: 3, to: "钟停在四点。" }]) });
    expect(both).toMatchObject({ text: "钟停在四点。他走了。钟停在四点。\n", applied: [0], revisit: [] });
  });

  it("回的不是 JSON：同一份提示再要一次；还不行就照实说格式不对，正文不动", async () => {
    const callModel = vi.fn(async () => "好的，我改成了……");
    const out = await fixByUnits({ chapter: 5, text: "他走了。\n", fixes: [{ quote: "他走了", goal }], callModel });
    expect(callModel).toHaveBeenCalledTimes(2);
    expect(out).toMatchObject({ text: "他走了。\n", applied: [], failed: [{ fix: 0, why: "AI 回的格式不对，没写改后的句子" }] });
  });

  it("点名那句没动、改的是本章别的句子（核账引的是错处旁边那句，真机 2026-11-04）：照换，记成改在别处，交改完再核复核", async () => {
    const out = await fixByUnits({ chapter: 5, text: "甲。乙。\n", fixes: [{ quote: "乙", goal }], callModel: async () => reply([{ id: 1, to: "改了甲。" }]) });
    expect(out).toMatchObject({ text: "改了甲。乙。\n", applied: [0], failed: [], revisit: [0], alsoChanged: 0 });
  });

  it("几处一起改：改别处的句子按模型标的 for 算给那一处；没标、标错的只算连带改，那一处照实说没改成", async () => {
    const text = "甲。乙。丙。丁。\n";
    const fixes = [{ quote: "甲", goal }, { quote: "丙", goal }];
    const tagged = await fixByUnits({ chapter: 5, text, fixes, callModel: async () => reply([{ id: 1, to: "改好的。" }, { id: 4, for: 2, to: "改了丁。" }]) });
    expect(tagged).toMatchObject({ text: "改好的。乙。丙。改了丁。\n", applied: [0, 1], failed: [], revisit: [1] });

    const untagged = await fixByUnits({ chapter: 5, text, fixes, callModel: async () => reply([{ id: 1, to: "改好的。" }, { id: 4, for: 9, to: "改了丁。" }]) });
    expect(untagged).toMatchObject({ text: "改好的。乙。丙。改了丁。\n", applied: [0], failed: [{ fix: 1, why: "AI 没给出这句的改法" }], revisit: [], alsoChanged: 1 });
  });

  it("一句都没给：照实说没给出改法", async () => {
    const out = await fixByUnits({ chapter: 5, text: "甲。乙。\n", fixes: [{ quote: "乙", goal }], callModel: async () => reply([]) });
    expect(out).toMatchObject({ text: "甲。乙。\n", applied: [], failed: [{ fix: 0, why: "AI 没给出这句的改法" }], revisit: [] });
  });

  it("本章别处说同一件事的句子跟着改（P13 真机：「四个字」只改了点名那句）；锁住的、超出每处四句的、要删句的不收", async () => {
    const text = "他说了四个字。不到时候。她问哪四个字。他说就这四个字。前面也说四个字。\n";
    const out = await fixByUnits({
      chapter: 9, text, fixes: [{ quote: "他说了四个字", goal }],
      callModel: async () => reply([{ id: 1, to: "他说了三个字。" }, { id: 3, to: "她问哪三个字。" }, { id: 4, to: "他说就这三个字。" }]),
    });
    expect(out.text).toBe("他说了三个字。不到时候。她问哪三个字。他说就这三个字。前面也说四个字。\n");
    expect(out).toMatchObject({ applied: [0], alsoChanged: 2 });

    const locked = await fixByUnits({
      chapter: 9, text, fixes: [{ quote: "她问哪四个字", goal }], lockedBefore: text.indexOf("不到时候"),
      callModel: async () => reply([{ id: 3, to: "她问哪三个字。" }, { id: 1, to: "他说了三个字。" }, { id: 4, to: "" }]),
    });
    // 第 1 句在作者写的那段里，不连带改；连带的不许删句。
    expect(locked.text).toBe("他说了四个字。不到时候。她问哪三个字。他说就这四个字。前面也说四个字。\n");
    expect(locked.alsoChanged).toBe(0);

    const capped = await fixByUnits({
      chapter: 9, text: "甲。乙。丙。丁。戊。己。\n", fixes: [{ quote: "甲", goal }],
      callModel: async () => reply([{ id: 1, to: "甲甲。" }, { id: 2, to: "乙乙。" }, { id: 3, to: "丙丙。" }, { id: 4, to: "丁丁。" }, { id: 5, to: "戊戊。" }, { id: 6, to: "己己。" }]),
    });
    expect(capped.text).toBe("甲甲。乙乙。丙丙。丁丁。戊戊。己。\n");
  });

  it("连带改的句数按处数算：一次改两处，合起来能连带八句（考台 2026-11-03：一批只许 3 句，剩下的全是「本章别处还照改前说」）", async () => {
    const text = `${[..."子丑寅卯辰巳午未申酉戌亥"].map((name) => `${name}时。`).join("")}\n`;
    let prompt = "";
    const out = await fixByUnits({
      chapter: 9, text, fixes: [{ quote: "子时", goal }, { quote: "丑时", goal }],
      callModel: async (sent) => {
        prompt = sent;
        return reply(Array.from({ length: 11 }, (_, index) => ({ id: index + 1, to: `改${index + 1}。` })));
      },
    });
    expect(prompt).toContain("合起来最多 8 句");
    expect(out).toMatchObject({ applied: [0, 1], alsoChanged: 8 });
    expect(out.text).toContain("改10。戌时。");
  });

  it("几处里一处换上了、一处没给：改了的照换，没给的照实说", async () => {
    const out = await fixByUnits({
      chapter: 5,
      text: "甲。乙。丙。\n",
      fixes: [{ quote: "甲", goal }, { quote: "丙", goal }],
      callModel: async () => reply([{ id: 1, to: "改了甲。" }]),
    });
    expect(out).toMatchObject({ text: "改了甲。乙。丙。\n", applied: [0], failed: [{ fix: 1, why: "AI 没给出这句的改法" }] });
    expect(out.changes).toEqual([{ from: "甲。", to: "改了甲。" }]);
  });

  it("to 给空串 = 删掉这句", async () => {
    const out = await fixByUnits({ chapter: 5, text: "甲。乙。丙。\n", fixes: [{ quote: "乙", goal }], callModel: async () => reply([{ id: 2, to: "" }]) });
    expect(out).toMatchObject({ text: "甲。丙。\n", applied: [0] });
  });

  it("模型调用报错：不重试，照实说，正文不动", async () => {
    const callModel = vi.fn(async () => { throw new Error("服务商超时"); });
    const out = await fixByUnits({ chapter: 5, text: "他走了。\n", fixes: [{ quote: "他走了", goal }], callModel });
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ text: "他走了。\n", applied: [], failed: [{ fix: 0, why: "AI 没改成（服务商超时）" }] });
  });
});
