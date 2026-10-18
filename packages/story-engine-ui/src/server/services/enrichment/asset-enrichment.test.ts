import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  assetEnrichmentSchema,
  buildAssetEnrichmentMessages,
  generateAssetEnrichment,
  mergeAssetEnrichmentIntoEngine,
  parseAssetEnrichment,
  type AssetEntityInput,
} from "./asset-enrichment.js";

// 用 zod 输入类型：default 字段（assetVisibility/ownerDescriptions/continuityRisks）输入侧可省。
const VALID: z.input<typeof assetEnrichmentSchema> = {
  assetVisibility: {
    "无限黑卡": "仅林远知 · 读者已见来历",
    "梦幻岛使用权": "林远+老陈知 · 读者暂未知是临时权",
  },
  ownerDescriptions: {
    "林远": "城中村出身的主角，黑卡持有者，最大软肋是怕被拆穿『非富豪』身份",
    "老陈": "星耀会引荐人，表面提携、暗里掂量林远的底牌",
  },
  continuityRisks: [
    { label: "铺垫缺口", detail: "「无限黑卡」第 1 章被使用前，没交代到账短信，读者会觉得凭空出现。" },
    { label: "滞留提醒", detail: "「梦幻岛使用权」是临时的，埋了两章未回收，应在第 3 章点明到期。" },
  ],
};

const ASSETS: readonly AssetEntityInput[] = [
  { name: "无限黑卡", owner: "林远", type: "金融凭证", status: "随身可用" },
  { name: "梦幻岛使用权", owner: "老陈", type: "临时权益", status: "受限" },
];

afterEach(() => vi.restoreAllMocks());

async function tempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ae-test-"));
}

describe("asset-enrichment 生成与落盘", () => {
  it("buildAssetEnrichmentMessages：含禁编造/按真实键/可见性/连续性等约束，user 带真实资产名与持有人名", () => {
    const msgs = buildAssetEnrichmentMessages(ASSETS);
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("禁编造");
    expect(msgs[0].content).toContain("读者可见");
    expect(msgs[0].content).toContain("连续性");
    // 键必须取自给定资产名/持有人名的硬约束。
    expect(msgs[0].content).toContain("键必须逐字取自下方给定的资产名");
    expect(msgs[0].content).toContain("键必须逐字取自下方给定的持有人名");
    // user 逐条列出真实资产名与持有人。
    expect(msgs[1].content).toContain("无限黑卡");
    expect(msgs[1].content).toContain("梦幻岛使用权");
    expect(msgs[1].content).toContain("林远");
    expect(msgs[1].content).toContain("老陈");
  });

  it("generate：ok + 结构落到 .story-engine-ui/asset-enrichment.json", async () => {
    const dir = await tempProject();
    const callModel = vi.fn(async () => JSON.stringify(VALID));
    const r = await generateAssetEnrichment({ projectDir: dir, assets: ASSETS, callModel });

    expect(r.ok).toBe(true);
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(r.summary).toContain("补全");
    const saved = JSON.parse(await readFile(join(dir, ".story-engine-ui", "asset-enrichment.json"), "utf-8"));
    expect(saved.assetVisibility["无限黑卡"]).toContain("林远");
    expect(saved.ownerDescriptions["林远"]).toContain("黑卡");
    expect(saved.continuityRisks).toHaveLength(2);
  });

  it("空资产 → ok:false，不调模型", async () => {
    const dir = await tempProject();
    const callModel = vi.fn(async () => JSON.stringify(VALID));
    const r = await generateAssetEnrichment({ projectDir: dir, assets: [], callModel });
    expect(r.ok).toBe(false);
    expect(callModel).not.toHaveBeenCalled();
  });

  it("parseAssetEnrichment：非 JSON / 缺字段 → 抛错（绝不放过半成品）", () => {
    expect(() => parseAssetEnrichment("这不是 JSON")).toThrow();
    // continuityRisks 条目缺必填 detail → 抛错。
    expect(() => parseAssetEnrichment(JSON.stringify({ continuityRisks: [{ label: "x" }] }))).toThrow();
  });

  it("parseAssetEnrichment：能从带前后文的文本里抠出 JSON，并对缺省字段补默认值", () => {
    const wrapped = "好的，结果如下：\n" + JSON.stringify(VALID) + "\n（以上）";
    expect(parseAssetEnrichment(wrapped).continuityRisks).toHaveLength(2);
    // 空对象 → 三个 default 字段补全，不抛错。
    const empty = parseAssetEnrichment("{}");
    expect(empty.assetVisibility).toEqual({});
    expect(empty.ownerDescriptions).toEqual({});
    expect(empty.continuityRisks).toEqual([]);
  });

  it("并入：assetVisibility 写进 assets 对应条目的 extraFields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ae-merge-"));
    await mkdir(join(dir, "story"), { recursive: true });
    await writeFile(join(dir, "story", "assets.json"), JSON.stringify({ assets: [{ id: "a1", name: "无限黑卡", type: "money" }], containers: [] }), "utf-8");
    const data = assetEnrichmentSchema.parse({ assetVisibility: { "无限黑卡": "主角随身、外人不知额度" } });
    await mergeAssetEnrichmentIntoEngine(dir, data);
    const led = JSON.parse(await readFile(join(dir, "story", "assets.json"), "utf-8"));
    const card = led.assets.find((a: any) => a.name === "无限黑卡");
    expect(card.extraFields["读者可见性"]).toContain("外人不知额度");
  });
});

