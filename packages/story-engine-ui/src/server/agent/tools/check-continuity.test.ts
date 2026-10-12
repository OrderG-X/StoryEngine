// @vitest-environment node
//
// 核账记忆（工具壳这一层）：同样的输入同样的输出；改掉一处只少那一处；「再细核一遍」重新核。
// R3 后核账只有核账员一路：假模型说核账员那套话术（写笔记 / 三遍核账 / 自复核），经 options.readerCallModel 注入。
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { BrainCallModel } from "../../brain/index.js";
import { makeHomeTempDir } from "../../lib/home-test-tmp.js";
import { runCheckContinuity } from "./check-continuity.js";

const CH1 = "林舟把怀表锁进了柜台下的抽屉。周婶说她明天一早来取伞。";
const DRAFT = "林舟一早开门。他从工作台上拿起那块怀表，表盖还开着。周婶说伞她昨天就拿走了。";

async function makeBook(): Promise<string> {
  const dir = await makeHomeTempDir("check-memory-");
  await mkdir(join(dir, "chapters"), { recursive: true });
  await mkdir(join(dir, "drafts", "fast"), { recursive: true });
  await writeFile(join(dir, "chapters", "0001.md"), `# 第1章\n\n${CH1}\n`, "utf-8");
  await writeFile(join(dir, "drafts", "fast", "chapter-0002.md"), `# 第2章\n\n${DRAFT}\n`, "utf-8");
  return dir;
}

/**
 * 假核账员：写笔记回一句；三遍里「盯东西」那遍报两处（怀表、伞）；有候选就发自复核，verdicts 里给判断。
 * carryOver 的问题（上次报过的）不靠模型这次报——自复核那轮会带着它们，判「不是」就删。
 */
function fakeModel(verdicts: Record<string, string>): BrainCallModel {
  return async (messages, options) => {
    if (!options.json) return "笔记";
    const last = messages.at(-1)!.content;
    if (last.includes("你刚才核完报了")) {
      const ids = [...last.matchAll(/【(K\d+)】/gu)].map((match) => match[1]);
      return JSON.stringify({ verdicts: ids.map((id) => ({ id, verdict: verdicts[id] ?? "maybe" })) });
    }
    if (last.includes("这一遍只盯东西")) {
      return JSON.stringify({
        checks: [],
        contradictions: [
          ...(last.includes("表盖还开着") ? [{ quote: "他从工作台上拿起那块怀表，表盖还开着。", earlierQuote: "林舟把怀表锁进了柜台下的抽屉。", earlierChapter: 1, reason: "怀表位置对不上", confidence: "sure" }] : []),
          ...(last.includes("伞她昨天就拿走了") ? [{ quote: "周婶说伞她昨天就拿走了。", earlierQuote: "周婶说她明天一早来取伞。", earlierChapter: 1, reason: "取伞的日子对不上", confidence: "maybe" }] : []),
        ],
      });
    }
    return JSON.stringify({ checks: [], contradictions: [] });
  };
}

describe("没核成的结构化回执（R4.1）+ 冷窗口回执（R4.4）", () => {
  it("还在读 → 冷窗口照核：ok:true + coverage 说清对照范围，不再是 pending「这次没核」", async () => {
    const dir = await makeHomeTempDir("check-pending-");
    await mkdir(join(dir, "chapters"), { recursive: true });
    await mkdir(join(dir, "drafts", "fast"), { recursive: true });
    // 12 章已定稿、第 13 章有工作稿：要补的笔记超过 10 章 → 冷窗口（已有笔记 0 章 + 第 5～12 章原文）。
    for (let chapter = 1; chapter <= 12; chapter += 1) {
      await writeFile(join(dir, "chapters", `${String(chapter).padStart(4, "0")}.md`), `# 第${chapter}章\n\n林舟照常开门。\n`, "utf-8");
    }
    await writeFile(join(dir, "drafts", "fast", "chapter-0013.md"), "# 第13章\n\n林舟把怀表拿出来。\n", "utf-8");
    const result = await runCheckContinuity(dir, 13, { readerCallModel: fakeModel({}) });
    expect(result.ok).toBe(true);
    expect(result.sure).toEqual([]);
    expect(result.maybe).toEqual([]);
    expect(result.pending).toBeUndefined();
    // 结构化的对照范围：消费方据此知道这次核的不是全书，别把范围说成全书。
    expect(result.coverage).toEqual({ mode: "cold", notedThrough: 0, rawFrom: 5, rawTo: 12 });
    expect(result.summary).toContain("核账员还没读完全书（第 0 / 12 章）");
    expect(result.summary).toContain("第 5～12 章原文 + 账本");
    expect(result.summary).toContain("更早的细节可能漏");
  });

  it("没正文 → ok:false 如实说，没有 pending（不是「还在读」）", async () => {
    const dir = await makeHomeTempDir("check-nodraft-");
    await mkdir(join(dir, "chapters"), { recursive: true });
    await writeFile(join(dir, "chapters", "0001.md"), `# 第1章\n\n${CH1}\n`, "utf-8");
    const result = await runCheckContinuity(dir, 2);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("还没有正文");
    expect(result.pending).toBeUndefined();
  });
});

