// @vitest-environment node
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeChapterPlan, readChapterPlan, writeChapterPlan } from "@actalk/story-engine";
import { describe, expect, it, vi } from "vitest";
import { checkAndRevisePlan } from "./plan-check.js";

// 2026-10-09 第十轮验收：46 处矛盾里 21 处出在章纲（同一人第 4 章说表一直收着、第 7 章说早丢了）。
async function makeBook(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "se-plan-check-"));
  await mkdir(join(dir, "story"), { recursive: true });
  await writeFile(join(dir, "story", "fact-ledger.json"), JSON.stringify({
    version: "v0",
    facts: [
      { id: "fact-4-0", chapter: 4, text: "林晓说那块怀表是她留下的，一直收在樟木箱里。", source: "auto" },
      ...Array.from({ length: 20 }, (_, i) => ({ id: `fact-5-${i}`, chapter: 5, text: `周婶第${i}回来串门说拆迁`, source: "auto" })),
    ],
  }), "utf-8");
  await writeChapterPlan(dir, normalizeChapterPlan({ summary: "林晓来铺子", beats: ["b"], storyDay: 6 }, { chapter: 6 })!);
  return dir;
}

const PLAN = normalizeChapterPlan({
  summary: "林晓上门，说怀表早就丢了",
  beats: ["林晓上门", "林晓说怀表早就丢了、从没在她手上", "林舟没接话"],
  storyDay: 7,
  characters: ["林晓", "林舟"],
  entities: ["怀表"],
  avoid: ["别再用这些说法：一屋子的钟在黑暗里响"],
}, { chapter: 7 })!;

describe("checkAndRevisePlan 章纲审校", () => {
  it("按章纲自己写的内容翻出相关旧事实、带上故事日历；对不上就用修正后的章纲（并保留确定性的避免项）", async () => {
    const dir = await makeBook();
    const callModel = vi.fn(async (_messages: readonly { readonly role: string; readonly content: string }[]) => JSON.stringify({
      issues: ["第 4 章林晓说表一直收在樟木箱里，这里让她说早就丢了"],
      plan: { ...PLAN, beats: ["林晓上门", "林晓承认表一直收着，但不肯说为什么送来修", "林舟没接话"], avoid: [] },
    }));
    const result = await checkAndRevisePlan({ projectDir: dir, plan: PLAN, callModel });
    const user = String(callModel.mock.calls[0][0][1].content);
    expect(user).toContain("林晓说那块怀表是她留下的");
    expect(user).toContain("第 6 章：故事第 6 天");
    expect(result.revised).toBe(true);
    expect(result.plan.beats[1]).toContain("表一直收着");
    expect(result.plan.avoid).toContain("别再用这些说法：一屋子的钟在黑暗里响");
    expect(result.plan.storyDay).toBe(7);
    expect((await readChapterPlan(dir, 7))?.beats[1]).toContain("表一直收着");
  });

  it("没问题 → 原章纲照用", async () => {
    const dir = await makeBook();
    const result = await checkAndRevisePlan({ projectDir: dir, plan: PLAN, callModel: vi.fn(async () => "{\"ok\":true}") });
    expect(result).toMatchObject({ revised: false, issues: [] });
    expect(result.plan).toBe(PLAN);
  });

  it("审校挂了 / 修正章纲不完整 → 沿用原章纲并如实记录", async () => {
    const dir = await makeBook();
    const failed = await checkAndRevisePlan({ projectDir: dir, plan: PLAN, callModel: vi.fn(async () => { throw new Error("idle timeout"); }) });
    expect(failed).toMatchObject({ revised: false, error: "idle timeout" });
    const broken = await checkAndRevisePlan({ projectDir: dir, plan: PLAN, callModel: vi.fn(async () => JSON.stringify({ issues: ["x"], plan: { characters: ["林晓"] } })) });
    expect(broken.revised).toBe(false);
    expect(broken.plan).toBe(PLAN);
    expect(broken.error).toContain("沿用原章纲");
  });
});
