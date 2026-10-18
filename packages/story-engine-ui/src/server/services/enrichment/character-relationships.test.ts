import { describe, expect, it } from "vitest";
import { parseCharacterRelationships, buildCharacterRelationshipsMessages } from "./character-relationships.js";

describe("character-relationships parse", () => {
  it("从含前后噪声的模型输出里抠出 JSON 并校验", () => {
    const raw = '好的：\n{"characters":[{"name":"林远","role":"主角"},{"name":"老赵","role":"债主"}],' +
      '"relationships":[{"from":"林远","to":"老赵","relationType":"债务","trust":"low"}]}\n以上。';
    const out = parseCharacterRelationships(raw);
    expect(out.characters.map((c) => c.name)).toEqual(["林远", "老赵"]);
    expect(out.relationships[0]).toMatchObject({ from: "林远", to: "老赵", relationType: "债务", trust: "low" });
  });
  it("非法 trust 值被 zod 拒绝", () => {
    expect(() => parseCharacterRelationships('{"characters":[],"relationships":[{"from":"a","to":"b","relationType":"x","trust":"超高"}]}')).toThrow();
  });
  it("提示词把 facts 与已有人名都带进 user 段", () => {
    const msgs = buildCharacterRelationshipsMessages(["林建国向赵某某借款三十七万。"], ["林远"]);
    const user = msgs.find((m) => m.role === "user")!.content;
    expect(user).toContain("林建国向赵某某借款三十七万");
    expect(user).toContain("林远");
  });
});
