import { describe, expect, it } from "vitest";
import { matrixPanelCopy } from "./matrixPanelCopy.js";

describe("matrixPanelCopy", () => {
  it("单角色 → 角色近况 + 提示", () => {
    expect(matrixPanelCopy(1)).toEqual({
      kicker: "角色近况",
      titleLead: "角色",
      titleEm: "近况",
      sectionTitle: "角色近况",
      hint: "有第二个角色后显示角色关系",
    });
    expect(matrixPanelCopy(0).kicker).toBe("角色近况");
  });

  it("多角色 → 角色关系", () => {
    expect(matrixPanelCopy(2).kicker).toBe("角色关系");
    expect(matrixPanelCopy(2).hint).toBeNull();
    expect(matrixPanelCopy(2).sectionTitle).toBe("角色关系");
  });
});
