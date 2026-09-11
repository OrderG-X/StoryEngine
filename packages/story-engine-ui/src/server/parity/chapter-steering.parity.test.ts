// @vitest-environment node
//
// 双轨对拍（parity）：routes/chapter-steering.ts 的 POST /api/chapter-steering ↔ agent/tools/generate-chapter-steering.ts。
// 唯一一对【零 LLM】的对（引擎 buildChapterSteeringDraft 是确定性推导），无需任何模型 mock；
// 只读对拍，两侧共用同一项目目录。
//
// 双轨合一后：编排已收进 services/steering-service.ts（runChapterSteering），route/tool 均为薄适配。
// 剩余已知刻意分歧（显式豁免清单；均为适配层差异，不再是编排漂移）：
//   D26 输入获取面：HTTP 从 body 读 projectPath/userDirection 且 projectPath 必填 400；工具从 RequestContext
//       拿 projectDir、章号可回退 currentChapter（generate-chapter-steering.ts execute）。结构性分歧，只登记不测。
//   D27 输出面：HTTP 只回 { ok, draft }；工具多回用户可见 summary（generate-chapter-steering.ts buildChapterSteeringToolOutput）。
//   D28 缺方向：判定已收敛进 service（runChapterSteering 统一返 missing_user_direction，两侧都不再出方案）；
//       剩余差异仅是适配层渲染——HTTP → 400「下一章方向不能为空。」（chapter-steering.ts），
//       工具 → ok:false + 诚实 summary（generate-chapter-steering.ts buildChapterSteeringToolOutput）。
//   D29 pacing/revealLevel/chapter 归一【已收敛 2026-09-11·SWE 归一差修复】：枚举 trim+小写+白名单
//       （"Fast"→fast）、章号数字字符串还原（"3"→3）收进 steering-service 单点，路由只做类型守卫透传——
//       原「工具 coerceEnum/coerceNumber 宽容还原 vs 路由 readPacing/readPositiveInteger 严格即丢」的
//       活分歧（pacing:"Fast" 工具→fast/路由→默认 medium）已消除，下方用例锁定。残余（只登记）：
//       枚举/章号的【非法值】口径仍不同——工具 schema 直接拒（input validation error），路由静默走
//       引擎默认；这是「模型面向 schema 严格 vs 表单面向容错」的适配层严格度差，非编排漂移。
//   D30 mustInclude/mustAvoid 字符串分隔符【仍是显式分歧·结构性，收不进 service】：字符串入参的切分
//       各在适配层——路由 readStringList 按 \n/;/； 拆、工具 coerceStringArray 按 ,/，/JSON 拆
//       （"a;b" 路由拆两条/工具不拆，"a,b" 方向互反）；数组入参两侧一致（引擎 normalizeList 统一
//       trim/去重/滤空）。收不动的原因：数组项可合法含逗号（模型可发真 JSON 数组），service 对数组项
//       二次切分会误伤合法要素。下方用例锁定现状，改动任一侧都会红。
//   D33 maxSuggestions 数字字符串【仍是显式分歧·结构性，只登记 2026-09-11】：工具 schema coerceNumber
//       把 maxSuggestions:"5" 还原成 5 生效；路由 readPositiveInteger 只认 number → 静默丢 → 引擎默认 6。
//       D29 收敛时 maxSuggestions 没进归一单点（路由侧仍严格类型守卫），与 quality 对 D31 / commit 对
//       D34 同根（lenient-args vs project-io 严格度差），收进 service 无意义（路由连 service 都到不了）。
//       下方用例锁定现状（种 3 hook + 2 thread 把自然建议数垫过 6，分歧才可见）。
//   磁盘 IO 重（真引擎建项目）：全部用例给显式 timeout（CLAUDE.md 纪律）。
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { registerChapterSteeringRoutes } from "../routes/chapter-steering.js";
import { generateChapterSteeringTool } from "../agent/tools/generate-chapter-steering.js";
import { callRoute, driveToolExecute, makeParityProject } from "./parity-kit.js";

const USER_DIRECTION = "让主角拿到账册后发现里面有一页是空的。";

/** 种 3 条活跃 hook + 2 条开放 thread：自然建议数垫到 7（3 hook + 2 thread + 1 主角 + 1 风险），maxSuggestions 夹逼才可见。 */
async function seedSteeringSuggestionSources(projectDir: string): Promise<void> {
  const hooks = ["账册里消失的一页", "老王的旧债", "茶水间的录音笔"].map((title, index) => ({
    id: `hook-seed-${index + 1}`,
    title,
    description: `${title}。`,
    status: "active",
    firstSeenChapter: 1,
    lastTouchedChapter: 1,
    evidence: [],
  }));
  const threads = ["查清账册来源", "盯住停车场夜班保安"].map((title, index) => ({
    id: `thread-seed-${index + 1}`,
    type: "lead",
    title,
    status: "open",
    firstSeenChapter: 1,
    lastTouchedChapter: 1,
    evidence: [],
  }));
  await writeFile(join(projectDir, "story", "hooks.json"), `${JSON.stringify({ hooks }, null, 2)}\n`, "utf-8");
  await writeFile(join(projectDir, "story", "threads.json"), `${JSON.stringify({ threads }, null, 2)}\n`, "utf-8");
}

