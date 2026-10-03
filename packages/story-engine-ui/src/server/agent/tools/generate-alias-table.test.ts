// @vitest-environment node
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const llmMocks = vi.hoisted(() => ({
  resolveConfiguredChatModel: vi.fn(),
  streamChatModelToText: vi.fn(),
  callOpenAICompatibleChatModel: vi.fn(),
}));
vi.mock("../../lib/llm-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/llm-client.js")>();
  return { ...actual, ...llmMocks };
});

import { ALIAS_TABLE_RELATIVE_PATH, readAliasTable, type AliasTable } from "../alias-generator/alias-generator.js";
import { createConfiguredAliasProposer, generateAliasTableLogic } from "./generate-alias-table.js";

describe("createConfiguredAliasProposer（P2：走流式空闲超时，不再是非流式 60s 固定死表）", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("用 enrichment 档调 streamChatModelToText（无 timeoutMs / 无 max_tokens），解析 JSON 数组", async () => {
    llmMocks.resolveConfiguredChatModel.mockResolvedValue({
      provider: { id: "p", baseUrl: "https://x.invalid/v1" },
      profile: { id: "m", provider: "p", model: "m" },
      apiKey: "",
      thinking: true,
      thinkingDialect: "none",
    });
    llmMocks.streamChatModelToText.mockResolvedValue({ content: "[\"林总\",\"远哥\"]", thinking: "" });
    const propose = await createConfiguredAliasProposer();
    const aliases = await propose({ id: "c-guo", name: "林远", role: "总裁" });
    expect(aliases).toEqual(["林总", "远哥"]);
    expect(llmMocks.resolveConfiguredChatModel).toHaveBeenCalledWith("enrichment");
    expect(llmMocks.callOpenAICompatibleChatModel).not.toHaveBeenCalled();
    const call = llmMocks.streamChatModelToText.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.temperature).toBe(0.2);
    expect("timeoutMs" in call).toBe(false);
    expect("max_tokens" in call || "maxTokens" in call).toBe(false);
  });

  it("流式返回空内容 → 抛错（由上层降级为仅规则 + warning，不把空串当「没有别名」）", async () => {
    llmMocks.resolveConfiguredChatModel.mockResolvedValue({
      provider: { id: "p", baseUrl: "https://x.invalid/v1" },
      profile: { id: "m", provider: "p", model: "m" },
      apiKey: "",
      thinking: false,
      thinkingDialect: "none",
    });
    llmMocks.streamChatModelToText.mockResolvedValue({ content: "", thinking: "" });
    const propose = await createConfiguredAliasProposer();
    await expect(propose({ id: "c-guo", name: "林远", role: "总裁" })).rejects.toThrow("空内容");
  });
});

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "generate-alias-tool-"));
  await mkdir(join(dir, "story"), { recursive: true });
  await writeFile(
    join(dir, "story", "character-bible.json"),
    JSON.stringify({
      version: "v0",
      characters: [
        { id: "c-guo", name: "林远", role: "总裁" },
        { id: "c-lin", name: "苏楚瑶", role: "老师" },
      ],
    }, null, 2),
    "utf-8",
  );
  return dir;
}

describe("generate_alias_table tool logic", () => {
  it("writes .story-engine-ui/alias-tables.json and returns conflicts plus merge report", async () => {
    const projectDir = await tempProject();

    const out = await generateAliasTableLogic({
      projectDir,
      proposeAliases: async (character) => character.name === "林远" ? ["林少", "远哥"] : [],
    });
    const disk = JSON.parse(await readFile(join(projectDir, ALIAS_TABLE_RELATIVE_PATH), "utf-8"));
    const aliasTable = out.aliasTable as AliasTable;

    expect(out.ok).toBe(true);
    expect(out.summary).toContain("生成/合并 2 个角色别名");
    expect(out.summary).toContain("给林远提议：林少、远哥");
    expect(out.refreshScope).toBe("foundation");
    expect(aliasTable.byEntity["c-guo"]?.aliases).toEqual(["远", "林", "林总", "林少", "远哥"]);
    expect(disk.byEntity["c-lin"].aliases).toEqual(["楚瑶", "苏", "苏老师"]);
    expect(out.mergeReport).toMatchObject({
      preservedUserAdditions: 0,
      preservedUserRemovals: 0,
    });
  });

  it("exports a pure reader that returns an empty table when the file is missing", async () => {
    const projectDir = await tempProject();

    await expect(readAliasTable(projectDir)).resolves.toEqual({
      version: "v0",
      byEntity: {},
      conflicts: [],
    });
  });

  it("falls back to rules and reports honestly when alias proposal fails", async () => {
    const projectDir = await tempProject();

    const out = await generateAliasTableLogic({
      projectDir,
      proposeAliases: async () => {
        throw new Error("model unavailable");
      },
    });
    const aliasTable = out.aliasTable as AliasTable;

    expect(out.ok).toBe(true);
    expect(out.summary).toContain("LLM 不可用，仅规则生成");
    expect(out.warnings).toEqual(["LLM 不可用，仅规则生成：model unavailable"]);
    expect(aliasTable.byEntity["c-guo"]?.aliases).toEqual(["远", "林", "林总"]);
  });

  it("falls back to rules when creating the configured alias proposer fails", async () => {
    const projectDir = await tempProject();

    const out = await generateAliasTableLogic({
      projectDir,
      createProposer: async () => {
        throw new Error("model settings missing");
      },
    });

    expect(out.ok).toBe(true);
    expect(out.summary).toContain("LLM 不可用，仅规则生成");
    expect(out.warnings).toEqual(["LLM 不可用，仅规则生成：model settings missing"]);
  });
});
