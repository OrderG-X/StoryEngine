import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  buildCharacterEnrichmentMessages,
  characterEnrichmentSchema,
  generateCharacterEnrichment,
  mergeCharacterEnrichmentIntoEngine,
  parseCharacterEnrichment,
  type CharacterEntityInput,
} from "./character-enrichment.js";

// 用 zod 输入类型：dailyAnchors 有 default，输入侧可省。
const VALID: z.input<typeof characterEnrichmentSchema> = {
  byCharacter: {
    "林远": {
      core: "城中村出身、骨子里怕被看穿『装的』的人",
      surface: "西装革履、谈吐从容的新晋富豪",
      mask: "在星耀会里刻意端着的『见过世面』的派头",
      innerLack: "缺一份不靠伪装也能被接纳的底气",
      emotionalExposure: "心虚时会下意识摸袖口、把『那个』口头禅说多",
      dailyAnchors: ["随身带一支廉价中性笔", "习惯把账记在手机备忘录"],
      arcStart: "以为只要装得够像就能真的融入上流",
      arcSetback: "黑卡来历被老陈当众试探，第一次差点露馅",
      arcCost: "要么坦白出身、要么彻底成为自己讨厌的样子",
    },
    "老陈": {
      core: "把人情都换算成筹码的引荐人",
      surface: "笑呵呵、热心提携后辈的老好人",
      mask: "对谁都『自己人』的称兄道弟",
      innerLack: "缺一段不掺利益的真感情",
      dailyAnchors: ["茶不离手", "说话前先笑三声"],
    },
  },
};

const CHARACTERS: readonly CharacterEntityInput[] = [
  { name: "林远", role: "主角", identity: "新晋富豪（伪装）", fear: "被拆穿非富豪身份", weakness: "底气不足" },
  { name: "老陈", role: "引荐人", identity: "星耀会掮客" },
];

afterEach(() => vi.restoreAllMocks());

async function tempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ce-test-"));
}

describe("character-enrichment 生成与落盘", () => {
  it("buildCharacterEnrichmentMessages：含禁编造/按真实键/三层人格/成长弧等约束，user 带真实角色名", () => {
    const msgs = buildCharacterEnrichmentMessages(CHARACTERS);
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("禁编造");
    expect(msgs[0].content).toContain("内核人格");
    expect(msgs[0].content).toContain("社交伪装");
    expect(msgs[0].content).toContain("成长弧");
    // 键必须取自给定角色名的硬约束。
    expect(msgs[0].content).toContain("键必须逐字取自下方给定的角色名");
    // user 逐条列出真实角色名。
    expect(msgs[1].content).toContain("林远");
    expect(msgs[1].content).toContain("老陈");
  });

  it("generate：ok + 结构落到 .story-engine-ui/character-enrichment.json（byCharacter 按角色名索引）", async () => {
    const dir = await tempProject();
    const callModel = vi.fn(async () => JSON.stringify(VALID));
    const r = await generateCharacterEnrichment({ projectDir: dir, characters: CHARACTERS, callModel });

    expect(r.ok).toBe(true);
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(r.summary).toContain("补全");
    const saved = JSON.parse(await readFile(join(dir, ".story-engine-ui", "character-enrichment.json"), "utf-8"));
    expect(saved.byCharacter["林远"].core).toContain("城中村");
    expect(saved.byCharacter["林远"].arcStart).toContain("装");
    expect(saved.byCharacter["林远"].dailyAnchors).toHaveLength(2);
    // 没给 dailyAnchors 的角色 default 补成空数组、没给成长弧字段则缺省。
    expect(saved.byCharacter["老陈"].dailyAnchors).toHaveLength(2);
    expect(saved.byCharacter["老陈"].arcStart).toBeUndefined();
  });

  it("generate：persist 后自动并入 character-bible，做厚字段进 extraFields", async () => {
    const dir = await tempProject();
    await mkdir(join(dir, "story"), { recursive: true });
    await writeFile(
      join(dir, "story", "character-bible.json"),
      JSON.stringify({ version: "v0", characters: [{ id: "guo-xu", name: "林远", role: "主角" }] }, null, 2),
      "utf-8",
    );
    const callModel = vi.fn(async () => JSON.stringify(VALID));
    await generateCharacterEnrichment({ projectDir: dir, characters: CHARACTERS, callModel });

    const bible = JSON.parse(await readFile(join(dir, "story", "character-bible.json"), "utf-8"));
    const guo = bible.characters.find((c: { readonly name: string }) => c.name === "林远");
    expect(guo.extraFields?.["内核人格"]).toContain("城中村");
  });

  it("空角色 → ok:false，不调模型", async () => {
    const dir = await tempProject();
    const callModel = vi.fn(async () => JSON.stringify(VALID));
    const r = await generateCharacterEnrichment({ projectDir: dir, characters: [], callModel });
    expect(r.ok).toBe(false);
    expect(callModel).not.toHaveBeenCalled();
  });

  it("parseCharacterEnrichment：非 JSON / 字段非法 → 抛错（绝不放过半成品）", () => {
    expect(() => parseCharacterEnrichment("这不是 JSON")).toThrow();
    // byCharacter 条目里 core 不是字符串 → 抛错。
    expect(() => parseCharacterEnrichment(JSON.stringify({ byCharacter: { 林远: { core: 123 } } }))).toThrow();
    // 顶层出现未知字段（strict）→ 抛错。
    expect(() => parseCharacterEnrichment(JSON.stringify({ byCharacter: {}, extra: 1 }))).toThrow();
  });

  it("parseCharacterEnrichment：能从带前后文的文本里抠出 JSON，并对缺省字段补默认值", () => {
    const wrapped = "好的，结果如下：\n" + JSON.stringify(VALID) + "\n（以上）";
    expect(Object.keys(parseCharacterEnrichment(wrapped).byCharacter)).toHaveLength(2);
    // 空对象 → byCharacter default 补成空对象，不抛错。
    const empty = parseCharacterEnrichment("{}");
    expect(empty.byCharacter).toEqual({});
  });
});

