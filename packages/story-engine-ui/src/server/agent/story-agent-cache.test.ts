// @vitest-environment node
//
// M1：改模型设置后热生效。getStoryAgent 进程内缓存单例，invalidateStoryAgent 清缓存 → 下次重建、
// 重新 resolveGlmModel（读最新模型/key）。mock 掉真实模型解析，只验缓存/失效行为。
import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveGlmModel } = vi.hoisted(() => ({ resolveGlmModel: vi.fn() }));
vi.mock("./model.js", () => ({ resolveGlmModel }));

import { getStoryAgent, invalidateStoryAgent } from "./story-agent.js";

// Mastra Agent 构造期只存 model、不调用它，给一个最小 AI SDK 兼容假 model 即可。
function fakeModel() {
  return {
    model: {
      specificationVersion: "v2",
      provider: "fake",
      modelId: "fake-glm",
      doGenerate: async () => ({}),
      doStream: async () => ({}),
    },
    profile: { model: "fake-glm" },
    provider: { id: "fake" },
  };
}

describe("invalidateStoryAgent 模型设置热生效（M1）", () => {
  beforeEach(() => {
    resolveGlmModel.mockReset();
    resolveGlmModel.mockResolvedValue(fakeModel());
    invalidateStoryAgent(); // 清掉其它用例/此前可能建的缓存，保证从干净态开始
  });

  it("缓存命中：连续取到同一实例，resolveGlmModel 只调一次", async () => {
    const a1 = await getStoryAgent();
    const a2 = await getStoryAgent();
    expect(a1).toBe(a2);
    expect(resolveGlmModel).toHaveBeenCalledTimes(1);
  });

  it("invalidate 后重建：取到新实例，resolveGlmModel 重新调（读最新模型/key，不必重启）", async () => {
    const a1 = await getStoryAgent();
    invalidateStoryAgent();
    const a2 = await getStoryAgent();
    expect(a1).not.toBe(a2);
    expect(resolveGlmModel).toHaveBeenCalledTimes(2);
  });
});
