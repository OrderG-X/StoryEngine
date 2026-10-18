// @vitest-environment node
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ALIAS_TABLE_RELATIVE_PATH,
  buildAliasTableFromCharacters,
  buildAliasTableWithLlm,
  generateAndWriteAliasTable,
  readAliasTable,
} from "./alias-generator.js";

const character = (
  id: string,
  name: string,
  role = "",
  extra: Record<string, unknown> = {},
) => ({ id, name, role, ...extra });

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "alias-generator-"));
  await mkdir(join(dir, "story"), { recursive: true });
  return dir;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), "utf-8");
}

describe("alias generator rules", () => {
  it("extracts conservative Chinese name aliases (no role-title guessing)", () => {
    const result = buildAliasTableFromCharacters([
      character("c-guo", "林远", "集团总裁"),
      character("c-lin", "苏楚瑶", "调查员"),
      character("c-long", "欧阳娜娜", "医生"),
      character("c-en", "Alex", "教授"),
    ]);

    expect(result.table.byEntity["c-guo"]?.aliases).toEqual(["远", "林"]);
    expect(result.table.byEntity["c-lin"]?.aliases).toEqual(["楚瑶", "苏"]);
    expect(result.table.byEntity["c-long"]?.aliases).toEqual(["欧"]);
    expect(result.table.byEntity["c-en"]?.aliases).toEqual([]);
  });

  it("marks surname conflicts and does not add the conflicted surname to either character", () => {
    const result = buildAliasTableFromCharacters([
      character("c-guo-xu", "林远", "总裁"),
      character("c-guo-ming", "林明", "医生"),
    ]);

    expect(result.table.conflicts).toEqual([
      { surname: "林", entityIds: ["c-guo-xu", "c-guo-ming"], note: "同姓，姓不作唯一别名" },
    ]);
    expect(result.table.byEntity["c-guo-xu"]?.aliases).not.toContain("林");
    expect(result.table.byEntity["c-guo-ming"]?.aliases).not.toContain("林");
  });

  it("does not extract aliases from speech samples or prose-like fields", () => {
    const result = buildAliasTableFromCharacters([
      character("c-guo", "林远", "", {
        speechSamples: ["大家都叫我远哥。"],
        relationshipDynamics: ["旁人私下喊他林老板。"],
      }),
    ]);

    expect(result.table.byEntity["c-guo"]?.aliases).toEqual(["远", "林"]);
    expect(result.table.byEntity["c-guo"]?.aliases).not.toContain("远哥");
    expect(result.table.byEntity["c-guo"]?.aliases).not.toContain("林老板");
  });
});

describe("alias table merge and IO", () => {
  it("preserves user additions/removals when regenerating and reports the merge honestly", () => {
    const previous = {
      version: "v0" as const,
      byEntity: {
        "c-guo": {
          canonicalName: "林远",
          primary: "林远",
          aliases: ["远", "远哥"],
          generated: ["远", "林"],
          type: "character" as const,
        },
      },
      conflicts: [],
    };

    const result = buildAliasTableFromCharacters([character("c-guo", "林远", "董事长")], previous);

    // 作者删掉了「林」、加了「远哥」：重新生成时两样都保住
    expect(result.table.byEntity["c-guo"]?.aliases).toEqual(["远", "远哥"]);
    expect(result.table.byEntity["c-guo"]?.generated).toEqual(["远", "林"]);
    expect(result.mergeReport.preservedUserAdditions).toBe(1);
    expect(result.mergeReport.preservedUserRemovals).toBe(1);
    expect(result.mergeReport.generatedAdded).toBe(0);
    expect(result.mergeReport.generatedRemoved).toBe(0);
  });

  it("keeps a user-removed LLM alias removed on regeneration", async () => {
    const previous = {
      version: "v0" as const,
      byEntity: {
        "c-guo": {
          canonicalName: "林远",
          primary: "林远",
          aliases: ["远", "林"],
          generated: ["远", "林", "林少"],
          type: "character" as const,
        },
      },
      conflicts: [],
    };

    const result = await buildAliasTableWithLlm([character("c-guo", "林远", "总裁")], {
      previous,
      proposeAliases: async () => ["林少"],
    });

    expect(result.table.byEntity["c-guo"]?.generated).toContain("林少");
    expect(result.table.byEntity["c-guo"]?.aliases).not.toContain("林少");
    expect(result.mergeReport.preservedUserRemovals).toBe(1);
  });

  it("validates LLM proposed aliases before merging them into generated aliases", async () => {
    const result = await buildAliasTableWithLlm([
      character("c-guo", "林远", "总裁"),
      character("c-lin", "苏楚瑶", "朋友"),
      character("c-other-guo", "林明", "朋友"),
    ], {
      proposeAliases: async (characterInput) =>
        characterInput.id === "c-guo"
          ? ["林总", "林少", "远哥", "少爷", "马云", "苏楚瑶", "林明", "林远", "林远特别长名", "A远"]
          : [],
    });

    expect(result.llmReport.proposedByEntity["c-guo"]).toEqual(["林总", "林少", "远哥"]);
    expect(result.table.byEntity["c-guo"]?.generated).toEqual(["远", "林总", "林少", "远哥"]);
    expect(result.table.byEntity["c-guo"]?.aliases).toEqual(["远", "林总", "林少", "远哥"]);
  });

  it("falls back to rule aliases with a warning when LLM proposals fail", async () => {
    const result = await buildAliasTableWithLlm([character("c-guo", "林远", "总裁")], {
      proposeAliases: async () => {
        throw new Error("timeout");
      },
    });

    expect(result.table.byEntity["c-guo"]?.aliases).toEqual(["远", "林"]);
    expect(result.warnings).toEqual(["LLM 不可用，仅规则生成：timeout"]);
    expect(result.llmReport.proposedByEntity).toEqual({});
  });

  it("reads a missing alias table as an empty v0 table", async () => {
    const projectDir = await tempProject();

    await expect(readAliasTable(projectDir)).resolves.toEqual({
      version: "v0",
      byEntity: {},
      conflicts: [],
    });
  });

  it("softens bad alias-table JSON during regeneration and writes a fresh table", async () => {
    const projectDir = await tempProject();
    await writeJson(join(projectDir, "story", "character-bible.json"), {
      version: "v0",
      characters: [character("c-guo", "林远", "总裁")],
    });
    await mkdir(join(projectDir, ".story-engine-ui"), { recursive: true });
    await writeFile(join(projectDir, ALIAS_TABLE_RELATIVE_PATH), "{ broken json", "utf-8");

    const result = await generateAndWriteAliasTable(projectDir);
    const disk = JSON.parse(await readFile(join(projectDir, ALIAS_TABLE_RELATIVE_PATH), "utf-8"));

    expect(result.ok).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("alias-tables.json"))).toBe(true);
    expect(disk.byEntity["c-guo"].aliases).toEqual(["远", "林"]);
  });

  it("writes LLM proposals when a proposal dependency is injected", async () => {
    const projectDir = await tempProject();
    await writeJson(join(projectDir, "story", "character-bible.json"), {
      version: "v0",
      characters: [character("c-guo", "林远", "总裁")],
    });

    const result = await generateAndWriteAliasTable(projectDir, {
      proposeAliases: async () => ["林少", "远哥"],
    });
    const disk = JSON.parse(await readFile(join(projectDir, ALIAS_TABLE_RELATIVE_PATH), "utf-8"));

    expect(result.summary).toContain("给林远提议：林少、远哥");
    expect(disk.byEntity["c-guo"].aliases).toEqual(["远", "林", "林少", "远哥"]);
  });
});
