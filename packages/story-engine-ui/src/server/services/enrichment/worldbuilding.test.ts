import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildWorldbuildingMessages,
  generateWorldbuilding,
  parseWorldbuilding,
  persistWorldbuilding,
  worldbuildingSchema,
} from "./worldbuilding.js";

// 厚版字段(worldRules/factions/specialElements/storyBinding 等)在输入侧可省，由宽容 schema 归一补全——
// 这条 fixture 正好验证「旧格式世界观数据向后兼容」（缺新字段不崩、不报错）。
const VALID = {
  overview: { oneLine: "普通青年靠无限黑卡闯入财富特权世界", tone: "都市、爽、暗流", coreConflict: "金钱特权与自我认知的撕扯" },
  socialStructure: ["38 个家族控制六成财富", "中产负债维持光鲜", "青年失业率高、上升通道收窄"],
  rules: [
    { name: "黑卡特权", detail: "全球顶级场所免费，但每笔消费留痕、被暗影追踪" },
    { name: "债务任务", detail: "连续满额消费解锁更高层机会，违约触发猎犬计划" },
    { name: "信用监控", detail: "异常消费进入社会信用评分，影响后续商业活动" },
    { name: "圈层门槛", detail: "星耀会入会门槛流动资产 10 亿" },
  ],
  forces: [
    { name: "暗影集团", type: "神秘监管机构", resources: "全球监控+黑客+情报网", objective: "监控黑卡使用者", pressure: "无处不在的监视" },
    { name: "星耀会", type: "财富俱乐部", resources: "127 名顶级会员人脉", objective: "维护圈层秩序", pressure: "新人试炼" },
    { name: "天启资本", type: "风投机构", resources: "控制 60% 热门赛道", objective: "锁定独角兽", pressure: "挖角与价格战" },
    { name: "郭家亲族", type: "家庭利益共同体", resources: "亲情绑定", objective: "分享林远财富", pressure: "道德绑架" },
  ],
  locations: [
    { name: "星耀大厦", type: "地标", function: "星耀会总部、权力交易场", risk: "进出留痕" },
    { name: "幸福里", type: "城中村", function: "林远起点，对照阶层", risk: "月光陷阱" },
    { name: "云端俱乐部", type: "私人会所", function: "黑金卡专属社交", risk: "信息泄露" },
    { name: "梦幻岛", type: "私人岛屿", function: "林远社交主场", risk: "临时使用权" },
  ],
  relations: [
    { from: "暗影集团", to: "星耀会", relation: "暗中监控其会员" },
    { from: "天启资本", to: "星耀会", relation: "利益渗透" },
    { from: "郭家亲族", to: "暗影集团", relation: "被牵连监视" },
  ],
  conflictSources: ["黑卡来历的秘密", "圈层对黑马的排挤", "金钱与底线的拉扯"],
  storyEntries: [
    { title: "黑卡初现", hook: "收到八位数到账短信，在高端餐厅试用被误认富豪" },
    { title: "圈层试炼", hook: "被星耀会邀请，必须通过新人试炼" },
    { title: "暗影浮现", hook: "察觉被监视，黑卡债务任务逼近" },
  ],
};

afterEach(() => vi.restoreAllMocks());

async function tempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "wb-test-"));
}

