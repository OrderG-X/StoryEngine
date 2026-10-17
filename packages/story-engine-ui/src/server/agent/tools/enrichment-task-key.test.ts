// @vitest-environment node
//
// 守卫测试：8 个「做厚」工具都走 resolveConfiguredChatModel("enrichment")（与「章节方案」分槽），
// 不再共用 chapterSteering。章节方案语义的消费点（commit-apply/chapter-chat/foundation-gaps）不在此列、保持不变。
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENRICH_TOOLS = [
  "generate-worldbuilding",
  "generate-asset-enrichment",
  "generate-location-enrichment",
  "generate-character-enrichment",
  "generate-matrix-enrichment",
  "generate-character-relationships",
  "generate-writing-rules-enrichment",
  "generate-alias-table",
];

describe("做厚工具走 enrichment task key", () => {
  it.each(ENRICH_TOOLS)("%s 用 resolveConfiguredChatModel(\"enrichment\")，无残留 chapterSteering", async (name) => {
    const src = await readFile(join(HERE, `${name}.ts`), "utf-8");
    expect(src).toContain('resolveConfiguredChatModel("enrichment")');
    expect(src).not.toContain('resolveConfiguredChatModel("chapterSteering")');
  });
});
