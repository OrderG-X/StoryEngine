// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { CharacterState, CharacterCore, CharacterProfile, LocationBibleEntry, AssetItem, WorldState } from "./types.js";

describe("extraFields on foundation cards", () => {
  it("allows arbitrary extra fields on character state", () => {
    const state: CharacterState = {
      characterId: "lin-wan",
      emotion: "平静",
      goal: "回家",
      extraFields: { 境界: "金丹期", 功法: ["奔雷诀", "云隐步"] },
    };
    expect(state.extraFields?.["境界"]).toBe("金丹期");
    expect(state.extraFields?.["功法"]).toEqual(["奔雷诀", "云隐步"]);
  });

  it("declares extraFields on core/profile/location/asset/world card types", () => {
    // Pick 只验证类型上存在 extraFields，无需构造完整对象。
    const core: Pick<CharacterCore, "extraFields"> = { extraFields: { 功法流派: "雷宗" } };
    const profile: Pick<CharacterProfile, "extraFields"> = { extraFields: { 体质: "先天道体" } };
    const location: Pick<LocationBibleEntry, "extraFields"> = { extraFields: { 灵气浓度: "稀薄" } };
    const asset: Pick<AssetItem, "extraFields"> = { extraFields: { 品阶: "凡品" } };
    const world: Pick<WorldState, "extraFields"> = { extraFields: { 大劫倒计时: "三百年" } };
    expect(core.extraFields?.["功法流派"]).toBe("雷宗");
    expect(profile.extraFields?.["体质"]).toBe("先天道体");
    expect(location.extraFields?.["灵气浓度"]).toBe("稀薄");
    expect(asset.extraFields?.["品阶"]).toBe("凡品");
    expect(world.extraFields?.["大劫倒计时"]).toBe("三百年");
  });
});