describe("R2 停谎报：资产并入诚实回报", () => {
  it("写盘失败时 merge 返回 {merged:false, reason 含失败}", async () => {
    const dir = await tempProject();
    await mkdir(join(dir, "story", "assets.json"), { recursive: true });
    const r = await mergeAssetEnrichmentIntoEngine(dir, assetEnrichmentSchema.parse(VALID));
    expect(r.merged).toBe(false);
    expect(r.reason ?? "").toContain("失败");
  });

  it("无 assets.json 时 merge 返回 {merged:false} 但无 reason（正常跳过非失败）", async () => {
    const dir = await tempProject();
    const r = await mergeAssetEnrichmentIntoEngine(dir, assetEnrichmentSchema.parse(VALID));
    expect(r).toEqual({ merged: false });
  });

  it("generate 摘要不再宣称『引擎不变』、命中时如实提到进正文", async () => {
    const dir = await tempProject();
    await mkdir(join(dir, "story"), { recursive: true });
    await writeFile(join(dir, "story", "assets.json"),
      JSON.stringify({ version: "v0", assets: [{ id: "card", name: "无限黑卡" }] }), "utf-8");
    const callModel = vi.fn(async () => JSON.stringify(VALID));
    const r = await generateAssetEnrichment({ projectDir: dir, assets: ASSETS, callModel });
    expect(r.ok).toBe(true);
    expect(r.mergedIntoEngine).toBe(true);
    expect(r.summary).not.toContain("引擎不变");
    expect(r.summary).toContain("正文");
  });
});

describe("R2 件③：并入键 名字→id（资产改名仍命中）", () => {
  it("bible 条目改名后仍按 id 经 idMap 桥接命中并入（不漏并）", async () => {
    const dir = await tempProject();
    await mkdir(join(dir, "story"), { recursive: true });
    // bible：id=card 的资产 name 已被改成「无限钻石卡」
    await writeFile(join(dir, "story", "assets.json"),
      JSON.stringify({ version: "v0", assets: [{ id: "card", name: "无限钻石卡" }] }), "utf-8");
    // enrichment 仍以旧名「无限黑卡」为键，但带 idMap 把 card → 旧键名「无限黑卡」
    const data = assetEnrichmentSchema.parse({
      assetVisibility: { "无限黑卡": "仅林远知" },
      idMap: { card: "无限黑卡" },
    });
    const r = await mergeAssetEnrichmentIntoEngine(dir, data);
    expect(r.merged).toBe(true);
    const led = JSON.parse(await readFile(join(dir, "story", "assets.json"), "utf-8"));
    const card = led.assets.find((a: { readonly id: string }) => a.id === "card");
    expect(card.extraFields["读者可见性"]).toContain("仅林远知");
  });

  it("generate 会由 input 资产的 id↔name 构造 idMap 注入 enrichment", async () => {
    const dir = await tempProject();
    await mkdir(join(dir, "story"), { recursive: true });
    await writeFile(join(dir, "story", "assets.json"),
      JSON.stringify({ version: "v0", assets: [{ id: "card", name: "无限黑卡" }] }), "utf-8");
    const callModel = vi.fn(async () => JSON.stringify(VALID));
    const assets: readonly AssetEntityInput[] = [
      { id: "card", name: "无限黑卡", owner: "林远" },
    ];
    const r = await generateAssetEnrichment({ projectDir: dir, assets, callModel });
    expect(r.ok).toBe(true);
    expect(r.enrichment?.idMap).toEqual({ card: "无限黑卡" });
  });
});
