import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  locationEnrichmentSchema,
  buildLocationEnrichmentMessages,
  generateLocationEnrichment,
  mergeLocationEnrichmentIntoEngine,
  parseLocationEnrichment,
  type LocationEntityInput,
} from "./location-enrichment.js";

// 用 zod 输入类型：default 字段（byLocation）输入侧可省。
const VALID: z.input<typeof locationEnrichmentSchema> = {
  byLocation: {
    "星耀会所": {
      surfaceImpression: "外人眼里是顶级私人会所，金碧辉煌、门禁森严",
      entryRestriction: "凭老陈的引荐函 + 黑卡才能进，前台老周认人不认证",
      exitCost: "离开后行踪会被会所安保记录，老陈会知道你来过",
      associatedForces: "星耀会理事会暗中实控，安保由理事会直属",
      statusTag: "高危 · 监控中",
      statusTone: "danger",
    },
    "城中村出租屋": {
      surfaceImpression: "破败的握手楼，电线乱搭、楼道阴暗",
      statusTag: "安全屋",
      statusTone: "neutral",
    },
  },
};

const LOCATIONS: readonly LocationEntityInput[] = [
  { name: "星耀会所", type: "私人会所", narrativeFunction: "上流社会试炼场", risks: ["身份被拆穿", "监控"], status: "监控中" },
  { name: "城中村出租屋", type: "住所", narrativeFunction: "主角退守的根据地" },
];

afterEach(() => vi.restoreAllMocks());

async function tempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "le-test-"));
}

describe("location-enrichment 生成与落盘", () => {
  it("buildLocationEnrichmentMessages：含禁编造/按真实键/进入限制/离开代价等约束，user 带真实地点名", () => {
    const msgs = buildLocationEnrichmentMessages(LOCATIONS);
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("禁编造");
    expect(msgs[0].content).toContain("进入限制");
    expect(msgs[0].content).toContain("离开代价");
    expect(msgs[0].content).toContain("warn / danger / neutral");
    // 键必须取自给定地点名的硬约束。
    expect(msgs[0].content).toContain("键必须逐字取自下方给定的地点名");
    // user 逐条列出真实地点名与已有设定。
    expect(msgs[1].content).toContain("星耀会所");
    expect(msgs[1].content).toContain("城中村出租屋");
    expect(msgs[1].content).toContain("上流社会试炼场");
    expect(msgs[1].content).toContain("身份被拆穿");
  });

  it("generate：ok + 结构落到 .story-engine-ui/location-enrichment.json", async () => {
    const dir = await tempProject();
    const callModel = vi.fn(async () => JSON.stringify(VALID));
    const r = await generateLocationEnrichment({ projectDir: dir, locations: LOCATIONS, callModel });

    expect(r.ok).toBe(true);
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(r.summary).toContain("补全");
    const saved = JSON.parse(await readFile(join(dir, ".story-engine-ui", "location-enrichment.json"), "utf-8"));
    expect(saved.byLocation["星耀会所"].entryRestriction).toContain("黑卡");
    expect(saved.byLocation["星耀会所"].statusTone).toBe("danger");
    expect(saved.byLocation["城中村出租屋"].statusTag).toBe("安全屋");
  });

  it("空地点 → ok:false，不调模型", async () => {
    const dir = await tempProject();
    const callModel = vi.fn(async () => JSON.stringify(VALID));
    const r = await generateLocationEnrichment({ projectDir: dir, locations: [], callModel });
    expect(r.ok).toBe(false);
    expect(callModel).not.toHaveBeenCalled();
  });

  it("parseLocationEnrichment：非 JSON / 非法 statusTone → 抛错（绝不放过半成品）", () => {
    expect(() => parseLocationEnrichment("这不是 JSON")).toThrow();
    // statusTone 取了 enum 外的值 → 抛错。
    expect(() =>
      parseLocationEnrichment(JSON.stringify({ byLocation: { 甲: { statusTone: "红色" } } })),
    ).toThrow();
  });

  it("parseLocationEnrichment：能从带前后文的文本里抠出 JSON，并对缺省字段补默认值", () => {
    const wrapped = "好的，结果如下：\n" + JSON.stringify(VALID) + "\n（以上）";
    expect(Object.keys(parseLocationEnrichment(wrapped).byLocation)).toHaveLength(2);
    // 空对象 → byLocation default 补全，不抛错。
    const empty = parseLocationEnrichment("{}");
    expect(empty.byLocation).toEqual({});
  });

  it("并入：byLocation 厚字段写进 location-bible 对应条目的 extraFields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "le-merge-"));
    await mkdir(join(dir, "story"), { recursive: true });
    await writeFile(join(dir, "story", "location-bible.json"), JSON.stringify({ version: "v0", locations: [{ id: "loc1", name: "云顶会所", type: "场所" }] }), "utf-8");
    const data = locationEnrichmentSchema.parse({ byLocation: { "云顶会所": { surfaceImpression: "金碧辉煌", entryRestriction: "会员制", associatedForces: "李氏集团" } } });
    await mergeLocationEnrichmentIntoEngine(dir, data);
    const lb = JSON.parse(await readFile(join(dir, "story", "location-bible.json"), "utf-8"));
    const loc = lb.locations.find((l: any) => l.name === "云顶会所");
    expect(loc.extraFields["外观印象"]).toContain("金碧辉煌");
    expect(loc.extraFields["进入限制"]).toContain("会员制");
    expect(loc.extraFields["关联势力"]).toContain("李氏集团");
  });

  it("R2 件③：bible 条目改名后仍按 id 命中并入（不漏并）", async () => {
    const dir = await tempProject();
    await mkdir(join(dir, "story"), { recursive: true });
    // bible：id=loc1 的地点 name 已被改成「星耀新会所」
    await writeFile(join(dir, "story", "location-bible.json"),
      JSON.stringify({ version: "v0", locations: [{ id: "loc1", name: "星耀新会所" }] }), "utf-8");
    // enrichment 仍以旧名「星耀会所」为键，但带 idMap 把 loc1 → 旧键名「星耀会所」
    const data = locationEnrichmentSchema.parse({
      byLocation: { "星耀会所": { surfaceImpression: "外人眼里是顶级私人会所，金碧辉煌、门禁森严" } },
      idMap: { loc1: "星耀会所" },
    });
    const r = await mergeLocationEnrichmentIntoEngine(dir, data);
    expect(r.merged).toBe(true);
    const lb = JSON.parse(await readFile(join(dir, "story", "location-bible.json"), "utf-8"));
    const loc = lb.locations.find((l: { readonly id: string }) => l.id === "loc1");
    expect(loc.extraFields["外观印象"]).toContain("金碧辉煌");
  });
});

