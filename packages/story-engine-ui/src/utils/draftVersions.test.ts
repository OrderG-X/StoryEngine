import { describe, expect, it } from "vitest";
import { readDraftVersions } from "./draftVersions.js";

describe("另外几版：工具输出 / 存盘数据解析", () => {
  it("工具输出（otherVersions）和存盘（versions）读成同一张卡；坏条目丢掉，最多 3 版", () => {
    expect(readDraftVersions({ chapter: 38, otherVersions: [{ index: 1, body: " 甲版。 " }] })).toEqual({ chapter: 38, versions: [{ index: 1, body: "甲版。" }] });
    expect(readDraftVersions({ chapter: 38, versions: [{ index: 2, body: "乙版。" }, { index: 0, body: "x" }, { index: 3, body: "  " }, "坏"] }))
      .toEqual({ chapter: 38, versions: [{ index: 2, body: "乙版。" }] });
    const many = Array.from({ length: 5 }, (_, i) => ({ index: i + 1, body: `第${i + 1}版` }));
    expect(readDraftVersions({ chapter: 1, versions: many })?.versions).toHaveLength(3);
  });

  it("没章号、没一版能用、超长的坏数据：不建卡", () => {
    expect(readDraftVersions({ otherVersions: [{ index: 1, body: "甲" }] })).toBeUndefined();
    expect(readDraftVersions({ chapter: 2, otherVersions: [] })).toBeUndefined();
    expect(readDraftVersions({ chapter: 2, otherVersions: [{ index: 1, body: "长".repeat(60_001) }] })).toBeUndefined();
    expect(readDraftVersions(null)).toBeUndefined();
  });
});