describe("核账记忆", () => {
  it("正文和前文都没改 → 直接给上次结果、不调模型；「再细核一遍」才重新核", async () => {
    const dir = await makeBook();
    const first = vi.fn(fakeModel({ K1: "sure", K2: "maybe" }));
    const a = await runCheckContinuity(dir, 2, { readerCallModel: first });
    expect(a.reused).toBe(false);
    expect(a.source).toBe("draft");
    expect(a.sure.map((item) => item.reason)).toEqual(["怀表位置对不上"]);
    expect(a.maybe.map((item) => item.reason)).toEqual(["取伞的日子对不上"]);

    const second = vi.fn(fakeModel({}));
    const b = await runCheckContinuity(dir, 2, { readerCallModel: second });
    expect(second).not.toHaveBeenCalled();
    expect(b.reused).toBe(true);
    expect(b.sure).toEqual(a.sure);
    expect(b.maybe).toEqual(a.maybe);
    expect(b.summary).toContain("结果同上次");

    const third = vi.fn(fakeModel({}));
    const c = await runCheckContinuity(dir, 2, { fresh: true, readerCallModel: third });
    expect(third).toHaveBeenCalled();
    expect(c.reused).toBe(false);
  });

  it("改掉一处 → 只少那一处；没改掉的那处沿用上次的把握（不随复核的随机性跳）", async () => {
    const dir = await makeBook();
    await runCheckContinuity(dir, 2, { readerCallModel: fakeModel({ K1: "sure", K2: "sure" }) });
    await writeFile(join(dir, "drafts", "fast", "chapter-0002.md"), "# 第2章\n\n林舟一早开门。他从工作台上拿起那块怀表，表盖还开着。周婶说她晚点来取伞。\n", "utf-8");
    // 这次自复核把怀表那条判成 maybe：上次是 sure，沿用 sure。
    const after = await runCheckContinuity(dir, 2, { readerCallModel: fakeModel({ K1: "maybe" }) });
    expect(after.reused).toBe(false);
    expect(after.sure.map((item) => item.reason)).toEqual(["怀表位置对不上"]);
    expect(after.maybe).toEqual([]);
  });

  it("作者把上次那句改掉了 → 上次的问题不再带（原句没了就是真的改好了）", async () => {
    const dir = await makeBook();
    await runCheckContinuity(dir, 2, { readerCallModel: fakeModel({ K1: "sure", K2: "sure" }) });
    await writeFile(join(dir, "drafts", "fast", "chapter-0002.md"), "# 第2章\n\n林舟从抽屉里取出怀表擦了擦。周婶说伞她昨天就拿走了。\n", "utf-8");
    const after = await runCheckContinuity(dir, 2, { readerCallModel: fakeModel({}) });
    // 怀表那句没了 → 不再带；伞那句还在 → 照带，把握沿用上次（sure）。
    expect(after.sure.map((item) => item.reason)).toEqual(["取伞的日子对不上"]);
    expect(after.maybe).toEqual([]);
  });
});