describe("R2 停谎报：地点并入诚实回报", () => {
  it("写盘失败时 merge 返回 {merged:false, reason 含失败}", async () => {
    const dir = await tempProject();
    await mkdir(join(dir, "story", "location-bible.json"), { recursive: true });
    const r = await mergeLocationEnrichmentIntoEngine(dir, locationEnrichmentSchema.parse(VALID));
    expect(r.merged).toBe(false);
    expect(r.reason ?? "").toContain("失败");
  });

  it("无 location-bible.json 时 merge 返回 {merged:false} 但无 reason（正常跳过非失败）", async () => {
    const dir = await tempProject();
    const r = await mergeLocationEnrichmentIntoEngine(dir, locationEnrichmentSchema.parse(VALID));
    expect(r).toEqual({ merged: false });
  });

  it("generate 摘要不再宣称『引擎不变』、命中时如实提到进正文且 mergedIntoEngine", async () => {
    const dir = await tempProject();
    await mkdir(join(dir, "story"), { recursive: true });
    await writeFile(join(dir, "story", "location-bible.json"),
      JSON.stringify({ version: "v0", locations: [{ id: "loc1", name: "星耀会所" }] }), "utf-8");
    const callModel = vi.fn(async () => JSON.stringify(VALID));
    const r = await generateLocationEnrichment({ projectDir: dir, locations: LOCATIONS, callModel });
    expect(r.ok).toBe(true);
    expect(r.mergedIntoEngine).toBe(true);
    expect(r.summary).not.toContain("引擎不变");
    expect(r.summary).toContain("正文");
  });
});
