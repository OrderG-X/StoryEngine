// @vitest-environment node
import { describe, expect, it } from "vitest";
import { slimToolOutputForModel, withSlimModelOutput } from "./tool-model-output.js";

// 2026-10-10 自审：一章约 20 万输入 token，八成是对话 AI 反复重发工具结果里的状态总览与整章正文。
describe("工具结果给模型的精简版", () => {
  const draftOutput = {
    ok: true,
    chapter: 7,
    summary: "第 7 章已生成正文并写入工作稿。",
    draftBody: "许微推开港务局的门。".repeat(300),
    overview: { project: { title: "雾港来信" }, characters: new Array(50).fill({ name: "x" }) },
    refreshScope: "full",
    qualityPipeline: { continuity: { found: 1 } },
  };

  it("去掉状态总览与整章正文，只留字数和看原文的办法；其余字段原样", () => {
    const slim = slimToolOutputForModel("generate_draft", draftOutput) as Record<string, unknown>;
    expect(slim.overview).toBeUndefined();
    expect(slim.refreshScope).toBeUndefined();
    expect(slim.draftBody).toBeUndefined();
    expect(slim.draftChars).toBe(2700);
    expect(String(slim.draftBodyNote)).toContain("read_draft");
    expect(slim.summary).toBe(draftOutput.summary);
    expect(slim.qualityPipeline).toEqual(draftOutput.qualityPipeline);
    expect(JSON.stringify(slim).length).toBeLessThan(JSON.stringify(draftOutput).length / 5);
  });

  it("读类工具原样给模型（本职就是给模型读资料）；非对象原样", () => {
    expect(slimToolOutputForModel("read_state_overview", draftOutput)).toBe(draftOutput);
    expect(slimToolOutputForModel("read_draft", draftOutput)).toBe(draftOutput);
    expect(slimToolOutputForModel("generate_draft", "text")).toBe("text");
  });

  it("挂到工具表上：写类工具得到 toModelOutput，读类工具不挂", () => {
    const tools = withSlimModelOutput({ generate_draft: {}, read_draft: {} } as Record<string, object>);
    const toModelOutput = (tools.generate_draft as { toModelOutput?: (output: unknown) => unknown }).toModelOutput;
    expect(toModelOutput?.(draftOutput)).toMatchObject({ type: "json", value: { draftChars: 2700 } });
    expect((tools.read_draft as { toModelOutput?: unknown }).toModelOutput).toBeUndefined();
  });
});
