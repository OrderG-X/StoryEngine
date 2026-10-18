import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  buildMatrixEnrichmentMessages,
  generateMatrixEnrichment,
  matrixEnrichmentSchema,
  mergeMatrixEnrichmentIntoEngine,
  parseMatrixEnrichment,
  summarizeMatrixEnrichment,
  type MatrixCharacterInput,
  type MatrixRelationshipInput,
} from "./matrix-enrichment.js";

// 用 zod 输入类型：default 字段（matrixOverrides/relationshipExtras）输入侧可省。
const VALID: z.input<typeof matrixEnrichmentSchema> = {
  matrixOverrides: {
    "char-guoxu": { narrativeRole: "主角推动者 · 用黑卡撬动整条阶层线" },
    "char-laochen": { narrativeRole: "压力源 / 引路人 · 既提携又掂量主角底牌" },
  },
  relationshipExtras: {
    "char-laochen|引荐人": {
      pairFrom: "林远",
      emotionalDebt: "老陈欠林远一次没说破的提携",
      redline: "第 1 章不可当面翻脸",
      nextTurn: "第 3 章老陈试探黑卡来历，关系由暖转冷",
    },
  },
};

const CHARACTERS: readonly MatrixCharacterInput[] = [
  { id: "char-guoxu", name: "林远", role: "主角", roleHint: "城中村出身" },
  { id: "char-laochen", name: "老陈", role: "星耀会引荐人" },
];

const RELATIONSHIPS: readonly MatrixRelationshipInput[] = [
  {
    key: "char-laochen|引荐人",
    fromName: "林远",
    targetName: "老陈",
    relationType: "引荐人",
    attitude: "表面提携",
    trustLevel: "medium",
    conflict: "暗里掂量底牌",
  },
];

afterEach(() => vi.restoreAllMocks());

async function tempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "me-test-"));
}

describe("matrix-enrichment 生成与落盘", () => {
  it("buildMatrixEnrichmentMessages：含禁编造/键取自角色id/键取自关系键等约束，user 带真实角色id与关系键", () => {
    const msgs = buildMatrixEnrichmentMessages(CHARACTERS, RELATIONSHIPS);
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("禁编造");
    expect(msgs[0].content).toContain("叙事岗位");
    expect(msgs[0].content).toContain("关系红线");
    // 键必须取自给定角色 id / 关系键的硬约束。
    expect(msgs[0].content).toContain("键必须逐字取自下方给定的角色 id");
    expect(msgs[0].content).toContain("键必须逐字取自下方给定的关系键");
    // user 逐条列出真实角色 id 与关系键。
    expect(msgs[1].content).toContain("char-guoxu");
    expect(msgs[1].content).toContain("char-laochen");
    expect(msgs[1].content).toContain("char-laochen|引荐人");
  });

  it("generate：ok + 结构落到 .story-engine-ui/matrix-enrichment.json", async () => {
    const dir = await tempProject();
    const callModel = vi.fn(async () => JSON.stringify(VALID));
    const r = await generateMatrixEnrichment({ projectDir: dir, characters: CHARACTERS, relationships: RELATIONSHIPS, callModel });

    expect(r.ok).toBe(true);
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(r.summary).toContain("补全");
    const saved = JSON.parse(await readFile(join(dir, ".story-engine-ui", "matrix-enrichment.json"), "utf-8"));
    expect(saved.matrixOverrides["char-guoxu"].narrativeRole).toContain("主角推动者");
    expect(saved.relationshipExtras["char-laochen|引荐人"].redline).toContain("翻脸");
  });

  it("空角色 → ok:false，不调模型", async () => {
    const dir = await tempProject();
    const callModel = vi.fn(async () => JSON.stringify(VALID));
    const r = await generateMatrixEnrichment({ projectDir: dir, characters: [], relationships: [], callModel });
    expect(r.ok).toBe(false);
    expect(callModel).not.toHaveBeenCalled();
  });

  it("parseMatrixEnrichment：非 JSON / 未知字段(strict) → 抛错（绝不放过半成品）", () => {
    expect(() => parseMatrixEnrichment("这不是 JSON")).toThrow();
    // trustPercent 已取消（信任度归引擎三档权威）→ strict schema 拒未知字段。
    expect(() =>
      parseMatrixEnrichment(JSON.stringify({ relationshipExtras: { "a|b": { trustPercent: 55 } } })),
    ).toThrow();
  });

  it("parseMatrixEnrichment：能从带前后文的文本里抠出 JSON，并对缺省字段补默认值", () => {
    const wrapped = "好的，结果如下：\n" + JSON.stringify(VALID) + "\n（以上）";
    expect(Object.keys(parseMatrixEnrichment(wrapped).matrixOverrides)).toHaveLength(2);
    // 空对象 → 两个 default 字段补全，不抛错。
    const empty = parseMatrixEnrichment("{}");
    expect(empty.matrixOverrides).toEqual({});
    expect(empty.relationshipExtras).toEqual({});
  });

  it("R4：矩阵摘要按 merge 三态如实告知是否接进正文", () => {
    const data = matrixEnrichmentSchema.parse(VALID);
    expect(summarizeMatrixEnrichment(data, { merged: true })).toContain("接进正文");
    expect(summarizeMatrixEnrichment(data, { merged: false })).toContain("未能接进正文");
  });
});

