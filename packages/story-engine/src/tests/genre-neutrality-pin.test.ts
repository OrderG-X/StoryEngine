import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// C2c genre-neutrality pins. These guard against re-introducing hardcoded
// prior-work ("末世/丧尸") or any genre-specific term tables into the engine's
// extraction / scoring / classification heuristics. The engine must extract,
// score, and classify using only generic narrative signals and project-driven
// data (location-bible, character names), never baked-in genre vocabulary.
const LEGACY_GENRE_TERMS = /林镇山|远山集团|周景行|陈国辉|灵石|避难所广播|无线电异常信号|感染者|旧城区灾变|林序|许澄|魂钢|创业孵化楼|财团联合检测中心|老邮局|海天市/u;

describe("genre neutrality pins", () => {

  it("keeps the engine heuristics source free of any prior-work genre term table", async () => {
    const files = [
      // R5b 扩 pin：纳入数据驱动化后的引擎文件，防专名再溜回
      "commit-quality-check.ts",
      "state-overview.ts",
      "writing-context-pack.ts",
      "foundation-gap-assistant.ts",
      "foundation-write-gateway.ts",
    ];
    for (const file of files) {
      const source = await readFile(join(import.meta.dirname, "..", file), "utf-8");
      // 只查活代码：去掉纯注释行 + 块注释（注释里说明「R5b 删了 X 专名」是无害记录，pin 防的是活代码里的硬编码词表/正则）。
      const code = source
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n")
        .replace(/\/\*[\s\S]*?\*\//gu, "");
      expect(code, `${file} must not hardcode prior-work genre terms in live code`).not.toMatch(LEGACY_GENRE_TERMS);
    }
  });
});
