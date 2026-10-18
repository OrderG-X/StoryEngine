import { describe, expect, it } from "vitest";
import type { ChapterMessage } from "../../../types.js";
import { chapterTurns } from "./chapterTurns.js";

const user = (id: string, chapter?: number): ChapterMessage => ({ id, role: "user", content: id, ...(chapter ? { chapter } : {}) });
const reply = (id: string): ChapterMessage => ({ id, role: "assistant", content: id });

describe("这一章的对话（重构 P6 第 6 步）", () => {
  it("只露当前章的轮；别的章的整轮收起；没记章号的旧对话照露；最后一轮总露", () => {
    const messages = [
      reply("hello"),
      user("u1", 3), reply("a1"),
      user("u2", 4), reply("a2"), reply("a2b"),
      user("u3"), reply("a3"),
      user("u4", 3), reply("a4"),
      user("u5", 5), reply("a5"),
    ];
    const { hidden, hiddenTurns } = chapterTurns(messages, 3);
    expect(hiddenTurns).toBe(1);
    expect([...hidden]).toEqual(["u2", "a2", "a2b"]);
  });

  it("不知道当前章就全露", () => {
    expect(chapterTurns([user("u1", 3), reply("a1"), user("u2", 4)], undefined).hiddenTurns).toBe(0);
  });
});
