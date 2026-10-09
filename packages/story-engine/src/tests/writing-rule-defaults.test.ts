import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyFoundationWriteSuggestion } from "../foundation-write-gateway.js";
import { createStoryProject } from "../project-store.js";
import type { WritingRules } from "../types.js";

// 2026-10-09 十章验收第十二轮：作者开头说「每章至少 2400 字」，AI 写规则时顺带把节奏从建书默认「中等」改成「慢热」，
// 被当成替换已有长期设定要确认，整条（连字数下限）没写进去。
async function makeBook(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "story-engine-rule-defaults-"));
  const { projectDir } = await createStoryProject({ rootDir, title: "修表铺", genre: "urban", premise: "老街修表铺。", mainCharacterName: "林舟" });
  return projectDir;
}

const rulesOf = async (dir: string) => JSON.parse(await readFile(join(dir, "story", "writing-rules.json"), "utf-8")) as WritingRules;

describe("建书默认的写作规则可以直接改，作者定过的才要确认", () => {
  it("把默认节奏改掉、顺带设字数下限 → 直接写入", async () => {
    const dir = await makeBook();
    const result = await applyFoundationWriteSuggestion({
      projectDir: dir,
      suggestion: {
        actionType: "update_writing_rule", category: "writingRules", targetFile: "story/writing-rules.json", targetPath: "$",
        after: { pacing: "慢热", chapterLength: { targetWords: 3000, minWords: 2400 } },
      },
    });
    expect(result.blockedWrites ?? []).toEqual([]);
    const rules = await rulesOf(dir);
    expect(rules.pacing).toBe("慢热");
    expect(rules.chapterLength?.minWords).toBe(2400);
  });

  it("作者自己定过的节奏被改 → 仍要确认（不静默覆盖）", async () => {
    const dir = await makeBook();
    await applyFoundationWriteSuggestion({
      projectDir: dir,
      suggestion: { actionType: "update_writing_rule", category: "writingRules", targetFile: "story/writing-rules.json", targetPath: "$", after: { pacing: "慢热" } },
    });
    const blocked = await applyFoundationWriteSuggestion({
      projectDir: dir,
      suggestion: { actionType: "update_writing_rule", category: "writingRules", targetFile: "story/writing-rules.json", targetPath: "$", after: { pacing: "快节奏" } },
    });
    expect(blocked.blockedWrites?.[0]?.level).toBe("needs_confirmation");
    expect((await rulesOf(dir)).pacing).toBe("慢热");
  });
});
