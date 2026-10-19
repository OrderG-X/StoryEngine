// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

const resolveConfiguredChatModel = vi.fn();
const streamChatModelToText = vi.fn();
const resolveFallbackChatModel = vi.fn(async () => undefined as unknown);
vi.mock("./llm-client.js", () => ({ resolveConfiguredChatModel, resolveFallbackChatModel, streamChatModelToText }));

const { runModelCheckup } = await import("./model-checkup.js");

function configured(provider: string, model: string) {
  return { provider: { id: provider, label: provider.toUpperCase() }, profile: { model }, apiKey: "k", thinking: true, thinkingDialect: "none" };
}

describe("模型体检（P10）", () => {
  it("在用的模型去重、各发一句；关思考；不通的带原因；解析不出的功能单列", async () => {
    resolveConfiguredChatModel.mockImplementation(async (task: string) => {
      if (task === "qualityCheck") throw new Error("任务「qualityCheck」指定的模型档案不存在");
      return task === "draftReview" ? configured("b", "m2") : configured("a", "m1");
    });
    streamChatModelToText.mockImplementation(async ({ configured: c }: { configured: { profile: { model: string }; thinking: boolean } }) => {
      expect(c.thinking).toBe(false);
      if (c.profile.model === "m2") throw new Error("上游返回 401");
      return { content: "好", thinking: "" };
    });
    const result = await runModelCheckup();
    expect(streamChatModelToText).toHaveBeenCalledTimes(2);
    expect(result.models).toEqual([
      expect.objectContaining({ key: "a|m1", providerLabel: "A", model: "m1", tasks: ["triage", "fastDraft", "repair", "chapterSteering"], ok: true }),
      expect.objectContaining({ key: "b|m2", model: "m2", tasks: ["draftReview"], ok: false, error: "上游返回 401" }),
    ]);
    expect(result.unresolved).toEqual([{ task: "qualityCheck", error: "任务「qualityCheck」指定的模型档案不存在" }]);
  });

  it("连上了但什么也没回：算不通", async () => {
    resolveConfiguredChatModel.mockResolvedValue(configured("a", "m1"));
    streamChatModelToText.mockResolvedValue({ content: "", thinking: "" });
    const result = await runModelCheckup();
    expect(result.models[0]).toMatchObject({ ok: false, error: "连上了，但模型什么也没回。" });
  });

  it("备用模型也体检：和主模型同一个就并进去；体检不让备用顶上；备用解析不出单列", async () => {
    streamChatModelToText.mockReset();
    resolveConfiguredChatModel.mockResolvedValue({ ...configured("a", "m1"), fallback: configured("c", "m3") });
    resolveFallbackChatModel.mockResolvedValueOnce(configured("c", "m3"));
    streamChatModelToText.mockImplementation(async ({ configured: c }: { configured: { fallback?: unknown } }) => {
      expect(c.fallback).toBeUndefined();
      return { content: "好", thinking: "" };
    });
    let result = await runModelCheckup();
    expect(result.models.map((m) => [m.key, m.tasks])).toEqual([
      ["a|m1", ["triage", "fastDraft", "repair", "chapterSteering", "draftReview", "qualityCheck"]],
      ["c|m3", ["fallback"]],
    ]);

    resolveFallbackChatModel.mockRejectedValueOnce(new Error("备用模型的档案「x」不存在"));
    result = await runModelCheckup();
    expect(result.unresolved).toEqual([{ task: "fallback", error: "备用模型的档案「x」不存在" }]);
  });
});
