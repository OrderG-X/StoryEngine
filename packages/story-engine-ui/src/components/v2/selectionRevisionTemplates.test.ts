import { describe, expect, it } from "vitest";
import {
  SELECTION_REVISION_TEMPLATES,
  VISIBLE_SELECTION_REVISION_TEMPLATES,
  buildSelectionRevisionTask,
  isNoOpRevisionPreview,
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
    const task = buildSelectionRevisionTask({
      selectionText: "他坐在沙发上。",
      key: "custom",
      chapter: 3,
      extraGoal: "写紧张点，删掉心理描写",
    });
    expect(task?.revisionGoal).toContain("按用户提出的具体要求改写");
    expect(task?.revisionGoal).toContain("针对本句的具体方向：写紧张点，删掉心理描写");
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

  it("builds a DraftRevisionTask carrying the selection as targetText and the template goal", () => {
    const task = buildSelectionRevisionTask({ selectionText: "他推开门，雪灌进来。", key: "deai", chapter: 3 });
    expect(task).not.toBeNull();
    expect(task?.targetText).toBe("他推开门，雪灌进来。");
    expect(task?.chapter).toBe(3);
    expect(task?.targetType).toBe("section");
    expect(task?.status).toBe("pending");
    expect(task?.revisionGoal).toContain("AI 腔");
  });

  it("extraGoal 拼进 revisionGoal（体检「改掉这句」把 suggestedFix 喂进改写目标），原模板目标仍在", () => {
    const task = buildSelectionRevisionTask({ selectionText: "心中五味杂陈。", key: "deai", chapter: 1, extraGoal: "改成具体动作" });
    expect(task).not.toBeNull();
    expect(task?.revisionGoal).toContain("改成具体动作");
    expect(task?.revisionGoal).toContain("AI 腔"); // 原 deai 模板目标没被替换掉
    expect(task?.targetText).toBe("心中五味杂陈。");
  });

  it("extraGoal 为空/纯空白时不改动原模板目标", () => {
    const base = buildSelectionRevisionTask({ selectionText: "心中五味杂陈。", key: "deai", chapter: 1 });
    const blank = buildSelectionRevisionTask({ selectionText: "心中五味杂陈。", key: "deai", chapter: 1, extraGoal: "   " });
    expect(blank?.revisionGoal).toBe(base?.revisionGoal);
  });

  it("returns null for an empty selection or an unknown key (caller must not fire a request)", () => {
    expect(buildSelectionRevisionTask({ selectionText: "   ", key: "polish", chapter: 1 })).toBeNull();
    expect(buildSelectionRevisionTask({ selectionText: "有内容", key: "nope" as SelectionRevisionKey, chapter: 1 })).toBeNull();
  });

  it("flags a no-op preview (model-failure fallback returns afterText===beforeText) so the caller reports failure not success", () => {
    // 治真机 A.5：模型失败时 revision/preview 返回 200 + afterText===beforeText 的安全兜底。
    // 调用方必须据此跳过 apply、诚实报失败，而不是把 no-op 当成功 apply。
    expect(isNoOpRevisionPreview({ beforeText: "原文一段。", afterText: "原文一段。" })).toBe(true);
    expect(isNoOpRevisionPreview({ beforeText: "  原文一段。 ", afterText: "原文一段。" })).toBe(true);
    expect(isNoOpRevisionPreview({ beforeText: "原文一段。", afterText: "改写后的一段。" })).toBe(false);
  });
});
