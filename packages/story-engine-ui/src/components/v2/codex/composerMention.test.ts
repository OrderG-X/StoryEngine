import { describe, expect, it } from "vitest";
import { activeMentionQuery, buildMentionCandidates, insertMention } from "./composerMention.js";

describe("改版 @ 引用", () => {
  it("activeMentionQuery：只认末尾正在打的 @，邮箱式的不算", () => {
    expect(activeMentionQuery("让 @")).toBe("");
    expect(activeMentionQuery("让 @周")).toBe("周");
    expect(activeMentionQuery("@沈栀")).toBe("沈栀");
    expect(activeMentionQuery("a@b")).toBeNull();
    expect(activeMentionQuery("让 @周屿 去")).toBeNull();
  });

  it("insertMention：替换末尾的 @查询词并补空格", () => {
    expect(insertMention("第 59 章让 @周", "周屿")).toBe("第 59 章让 @周屿 ");
  });

  it("候选：角色、地点、最近章节，按查询过滤并去重", () => {
    const chapters = [
      { id: "a", chapterNumber: 57, title: "西侧二层", status: "committed" as const },
      { id: "b", chapterNumber: 58, title: "第58章 · 西侧二层", status: "committed" as const },
      { id: "c", chapterNumber: 59, title: "下一章", status: "planned" as const },
    ];
    const all = buildMentionCandidates({ query: "", characters: ["周屿", "沈栀", "周屿"], locations: ["梧桐街九号"], chapters });
    expect(all.map((c) => `${c.kind}:${c.label}`)).toEqual(["角色:周屿", "角色:沈栀", "地点:梧桐街九号", "章节:第58章·西侧二层", "章节:第57章·西侧二层"]);
    expect(buildMentionCandidates({ query: "周", characters: ["周屿", "沈栀"], locations: [], chapters }).map((c) => c.label)).toEqual(["周屿"]);
  });
});
