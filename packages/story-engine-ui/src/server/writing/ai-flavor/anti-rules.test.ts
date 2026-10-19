// @vitest-environment node
// 作者的反 AI 判据（重构 P9）：读设定卡写作规则的「一定不要写」「一定要做到」「别用的说法」。
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cardWrite, runCommand, type CardOp } from "@actalk/story-core";
import { createStoryProject } from "../../book/project-store.js";
import { ANTI_RULES_UNREADABLE, readAntiAiPatterns, readAntiRules, withAntiRulesNote } from "./anti-rules.js";

async function bookWithRules(ops: readonly CardOp[]): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "story-engine-anti-rules-"));
  const { projectDir } = await createStoryProject({ rootDir, title: "反味测试书", protagonistName: "顾言" });
  if (ops.length > 0) {
    const outcome = await runCommand(projectDir, cardWrite, { ops }, { caller: "author", idempotencyKey: `t-${randomUUID()}` });
    if (!outcome.ok) throw new Error(outcome.message);
  }
  return projectDir;
}

describe("readAntiRules / readAntiAiPatterns", () => {
  it("体检判据 = 一定不要写 + 一定要做到 + 别用的说法，去重；文风不算", async () => {
    const projectDir = await bookWithRules([
      { op: "rules.add", list: "bans", text: "不写血腥场面" },
      { op: "rules.add", list: "musts", text: "对话要带动作" },
      { op: "rules.add", list: "avoid", text: "嘴角勾起一抹弧度" },
      { op: "rules.add", list: "avoid", text: "不写血腥场面" },
      { op: "rules.add", list: "style", text: "克制" },
    ]);
    expect(await readAntiRules(projectDir)).toEqual({ items: ["不写血腥场面", "对话要带动作", "嘴角勾起一抹弧度"] });
  });

  it("出稿回检的字面词表只取「别用的说法」", async () => {
    const projectDir = await bookWithRules([
      { op: "rules.add", list: "bans", text: "不写血腥场面" },
      { op: "rules.add", list: "avoid", text: "嘴角勾起一抹弧度" },
      { op: "rules.add", list: "avoid", text: "眸光一闪" },
    ]);
    expect(await readAntiAiPatterns(projectDir)).toEqual(["嘴角勾起一抹弧度", "眸光一闪"]);
  });

  it("写作规则什么都没写 → 空数组", async () => {
    const projectDir = await bookWithRules([]);
    expect(await readAntiRules(projectDir)).toEqual({ items: [] });
    expect(await readAntiAiPatterns(projectDir)).toEqual([]);
  });

  it("设定卡读不出来 → 空判据不拦（只剩内置规则），但带上 failure 给作者看", async () => {
    const projectDir = await bookWithRules([{ op: "rules.add", list: "avoid", text: "眸光一闪" }]);
    await writeFile(join(projectDir, "ledger", "cards.json"), "{not-json", "utf-8");
    const read = await readAntiRules(projectDir);
    expect(read).toEqual({ items: [], failure: ANTI_RULES_UNREADABLE });
    expect(withAntiRulesNote("没发现明显的机器腔。", read.failure)).toBe(`没发现明显的机器腔。（${ANTI_RULES_UNREADABLE}。）`);
    expect(withAntiRulesNote("没发现明显的机器腔。", undefined)).toBe("没发现明显的机器腔。");
    expect(await readAntiAiPatterns(projectDir)).toEqual([]);
  });
});
