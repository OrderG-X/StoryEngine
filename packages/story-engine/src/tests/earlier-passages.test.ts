import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findEarlierPassages } from "../earlier-passages.js";

describe("按章纲翻旧章原文（长篇）", () => {
  it("每个词取最近一次和第一次写到它的那段：第 1 章介绍它的原句不会被后面几十章挤掉", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "earlier-passages-"));
    await mkdir(join(projectDir, "chapters"), { recursive: true });
    for (let chapter = 1; chapter <= 40; chapter += 1) {
      const body = chapter === 1
        ? "樟木箱是外婆的陪嫁，铜锁上刻着一朵梅花。"
        : `第${chapter}章里樟木箱还在床底下。`;
      await writeFile(join(projectDir, "chapters", `${String(chapter).padStart(4, "0")}.md`), `# 第${chapter}章\n\n${body}\n`, "utf-8");
    }
    const passages = await findEarlierPassages({ projectDir, chapter: 41, terms: ["樟木箱"] });
    expect(passages.map((item) => item.chapter)).toEqual([1, 40]);
    expect(passages[0]!.text).toContain("梅花");
  });
});
