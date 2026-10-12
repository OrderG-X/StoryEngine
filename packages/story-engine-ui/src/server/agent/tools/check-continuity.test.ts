// @vitest-environment node
//
// 核账记忆：同样的输入同样的输出；改掉一处只少那一处；「再细核一遍」重新核。
// 这里的假模型说的是旧核账（combo）那套话术——R1 起核账员是默认，旧路显式设 legacy 再测（回退排查用，R3 删）。
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

/** 假模型：通读报两处（怀表、伞），复核按 verdicts 给判断。 */
function fakeModel(verdicts: Record<string, string>) {
  return vi.fn(async (messages: readonly { readonly role: string; readonly content: string }[]) => {
    const system = messages[0].content;
    if (system.includes("复核编辑")) {
      const ids = [...messages[1].content.matchAll(/【(K\d+)】/gu)].map((match) => match[1]);
      return JSON.stringify({ verdicts: ids.map((id) => ({ id, verdict: verdicts[id] ?? "maybe" })) });
    }
    if (system.includes("连续性审读员") && messages[1].content.includes("只盯东西")) {
      const body = messages[1].content;
      return JSON.stringify({
        contradictions: [
          ...(body.includes("表盖还开着") ? [{ quote: "他从工作台上拿起那块怀表，表盖还开着。", earlierQuote: "林舟把怀表锁进了柜台下的抽屉。", earlierChapter: 1, reason: "怀表位置对不上" }] : []),
          ...(body.includes("伞她昨天就拿走了") ? [{ quote: "周婶说伞她昨天就拿走了。", earlierQuote: "周婶说她明天一早来取伞。", earlierChapter: 1, reason: "取伞的日子对不上" }] : []),
        ],
      });
    }
    return JSON.stringify({ contradictions: [], claims: [] });
  });
}

describe("核账记忆", () => {
  beforeEach(() => {
    vi.stubEnv("STORY_CHECKER", "legacy"); // 假模型说的是旧核账的话术：显式走旧路测（核账员路的记忆见 check-service.test.ts）
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("正文和前文都没改 → 直接给上次结果、不调模型；「再细核一遍」才重新核", async () => {
    const dir = await makeBook();
    const first = fakeModel({ K1: "sure", K2: "maybe" });
    const a = await runCheckContinuity(dir, 2, first);
    expect(a.reused).toBe(false);
    expect(a.sure.map((item) => item.reason)).toEqual(["怀表位置对不上"]);
    expect(a.maybe.map((item) => item.reason)).toEqual(["取伞的日子对不上"]);

    const second = fakeModel({});
    const b = await runCheckContinuity(dir, 2, second);
    expect(second).not.toHaveBeenCalled();
    expect(b.reused).toBe(true);
    expect(b.sure).toEqual(a.sure);
    expect(b.maybe).toEqual(a.maybe);
    expect(b.summary).toContain("结果同上次");

    const third = fakeModel({});
    const c = await runCheckContinuity(dir, 2, third, { fresh: true });
    expect(third).toHaveBeenCalled();
    expect(c.reused).toBe(false);
  });

  it("改掉一处 → 只少那一处；没改掉的那处沿用上次的把握（不随复核的随机性跳）", async () => {
    const dir = await makeBook();
    await runCheckContinuity(dir, 2, fakeModel({ K1: "sure", K2: "sure" }));
    await writeFile(join(dir, "drafts", "fast", "chapter-0002.md"), "# 第2章\n\n林舟一早开门。他从工作台上拿起那块怀表，表盖还开着。周婶说她晚点来取伞。\n", "utf-8");
    // 这次复核把怀表那条判成 maybe：上次是 sure，沿用 sure。
    const after = await runCheckContinuity(dir, 2, fakeModel({ K1: "maybe" }));
    expect(after.reused).toBe(false);
    expect(after.sure.map((item) => item.reason)).toEqual(["怀表位置对不上"]);
    expect(after.maybe).toEqual([]);
  });

  it("上次报过的这次复核判「不是」→ 删掉（比如作者在中间补了一句交代）", async () => {
    const dir = await makeBook();
    await runCheckContinuity(dir, 2, fakeModel({ K1: "sure", K2: "sure" }));
    await writeFile(join(dir, "drafts", "fast", "chapter-0002.md"), `# 第2章\n\n林舟先把抽屉里的怀表取了出来。${DRAFT}\n`, "utf-8");
    const after = await runCheckContinuity(dir, 2, fakeModel({ K1: "no", K2: "sure" }));
    expect(after.sure.map((item) => item.reason)).toEqual(["取伞的日子对不上"]);
  });
});