async function makeBibleProject(characters: unknown[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "r4-matrix-merge-"));
  await mkdir(join(dir, "story"), { recursive: true });
  await writeFile(join(dir, "story", "character-bible.json"), JSON.stringify({ version: "v0", characters }), "utf-8");
  return dir;
}

describe("mergeMatrixEnrichmentIntoEngine", () => {
  it("把叙事岗位并进角色 extraFields、关系账本并进配角 relationshipDynamics", async () => {
    const dir = await makeBibleProject([
      { id: "char-guoxu", name: "林远" },
      { id: "char-laochen", name: "老陈", relationshipDynamics: ["旧识"] },
    ]);
    const result = await mergeMatrixEnrichmentIntoEngine(dir, {
      matrixOverrides: { "char-laochen": { narrativeRole: "引路人 / 压力源" } },
      relationshipExtras: {
        "char-laochen|师徒": { emotionalDebt: "老陈欠林远一次提携", redline: "不可当面翻脸", nextTurn: "老陈摊牌" },
      },
    });
    expect(result.merged).toBe(true);
    const bible = JSON.parse(await readFile(join(dir, "story", "character-bible.json"), "utf-8"));
    const laochen = bible.characters.find((c: { id: string }) => c.id === "char-laochen");
    expect(laochen.extraFields["叙事岗位"]).toBe("引路人 / 压力源");
    expect(laochen.relationshipDynamics).toEqual(expect.arrayContaining([
      "旧识", "情感债：老陈欠林远一次提携", "关系红线：不可当面翻脸", "下一次转折：老陈摊牌",
    ]));
  });

  it("无 bible 文件 / 无命中 → merged:false（正常跳过）", async () => {
    const noBible = await mkdtemp(join(tmpdir(), "r4-nobible-"));
    expect(await mergeMatrixEnrichmentIntoEngine(noBible, { matrixOverrides: {}, relationshipExtras: {} })).toEqual({ merged: false });
    const dir = await makeBibleProject([{ id: "char-guoxu", name: "林远" }]);
    expect(await mergeMatrixEnrichmentIntoEngine(dir, { matrixOverrides: { "char-ghost": { narrativeRole: "x" } }, relationshipExtras: {} })).toEqual({ merged: false });
  });

  it("relationshipExtras 键按 targetName 命中（无 id 时）", async () => {
    const dir = await makeBibleProject([{ id: "char-guoxu", name: "林远" }, { name: "神秘人" }]);
    const result = await mergeMatrixEnrichmentIntoEngine(dir, {
      matrixOverrides: {},
      relationshipExtras: { "神秘人|敌对": { redline: "暂不撕破脸" } },
    });
    expect(result.merged).toBe(true);
    const bible = JSON.parse(await readFile(join(dir, "story", "character-bible.json"), "utf-8"));
    expect(bible.characters.find((c: { name: string }) => c.name === "神秘人").relationshipDynamics).toContain("关系红线：暂不撕破脸");
  });

  it("generateMatrixEnrichment persist 后并入引擎、返回 mergedIntoEngine=true", async () => {
    const dir = await makeBibleProject([{ id: "char-laochen", name: "老陈" }]);
    const callModel = vi.fn().mockResolvedValue(JSON.stringify({
      matrixOverrides: { "char-laochen": { narrativeRole: "引路人" } },
      relationshipExtras: {},
    }));
    const result = await generateMatrixEnrichment({
      projectDir: dir,
      characters: [{ id: "char-laochen", name: "老陈" }],
      relationships: [],
      callModel,
    });
    expect(result.ok).toBe(true);
    expect(result.mergedIntoEngine).toBe(true);
    const bible = JSON.parse(await readFile(join(dir, "story", "character-bible.json"), "utf-8"));
    expect(bible.characters[0].extraFields["叙事岗位"]).toBe("引路人");
  });
});