describe("worldbuilding 生成与落盘", () => {
  it("buildWorldbuildingMessages：含禁空话/题材感知/数量约束等硬规则，user 带种子", () => {
    const msgs = buildWorldbuildingMessages({ genre: "都市异能", premise: "平凡上班族获得改写命运的能力", title: "命运改写局" });
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("禁空话");
    expect(msgs[0].content).toContain("题材感知");
    expect(msgs[1].content).toContain("平凡上班族获得改写命运的能力");
    expect(msgs[1].content).toContain("命运改写局");
  });

  it("generate：ok + 完整结构落到 .story-engine-ui/worldbuilding.json", async () => {
    const dir = await tempProject();
    const callModel = vi.fn(async () => JSON.stringify(VALID));
    const r = await generateWorldbuilding({ projectDir: dir, seed: { genre: "都市后宫", premise: "现实世界黑卡后宫" }, callModel });

    expect(r.ok).toBe(true);
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(r.summary).toContain("势力");
    const saved = JSON.parse(await readFile(join(dir, ".story-engine-ui", "worldbuilding.json"), "utf-8"));
    expect(saved.forces).toHaveLength(4);
    expect(saved.overview.oneLine).toContain("黑卡");
  });

  it("generate：头部要点并入 world-bible（合并去重，保留既有）", async () => {
    const dir = await tempProject();
    // 预置一条已有规则，验证合并不覆盖
    await mkdir(join(dir, "story"), { recursive: true });
    await writeFile(join(dir, "story", "world-bible.json"), JSON.stringify({ rules: ["正式事实只能通过确认提交更新。"], factions: [] }), "utf-8");

    await generateWorldbuilding({ projectDir: dir, seed: { genre: "都市后宫", premise: "现实世界黑卡后宫" }, callModel: async () => JSON.stringify(VALID) });

    const bible = JSON.parse(await readFile(join(dir, "story", "world-bible.json"), "utf-8"));
    expect(bible.rules).toContain("正式事实只能通过确认提交更新。"); // 既有保留
    expect(bible.rules.some((r: string) => r.startsWith("黑卡特权："))).toBe(true); // 新增并入
    expect(bible.factions.some((f: any) => f && typeof f === "object" && f.name === "暗影集团")).toBe(true);
    expect(bible.socialOrder).toContain("38 个家族控制六成财富");
    expect(bible.conflictSources).toContain("黑卡来历的秘密");
  });

  it("并入成功 → mergedIntoEngine:true + summary 说『接进正文』（R2 诚实二态）", async () => {
    const dir = await tempProject();
    const r = await generateWorldbuilding({ projectDir: dir, seed: { genre: "都市", premise: "黑卡" }, callModel: async () => JSON.stringify(VALID) });
    expect(r.ok).toBe(true);
    expect(r.mergedIntoEngine).toBe(true);
    expect(r.summary).toContain("接进正文");
    expect(r.summary).not.toContain("未能接进正文");
  });

  it("并入失败（story 被占成文件）→ ok 仍 true + 展示层落盘，但 mergedIntoEngine:false + summary 诚实说『未能接进正文』，绝不谎报", async () => {
    const dir = await tempProject();
    // 把 story 占成文件 → world-bible 并入时 mkdir/写盘必抛 → 触发 merged:false 分支
    await writeFile(join(dir, "story"), "占位文件，不是目录", "utf-8");
    const r = await generateWorldbuilding({ projectDir: dir, seed: { genre: "都市", premise: "黑卡" }, callModel: async () => JSON.stringify(VALID) });
    expect(r.ok).toBe(true); // 展示层已落盘，用户东西没丢
    expect(r.mergedIntoEngine).toBe(false);
    expect(r.summary).toContain("未能接进正文");
    // 展示层文件确实写成功了（与「没接进正文」不矛盾）
    const saved = JSON.parse(await readFile(join(dir, ".story-engine-ui", "worldbuilding.json"), "utf-8"));
    expect(saved.forces).toHaveLength(4);
  });

  it("缺种子 → ok:false，不调模型", async () => {
    const dir = await tempProject();
    const callModel = vi.fn(async () => JSON.stringify(VALID));
    const r = await generateWorldbuilding({ projectDir: dir, seed: { genre: "都市", premise: "   " }, callModel });
    expect(r.ok).toBe(false);
    expect(callModel).not.toHaveBeenCalled();
  });

  it("parseWorldbuilding：非 JSON / 实质全空 → 抛错（仍不接受垃圾半成品，回退手写）", () => {
    expect(() => parseWorldbuilding("这不是 JSON")).toThrow();
    expect(() => parseWorldbuilding(JSON.stringify({ overview: { oneLine: "x" } }))).toThrow();
  });

  // 模型无关（E2E 实锤）：实质内容齐全、只是模型漏个别嵌套字段 / 多塞字段 / 夹空串 → 绝不整份抛错丢失，
  // 缺的归一为默认、多塞的剥掉、空串滤掉。旧 nonEmpty+strict 让模型漏 forces[].pressure 时整份世界观丢失。
  it("parseWorldbuilding：内容齐全但漏嵌套字段/多塞字段/夹空串 → 不抛错，归一为 canonical", () => {
    const degraded = {
      overview: { oneLine: "一句话", tone: "基调", coreConflict: "冲突", extraJunk: "凭空多塞" },
      socialStructure: ["顶层：世家", "", "   "],
      rules: [{ name: "法则", detail: "细节" }],
      forces: [
        { name: "李氏", type: "世家", resources: "田产人脉", objective: "扩张", mood: "随手多塞字段" },
        { name: "王氏", type: "门阀", resources: "兵权", objective: "自保", pressure: "联姻施压" },
      ],
      locations: [{ name: "中枢省", function: "权力中心" }],
      conflictSources: ["新旧世家之争"],
    };
    const wb = parseWorldbuilding(JSON.stringify(degraded));
    expect(wb.forces).toHaveLength(2);
    expect(wb.forces[0].name).toBe("李氏");
    expect(wb.forces[0].pressure).toBe(""); // 漏的字段归一为 ""
    expect((wb.forces[0] as Record<string, unknown>).mood).toBeUndefined(); // 多塞字段剥掉
    expect(wb.socialStructure).toEqual(["顶层：世家"]); // 空串/纯空白滤掉
    expect((wb.overview as Record<string, unknown>).extraJunk).toBeUndefined();
  });

  it("parseWorldbuilding：能从带前后文的文本里抠出 JSON", () => {
    const wrapped = "好的，这是结果：\n" + JSON.stringify(VALID) + "\n（以上）";
    expect(parseWorldbuilding(wrapped).forces).toHaveLength(4);
  });

  it("persist：势力以富对象并入 world-bible（name+goal+resources，非裸字符串），含 objective/pressure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wb-faction-"));
    const wb = worldbuildingSchema.parse({
      overview: { oneLine: "x", tone: "x", coreConflict: "x" },
      socialStructure: ["顶层：资本"],
      rules: [{ name: "法则", detail: "细节" }],
      forces: [{ name: "李氏集团", type: "公司", resources: "资本与人脉", objective: "垄断市场", pressure: "经济威胁", hiddenObjective: "吞并对手" }],
      locations: [{ name: "总部", function: "权力中心" }],
      conflictSources: ["资本博弈"],
    });
    await persistWorldbuilding(dir, wb);
    const bible = JSON.parse(await readFile(join(dir, "story", "world-bible.json"), "utf-8"));
    const li = bible.factions.find((f: any) => f && typeof f === "object" && f.name === "李氏集团");
    expect(li).toBeTruthy();
    expect(li.goal).toContain("垄断市场");
    expect(li.goal).toContain("经济威胁");
    expect(Array.isArray(li.resources)).toBe(true);
    expect(li.id).toBeTruthy();
  });
});
