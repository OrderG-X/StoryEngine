import { describe, expect, it } from "vitest";
import {
  SELECTION_REVISION_TEMPLATES,
  VISIBLE_SELECTION_REVISION_TEMPLATES,
  selectionEditGoal,
  type SelectionRevisionKey,
} from "./selectionRevisionTemplates.js";

describe("selection revision templates", () => {
  it("exposes exactly the six spec'd buttons with non-empty goals", () => {
    const keys = VISIBLE_SELECTION_REVISION_TEMPLATES.map((item) => item.key);
    expect(keys).toEqual(["polish", "rewrite", "deai", "expand", "condense", "continue"]);
    for (const template of SELECTION_REVISION_TEMPLATES) {
      expect(template.label.length).toBeGreaterThan(0);
      expect(template.revisionGoal.length).toBeGreaterThan(20);
    }
  });

  it("labels match the spec's floating-toolbar buttons", () => {
    const labels = VISIBLE_SELECTION_REVISION_TEMPLATES.map((item) => item.label);
    expect(labels).toEqual(["润色", "改写", "去机器腔", "扩写", "缩写", "续写"]);
  });

  it("custom「自己说」存在、标 hidden、不进可见预设；extraGoal 拼进改写目标", () => {
    expect(SELECTION_REVISION_TEMPLATES.some((t) => t.key === "custom")).toBe(true);
    expect(VISIBLE_SELECTION_REVISION_TEMPLATES.some((t) => t.key === "custom")).toBe(false);
    const goal = selectionEditGoal("custom", "写紧张点，删掉心理描写");
    expect(goal).toContain("按用户提出的具体要求改写");
    expect(goal).toContain("针对本句的具体方向：写紧张点，删掉心理描写");
  });

  it("去AI味 carries de-AI-specific craft guidance (the旗舰 template, specially tuned)", () => {
    const deai = SELECTION_REVISION_TEMPLATES.find((item) => item.key === "deai");
    expect(deai?.revisionGoal).toContain("AI 腔");
    expect(deai?.revisionGoal).toContain("具体的动作");
  });

  it("templates stay genre-neutral — no 修仙/末世 proper nouns leak in", () => {
    for (const template of SELECTION_REVISION_TEMPLATES) {
      expect(template.revisionGoal).not.toMatch(/金丹|筑基|元婴|修仙|丧尸|末世|林远/u);
    }
  });

  it("extraGoal 拼在模板目标后面（AI 味卡给这句的方向），原模板目标仍在；空白不改", () => {
    const goal = selectionEditGoal("deai", "改成具体动作");
    expect(goal).toContain("改成具体动作");
    expect(goal).toContain("AI 腔");
    expect(selectionEditGoal("deai", "   ")).toBe(selectionEditGoal("deai"));
  });

  it("模板键不对是 null（调用方不交）", () => {
    expect(selectionEditGoal("nope" as SelectionRevisionKey)).toBeNull();
  });
});
