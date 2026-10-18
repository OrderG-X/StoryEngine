import { describe, expect, it } from "vitest";
import type { ChapterMessage } from "../type-defs/workspace.js";
import { readMessageCards } from "../server/lib/message-cards-io.js";
import { directionGoal, latestDirections, pickedDirection, readBrainstormData } from "./brainstormCard.js";

const RAW = {
  ok: true,
  chapter: 12,
  idea: " 让老周开口 ",
  checked: true,
  options: [
    { title: "老周开口", steps: ["外乡人又来", " ", "老周说出钟停那天"], recommended: true, threads: [{ title: "老周回避", idle: 6, stale: true }, { idle: 2 }], problems: [] },
    { title: "夜里上楼", steps: ["钟楼有响动"], problems: [{ step: 1, earlierChapter: 10, earlierQuote: "钥匙在她包里", reason: "别人开不了钟箱" }, { step: 0, earlierChapter: 3, reason: "没指到哪一步" }] },
    { title: "", steps: ["没名字"] },
  ],
};

describe("头脑风暴卡数据（前端投影和存盘共用）", () => {
  it("防御解析：空步骤、没名字的走法、残缺的线索和问题丢掉；想法去空白", () => {
    const data = readBrainstormData(RAW)!;
    expect(data.idea).toBe("让老周开口");
    expect(data.options.map((option) => option.title)).toEqual(["老周开口", "夜里上楼"]);
    expect(data.options[0]).toMatchObject({ steps: ["外乡人又来", "老周说出钟停那天"], recommended: true, threads: [{ title: "老周回避", idle: 6, stale: true }] });
    expect(data.options[1]!.problems).toEqual([{ step: 1, earlierChapter: 10, earlierQuote: "钥匙在她包里", reason: "别人开不了钟箱" }]);
    expect(readBrainstormData({ chapter: 12, options: [] })).toBeUndefined();
    expect(readBrainstormData({ options: RAW.options })).toBeUndefined();
  });

  it("挑中的走法 → 写这一章的方向；找这一章最新的那张卡", () => {
    const data = readBrainstormData(RAW)!;
    expect(directionGoal(data.options[0]!)).toBe("老周开口：1. 外乡人又来 2. 老周说出钟停那天");
    const messages: ChapterMessage[] = [
      { id: "a", role: "assistant", content: "", cards: [{ type: "directions", brainstorm: data, picked: 1 }] },
      { id: "b", role: "assistant", content: "", cards: [{ type: "directions", brainstorm: { ...data, chapter: 13 } }] },
      { id: "c", role: "assistant", content: "", cards: [{ type: "directions", brainstorm: data, picked: 0 }] },
    ];
    expect(latestDirections(messages, 12)).toMatchObject({ messageId: "c", picked: 0 });
    expect(pickedDirection(messages, 12)?.title).toBe("老周开口");
    expect(pickedDirection(messages, 13)).toBeUndefined();
    expect(latestDirections(messages, 14)).toBeUndefined();
  });

  it("存盘白名单认走法卡；挑的序号越界就当没挑", () => {
    const data = readBrainstormData(RAW)!;
    expect(readMessageCards([{ type: "directions", brainstorm: data, picked: 1 }])).toEqual([{ type: "directions", brainstorm: data, picked: 1 }]);
    expect(readMessageCards([{ type: "directions", brainstorm: data, picked: 5 }])).toEqual([{ type: "directions", brainstorm: data }]);
    expect(readMessageCards([{ type: "directions", brainstorm: { chapter: 12, options: [] } }])).toEqual([]);
  });
});
