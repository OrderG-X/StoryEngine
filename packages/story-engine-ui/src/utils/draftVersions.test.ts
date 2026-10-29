import { describe, expect, it } from "vitest";
import { readDraftVersions } from "./draftVersions.js";

const SHA = "d".repeat(64);
const v = (index: number, body: string, extra: Record<string, unknown> = {}) => ({ index, candidateId: `0038-op-${index}`, sha: SHA, body, ...extra });

describe("另外几版：工具输出 / 存盘数据解析", () => {
  it("工具输出（otherVersions）和存盘（versions）读成同一张卡；坏条目丢掉，最多 3 版", () => {
    expect(readDraftVersions({ chapter: 38, otherVersions: [v(1, " 甲版。 ", { title: " 第38章 · 雨夜 " })] }))
      .toEqual({ chapter: 38, versions: [{ ...v(1, "甲版。"), title: "第38章 · 雨夜" }] });
    expect(readDraftVersions({ chapter: 38, versions: [v(2, "乙版。"), v(0, "x"), v(3, "  "), "坏"] }))
      .toEqual({ chapter: 38, versions: [v(2, "乙版。")] });
    const many = Array.from({ length: 5 }, (_, i) => v(i + 1, `第${i + 1}版`));
    expect(readDraftVersions({ chapter: 1, versions: many })?.versions).toHaveLength(3);
  });

  it("作者要自己挑的（pick）跟着读回；没候选号、指纹不对、处理过了的不收（换不上了）", () => {
    expect(readDraftVersions({ chapter: 5, pick: true, versions: [v(1, "甲。")] })).toEqual({ chapter: 5, pick: true, versions: [v(1, "甲。")] });
    expect(readDraftVersions({ chapter: 5, versions: [{ index: 1, body: "老卡没候选号。" }] })).toBeUndefined();
    expect(readDraftVersions({ chapter: 5, versions: [v(1, "甲。", { sha: "不对" }), v(2, "乙。", { candidateId: "坏号" })] })).toBeUndefined();
    expect(readDraftVersions({ chapter: 5, versions: [{ index: 1, candidateId: "0005-op-1", handled: true }, v(2, "乙。")] }))
      .toEqual({ chapter: 5, versions: [v(2, "乙。")] });
  });

  it("没章号、没一版能用、超长的坏数据：不建卡", () => {
    expect(readDraftVersions({ otherVersions: [v(1, "甲")] })).toBeUndefined();
    expect(readDraftVersions({ chapter: 2, otherVersions: [] })).toBeUndefined();
    expect(readDraftVersions({ chapter: 2, otherVersions: [v(1, "长".repeat(60_001))] })).toBeUndefined();
    expect(readDraftVersions(null)).toBeUndefined();
  });
});
