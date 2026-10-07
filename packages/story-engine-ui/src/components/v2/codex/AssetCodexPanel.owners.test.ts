import { describe, expect, it } from "vitest";
import { buildAssetOwners, UNOWNED_ASSET_GROUP } from "./AssetCodexPanel.js";

const card = (name: string, owner: string) => ({
  name, type: "", owner, location: "", carried: false, status: "可用", usageRules: [], lossRules: [], notes: [], critical: false,
});

describe("道具按持有人分组", () => {
  it("没写持有人的单独成组排最后；「主角」显示成主角真名并排最前", () => {
    const owners = buildAssetOwners([card("旧书", ""), card("钥匙", "主角"), card("怀表", "老周"), card("伞", "老周")], undefined, "韩溪");
    expect(owners.map((o) => o.name)).toEqual(["韩溪", "老周", UNOWNED_ASSET_GROUP]);
  });

  it("不知道主角名时仍叫「主角」", () => {
    expect(buildAssetOwners([card("钥匙", "protagonist")]).map((o) => o.name)).toEqual(["主角"]);
  });
});
