// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

const resolveConfiguredChatModel = vi.fn();
const streamChatModelToText = vi.fn();
vi.mock("./llm-client.js", () => ({ resolveConfiguredChatModel, streamChatModelToText }));

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
});
