import { describe, expect, it } from "vitest";
import { humanizeDeltaRejection } from "./commit-preview.js";

describe("humanizeDeltaRejection 标注核对提醒说人话", () => {
  it("字段路径和原因代码不给作者看，只说哪类标注 + 引用的原句", () => {
    const text = humanizeDeltaRejection("章节语义声明被拒（charactersPresent[3]·name_not_in_evidence）：“溪溪啊。”周婶叹了口气，“她也是为你好。上海那边，机会多。”");
    expect(text).toMatch(/^出场人物里的「/u);
    expect(text).not.toMatch(/charactersPresent|name_not_in_evidence|·/u);
    expect(text.length).toBeLessThan(45);
  });
  it("认不出格式就只留原句", () => {
    expect(humanizeDeltaRejection("别的什么格式")).toBe("「别的什么格式」");
  });
});
