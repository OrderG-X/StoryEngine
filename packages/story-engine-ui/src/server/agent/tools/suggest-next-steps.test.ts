import { describe, expect, it } from "vitest";
import { normalizeChoices, suggestNextStepsTool } from "./suggest-next-steps.js";

describe("suggestNextStepsTool", () => {
  it("合法空对象退化输入应诚实返回 ok:false，而不是抛工具错误", async () => {
    const result = await suggestNextStepsTool.execute?.({} as never, {} as never);

    expect(result).toMatchObject({
      ok: false,
      summary: expect.stringContaining("下一步选项不完整"),
    });
  });

  it("正常输入原样回传给前端渲染下一步卡片", async () => {
    const result = await suggestNextStepsTool.execute?.(
      {
        question: "接下来？",
        choices: [
          {
            label: "写下一章",
            intent: "继续写下一章",
            recommended: true,
          },
        ],
      } as never,
      {} as never,
    );

    expect(result).toEqual({
      ok: true,
      question: "接下来？",
      choices: [
        {
          label: "写下一章",
          intent: "继续写下一章",
          recommended: true,
        },
      ],
    });
  });

  it("模型多给了选项、只给了字、少写 intent：归一后照样出卡，不整步拒掉", () => {
    expect(normalizeChoices(["预览定稿", { label: "再核一遍" }, { label: " ", intent: "x" }])).toEqual([
      { label: "预览定稿", intent: "预览定稿" },
      { label: "再核一遍", intent: "再核一遍" },
    ]);
    const five = ["一", "二", "三", "四", { label: "五", intent: "五", recommended: "true" as unknown as boolean }];
    expect(normalizeChoices(five).map((choice) => choice.label)).toEqual(["一", "二", "三", "五"]);
    expect(normalizeChoices(["一", "二", "三", "四", "五"]).map((choice) => choice.label)).toEqual(["一", "二", "三", "四"]);
  });
});