describe("mergeCharacterEnrichmentIntoEngine 并入引擎（做厚真进正文）", () => {
  async function projectWithBible(): Promise<string> {
    const dir = await tempProject();
    await mkdir(join(dir, "story"), { recursive: true });
    await writeFile(
      join(dir, "story", "character-bible.json"),
      JSON.stringify({
        version: "v0",
        characters: [
          { id: "guo-xu", name: "林远", role: "主角" },
          { id: "lao-chen", name: "老陈", role: "引荐人", relationshipToProtagonist: "把林远引进星耀会的掮客" },
        ],
      }, null, 2),
      "utf-8",
    );
    return dir;
  }

  it("把三层人格/成长弧/日常锚点按中文键并进 character-bible 对应角色的 extraFields", async () => {
    const dir = await projectWithBible();
    await mergeCharacterEnrichmentIntoEngine(dir, characterEnrichmentSchema.parse(VALID));

    const bible = JSON.parse(await readFile(join(dir, "story", "character-bible.json"), "utf-8"));
    const guo = bible.characters.find((c: { readonly name: string }) => c.name === "林远");
    expect(guo.extraFields["内核人格"]).toContain("城中村");
    expect(guo.extraFields["社交伪装"]).toContain("端着");
    expect(guo.extraFields["内部缺失"]).toContain("底气");
    expect(guo.extraFields["情绪外露"]).toContain("袖口");
    expect(guo.extraFields["日常锚点"]).toEqual(["随身带一支廉价中性笔", "习惯把账记在手机备忘录"]);
    expect(guo.extraFields["成长弧·起点误区"]).toContain("装");

    const chen = bible.characters.find((c: { readonly name: string }) => c.name === "老陈");
    expect(chen.extraFields["内核人格"]).toContain("筹码");
    // 老陈没给成长弧 → 不写空键。
    expect(chen.extraFields["成长弧·起点误区"]).toBeUndefined();
    // 不 clobber 既有字段。
    expect(chen.role).toBe("引荐人");
    expect(chen.relationshipToProtagonist).toContain("掮客");
  });

  it("缺 character-bible 文件时返回 {merged:false}（正常跳过、非失败）", async () => {
    const dir = await tempProject(); // 没有 story/character-bible.json
    await expect(mergeCharacterEnrichmentIntoEngine(dir, characterEnrichmentSchema.parse(VALID)))
      .resolves.toEqual({ merged: false });
  });

  it("正常并入时 merge 返回 {merged:true}", async () => {
    const dir = await projectWithBible();
    const r = await mergeCharacterEnrichmentIntoEngine(dir, characterEnrichmentSchema.parse(VALID));
    expect(r).toEqual({ merged: true });
  });

  it("写盘失败时 merge 返回 {merged:false, reason 含失败}", async () => {
    const dir = await projectWithBible();
    // 写已收口 writeFileAtomic（tmp+rename，审计 Med）：只读文件挡不住 rename——注入改为只读
    // story 目录（tmp 建不出来 → EACCES），真异常走第二层 catch 返回带 reason 的 {merged:false}。
    await chmod(join(dir, "story"), 0o555);
    try {
      const r = await mergeCharacterEnrichmentIntoEngine(dir, characterEnrichmentSchema.parse(VALID));
      expect(r.merged).toBe(false);
      expect(r.reason ?? "").toContain("失败");
    } finally {
      await chmod(join(dir, "story"), 0o755); // 恢复可写，否则 mkdtemp 清理不掉
    }
  });

  it("写盘失败时 generate 仍 ok:true 但 mergedIntoEngine:false 且 summary 如实标注未进正文", async () => {
    const dir = await projectWithBible();
    // 同上：writeFileAtomic 时代的失败注入 = 只读目录（挡 tmp 创建）。
    await chmod(join(dir, "story"), 0o555);
    try {
      const callModel = vi.fn(async () => JSON.stringify(VALID));
      const r = await generateCharacterEnrichment({ projectDir: dir, characters: CHARACTERS, callModel });
      expect(r.ok).toBe(true);
      expect(r.mergedIntoEngine).toBe(false);
      expect(r.summary).toContain("未能");
    } finally {
      await chmod(join(dir, "story"), 0o755);
    }
  });

  it("R2 件③：bible 条目改名后仍按 id 命中并入（不漏并）", async () => {
    const dir = await tempProject();
    await mkdir(join(dir, "story"), { recursive: true });
    // bible：id=guo-xu 的角色 name 已被改成「林远东」
    await writeFile(
      join(dir, "story", "character-bible.json"),
      JSON.stringify({ version: "v0", characters: [{ id: "guo-xu", name: "林远东" }] }),
      "utf-8",
    );
    // enrichment 仍以旧名「林远」为键，但带 idMap 把 guo-xu → 旧键名「林远」
    const data = characterEnrichmentSchema.parse({
      byCharacter: { "林远": { core: "城中村出身、骨子里怕被看穿的人" } },
      idMap: { "guo-xu": "林远" },
    });
    const r = await mergeCharacterEnrichmentIntoEngine(dir, data);
    expect(r.merged).toBe(true);
    const bible = JSON.parse(await readFile(join(dir, "story", "character-bible.json"), "utf-8"));
    const guo = bible.characters.find((c: { readonly id: string }) => c.id === "guo-xu");
    expect(guo.extraFields["内核人格"]).toContain("城中村");
  });
});