describe("parity: POST /api/chapter-steering ↔ generate_chapter_steering（共享行为面）", () => {
  it("happy path：同一项目同一方向 → 两侧 draft 深相等；工具多 summary（D27）", { timeout: 30_000 }, async () => {
    const projectDir = await makeParityProject("steering-happy-");

    const route = await callRoute(registerChapterSteeringRoutes, "POST", "/api/chapter-steering", {
      projectPath: projectDir,
      userDirection: USER_DIRECTION,
    });
    const tool = await driveToolExecute(generateChapterSteeringTool, { userDirection: USER_DIRECTION }, { projectDir });

    expect(route.statusCode).toBe(200);
    expect(route.payload.ok).toBe(true);
    expect(tool.ok).toBe(true);
    // 同一确定性引擎 + 同一磁盘 → 方案逐字段深相等
    expect(tool.draft).toEqual(route.payload.draft);

    // D27：工具的 summary 是给用户/模型看的摘要；HTTP 无此字段
    const draft = tool.draft as { suggestions: readonly unknown[]; generatedChapterGoalPreview: string };
    expect(String(tool.summary)).toContain("剧情方案");
    expect(String(tool.summary)).toContain(`${draft.suggestions.length} 条剧情建议`);
    expect("summary" in route.payload).toBe(false);
  });

  it("显式章号：两侧都按指定章出方案，draft 深相等", { timeout: 30_000 }, async () => {
    const projectDir = await makeParityProject("steering-chapter-");

    const route = await callRoute(registerChapterSteeringRoutes, "POST", "/api/chapter-steering", {
      projectPath: projectDir,
      userDirection: USER_DIRECTION,
      chapter: 3,
    });
    const tool = await driveToolExecute(
      generateChapterSteeringTool,
      { userDirection: USER_DIRECTION, chapter: 3 },
      { projectDir },
    );

    expect(route.payload.ok).toBe(true);
    expect(tool.ok).toBe(true);
    expect(tool.draft).toEqual(route.payload.draft);
    expect((tool.draft as { chapter?: number }).chapter).toBe(3);
  });

  it("D28 缺方向：两侧都拒绝（HTTP 400；工具 ok:false + 诚实文案），都不出方案", { timeout: 30_000 }, async () => {
    const projectDir = await makeParityProject("steering-nodirection-");

    const route = await callRoute(registerChapterSteeringRoutes, "POST", "/api/chapter-steering", {
      projectPath: projectDir,
      userDirection: "",
    });
    const tool = await driveToolExecute(generateChapterSteeringTool, { userDirection: "" }, { projectDir });

    expect(route.statusCode).toBe(400);
    expect(route.payload.ok).toBe(false);
    expect(String(route.payload.error)).toContain("下一章方向不能为空");
    expect(route.payload.draft).toBeUndefined();

    expect(tool.ok).toBe(false);
    expect(String(tool.summary)).toContain("下一章方向不能为空");
    expect(tool.draft).toBeUndefined();
  });

  it("D29 已收敛·pacing 大小写变体：两侧同传 \"Fast\" → 都按 fast 出方案（draft 深相等），不再路由静默丢成默认 medium", { timeout: 30_000 }, async () => {
    const projectDir = await makeParityProject("steering-pacing-");

    const route = await callRoute(registerChapterSteeringRoutes, "POST", "/api/chapter-steering", {
      projectPath: projectDir,
      userDirection: USER_DIRECTION,
      pacing: "Fast",
    });
    const tool = await driveToolExecute(
      generateChapterSteeringTool,
      { userDirection: USER_DIRECTION, pacing: "Fast" },
      { projectDir },
    );

    expect(route.payload.ok).toBe(true);
    expect(tool.ok).toBe(true);
    // 收敛后两侧同一归一（service 单点 trim+小写+白名单）：draft 逐字段深相等、pacing 都是 fast
    expect(tool.draft).toEqual(route.payload.draft);
    expect((route.payload.draft as { pacing: string }).pacing).toBe("fast");
  });

  it("D29 已收敛·章号数字字符串：两侧同传 chapter:\"3\" → 都按第 3 章出方案（draft 深相等）", { timeout: 30_000 }, async () => {
    const projectDir = await makeParityProject("steering-chapter-str-");

    const route = await callRoute(registerChapterSteeringRoutes, "POST", "/api/chapter-steering", {
      projectPath: projectDir,
      userDirection: USER_DIRECTION,
      chapter: "3",
    });
    const tool = await driveToolExecute(
      generateChapterSteeringTool,
      { userDirection: USER_DIRECTION, chapter: "3" },
      { projectDir },
    );

    expect(route.payload.ok).toBe(true);
    expect(tool.ok).toBe(true);
    expect(tool.draft).toEqual(route.payload.draft);
    expect((tool.draft as { chapter?: number }).chapter).toBe(3);
  });

  it("D30 登记·mustInclude 字符串分隔符差（结构性豁免）：\"a;b\" 路由拆两条/工具不拆；\"a,b\" 方向互反——锁定现状", { timeout: 30_000 }, async () => {
    const projectDir = await makeParityProject("steering-include-");

    // 分号字符串：路由 readStringList 按 ; 拆成两条；工具 coerceStringArray 只按逗号/JSON 拆 → 原样一条
    const routeSemi = await callRoute(registerChapterSteeringRoutes, "POST", "/api/chapter-steering", {
      projectPath: projectDir,
      userDirection: USER_DIRECTION,
      mustInclude: "账册;旧钟",
    });
    const toolSemi = await driveToolExecute(
      generateChapterSteeringTool,
      { userDirection: USER_DIRECTION, mustInclude: "账册;旧钟" },
      { projectDir },
    );
    expect((routeSemi.payload.draft as { mustInclude: readonly string[] }).mustInclude).toEqual(["账册", "旧钟"]);
    expect((toolSemi.draft as { mustInclude: readonly string[] }).mustInclude).toEqual(["账册;旧钟"]);

    // 逗号字符串：方向互反（路由不拆、工具拆）
    const routeComma = await callRoute(registerChapterSteeringRoutes, "POST", "/api/chapter-steering", {
      projectPath: projectDir,
      userDirection: USER_DIRECTION,
      mustInclude: "账册,旧钟",
    });
    const toolComma = await driveToolExecute(
      generateChapterSteeringTool,
      { userDirection: USER_DIRECTION, mustInclude: "账册,旧钟" },
      { projectDir },
    );
    expect((routeComma.payload.draft as { mustInclude: readonly string[] }).mustInclude).toEqual(["账册,旧钟"]);
    expect((toolComma.draft as { mustInclude: readonly string[] }).mustInclude).toEqual(["账册", "旧钟"]);

    // 数组入参两侧一致（引擎 normalizeList 统一 trim/去重/滤空）——结构化入参本无分歧
    const routeArr = await callRoute(registerChapterSteeringRoutes, "POST", "/api/chapter-steering", {
      projectPath: projectDir,
      userDirection: USER_DIRECTION,
      mustInclude: ["账册", "旧钟"],
    });
    const toolArr = await driveToolExecute(
      generateChapterSteeringTool,
      { userDirection: USER_DIRECTION, mustInclude: ["账册", "旧钟"] },
      { projectDir },
    );
    expect((routeArr.payload.draft as { mustInclude: readonly string[] }).mustInclude).toEqual(["账册", "旧钟"]);
    expect((toolArr.draft as { mustInclude: readonly string[] }).mustInclude).toEqual(["账册", "旧钟"]);
  });

  it("D33 登记·maxSuggestions 数字字符串（lenient-args 分歧）：\"5\" 路由静默丢→引擎默认 6 条；工具还原成 5 → 5 条", { timeout: 30_000 }, async () => {
    const projectDir = await makeParityProject("steering-maxsuggestions-");
    await seedSteeringSuggestionSources(projectDir); // 自然建议数 7 > 默认 6 > 5，夹逼效果两侧可分辨

    const route = await callRoute(registerChapterSteeringRoutes, "POST", "/api/chapter-steering", {
      projectPath: projectDir,
      userDirection: USER_DIRECTION,
      maxSuggestions: "5",
    });
    const tool = await driveToolExecute(
      generateChapterSteeringTool,
      { userDirection: USER_DIRECTION, maxSuggestions: "5" },
      { projectDir },
    );

    expect(route.payload.ok).toBe(true);
    expect(tool.ok).toBe(true);
    // 路由：readPositiveInteger 只认 number，"5" 静默丢 → 引擎默认 6 → 6 条（自然 7 被默认上限裁到 6）
    expect((route.payload.draft as { suggestions: readonly unknown[] }).suggestions).toHaveLength(6);
    // 工具：coerceNumber 还原 "5"→5 → 真生效 → 5 条
    expect((tool.draft as { suggestions: readonly unknown[] }).suggestions).toHaveLength(5);
    // 对照组：同值 number 5 路由也认 → 两侧一致 5 条（分歧只在「字符串化入参」这一层，不在数值本身）
    const routeNumber = await callRoute(registerChapterSteeringRoutes, "POST", "/api/chapter-steering", {
      projectPath: projectDir,
      userDirection: USER_DIRECTION,
      maxSuggestions: 5,
    });
    expect((routeNumber.payload.draft as { suggestions: readonly unknown[] }).suggestions).toHaveLength(5);
  });
});
