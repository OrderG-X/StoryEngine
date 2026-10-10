// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

const { calls, fakeTool } = vi.hoisted(() => {
  const calls: { tool: string; args: unknown }[] = [];
  const fakeTool = (tool: string) => ({ execute: async (args: unknown) => { calls.push({ tool, args }); return { ok: true, summary: `${tool} 做完了` }; } });
  return { calls, fakeTool };
});

vi.mock("./generate-worldbuilding.js", () => ({ generateWorldbuildingTool: fakeTool("generate_worldbuilding") }));
vi.mock("./generate-character-enrichment.js", () => ({ generateCharacterEnrichmentTool: fakeTool("generate_character_enrichment") }));
vi.mock("./generate-asset-enrichment.js", () => ({ generateAssetEnrichmentTool: fakeTool("generate_asset_enrichment") }));
vi.mock("./generate-location-enrichment.js", () => ({ generateLocationEnrichmentTool: fakeTool("generate_location_enrichment") }));
vi.mock("./generate-matrix-enrichment.js", () => ({ generateMatrixEnrichmentTool: fakeTool("generate_matrix_enrichment") }));
vi.mock("./generate-character-relationships.js", () => ({ generateCharacterRelationshipsTool: fakeTool("generate_character_relationships") }));
vi.mock("./generate-writing-rules-enrichment.js", () => ({ generateWritingRulesEnrichmentTool: fakeTool("generate_writing_rules_enrichment") }));
vi.mock("./generate-alias-table.js", () => ({ generateAliasTableTool: fakeTool("generate_alias_table") }));
vi.mock("./resolve-thread.js", () => ({ resolveThreadTool: fakeTool("resolve_thread") }));
vi.mock("./legacy-thread-cleanup.js", () => ({ cleanLegacyThreadsTool: fakeTool("clean_legacy_threads") }));
vi.mock("./group-related-leads.js", () => ({ groupRelatedLeadsTool: fakeTool("group_related_leads") }));
vi.mock("./set-foreshadowing-importance.js", () => ({ setForeshadowingImportanceTool: fakeTool("set_foreshadowing_importance") }));

import { enrichFoundationTool } from "./enrich-foundation.js";
import { manageThreadsTool } from "./manage-threads.js";

type Exec = (input: Record<string, unknown>, context: unknown) => Promise<Record<string, unknown>>;
const enrich = enrichFoundationTool.execute as unknown as Exec;
const threads = manageThreadsTool.execute as unknown as Exec;

describe("合并入口（2026-10-10 对话 AI 瘦身）", () => {
  it("enrich_foundation 按 kind 转给原工具；只给要补的那几个；结果带 kind", async () => {
    calls.length = 0;
    const out = await enrich({ kind: "characters", targetNames: ["苏晚"] }, {});
    expect(calls).toEqual([{ tool: "generate_character_enrichment", args: { targetNames: ["苏晚"] } }]);
    expect(out).toMatchObject({ ok: true, kind: "characters" });
    await enrich({ kind: "world", premise: "八十年代南方小城", targetNames: ["无关"] }, {});
    expect(calls.at(-1)).toEqual({ tool: "generate_worldbuilding", args: { premise: "八十年代南方小城" } });
    await enrich({ kind: "aliases" }, {});
    expect(calls.at(-1)).toEqual({ tool: "generate_alias_table", args: {} });
  });

  it("manage_threads 按 op 转给原工具；缺参数如实说缺什么、不调原工具", async () => {
    calls.length = 0;
    await threads({ op: "resolve", query: "安保盘问" }, {});
    expect(calls).toEqual([{ tool: "resolve_thread", args: { query: "安保盘问" } }]);
    await threads({ op: "importance", id: "hook-3", importance: "major" }, {});
    expect(calls.at(-1)).toEqual({ tool: "set_foreshadowing_importance", args: { id: "hook-3", importance: "major" } });
    await threads({ op: "clean" }, {});
    expect(calls.at(-1)?.tool).toBe("clean_legacy_threads");
    const before = calls.length;
    expect(await threads({ op: "resolve" }, {})).toMatchObject({ ok: false });
    expect(await threads({ op: "importance", id: "hook-3" }, {})).toMatchObject({ ok: false });
    expect(calls.length).toBe(before);
  });
});
