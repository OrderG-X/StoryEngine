// @vitest-environment node
//
// 双轨对拍（parity）：routes/chapter-steering.ts 的 POST /api/chapter-steering ↔ agent/tools/generate-chapter-steering.ts。
// 唯一一对【零 LLM】的对（引擎 buildChapterSteeringDraft 是确定性推导），无需任何模型 mock；
// 只读对拍，两侧共用同一项目目录。
//
// 已知刻意分歧（显式豁免清单；每条锁定现状并附代码证据）：
//   D26 输入获取面：HTTP 从 body 读 projectPath/userDirection 且 projectPath 必填 400；工具从 RequestContext
//       拿 projectDir、章号可回退 currentChapter（generate-chapter-steering.ts execute）。结构性分歧，只登记不测。
//   D27 输出面：HTTP 只回 { ok, draft }；工具多回用户可见 summary（generate-chapter-steering.ts buildChapterSteeringToolOutput）。
//   D28 缺方向：HTTP → 400「下一章方向不能为空。」（chapter-steering.ts）；工具 → ok:false + 诚实 summary
//       （generate-chapter-steering.ts 的 userDirection.trim() 守卫）。
import { describe, expect, it } from "vitest";

import { registerChapterSteeringRoutes } from "../routes/chapter-steering.js";
import { generateChapterSteeringTool } from "../agent/tools/generate-chapter-steering.js";
import { callRoute, driveToolExecute, makeParityProject } from "./parity-kit.js";

const USER_DIRECTION = "让主角拿到账册后发现里面有一页是空的。";

describe("parity: POST /api/chapter-steering ↔ generate_chapter_steering（共享行为面）", () => {
  it("happy path：同一项目同一方向 → 两侧 draft 深相等；工具多 summary（D27）", async () => {
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

  it("显式章号：两侧都按指定章出方案，draft 深相等", async () => {
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

  it("D28 缺方向：两侧都拒绝（HTTP 400；工具 ok:false + 诚实文案），都不出方案", async () => {
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
});
