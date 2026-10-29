// @vitest-environment node
import { describe, expect, it } from "vitest";
import { operationConclusion } from "./view.js";

describe("结束了的那一句（对话收尾和卡上同一句）", () => {
  it("做成的就是结论本身，不再拿「做的什么」拼在前面", () => {
    expect(operationConclusion("succeeded", "核账·第 8 章", "核了第 8 章：确定对不上 1 处。", undefined)).toBe("核了第 8 章：确定对不上 1 处。");
    expect(operationConclusion("succeeded", "核账·第 8 章", "", undefined)).toBe("核账·第 8 章做完了。");
  });

  it("没成的带做的什么和原因；停掉的一句；没结束是空串", () => {
    expect(operationConclusion("failed", "想走法·第 9 章", "", "模型没回")).toBe("想走法·第 9 章没做成：模型没回");
    expect(operationConclusion("obsolete", "写稿·第 9 章", "", undefined)).toBe("写稿·第 9 章没做成：原因没记下来");
    expect(operationConclusion("cancelled", "核账·第 8 章", "这次停掉了。", undefined)).toBe("核账·第 8 章停掉了。");
    for (const state of ["queued", "running", "paused", "waiting_author"] as const) expect(operationConclusion(state, "核账·第 8 章", "", undefined)).toBe("");
  });
});
