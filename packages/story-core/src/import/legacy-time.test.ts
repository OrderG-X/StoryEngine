// 写作版本 P3a 设计 2.6：老书的天数怎么进账（新导入和已导入账的盘点同一条规则）。
import { describe, expect, it } from "vitest";
import { legacyTimelineRow, legacyTimeOf, type LegacyTimeRow } from "./legacy-time.js";

const row = (chapter: number, day: number, basis: LegacyTimeRow["basis"], extra: Partial<LegacyTimeRow> = {}): LegacyTimeRow => ({ chapter, day, basis, ...extra });
const kinds = (rows: LegacyTimeRow[]) => legacyTimeOf(rows).map((outcome) => (outcome.kind === "unknown" ? outcome.legacy.reason : outcome.kind === "offset" ? outcome.daysSincePrevious : `at ${outcome.day}`));

describe("老时间线 → 账里的天数", () => {
  it("比上一章早的（不是作者定的）：没法判断是倒叙还是记错，不知道；紧跟它的下一章差值是相对它算的，也不知道", () => {
    expect(kinds([row(1, 1, "text"), row(2, 5, "judged"), row(3, 2, "text"), row(4, 6, "text"), row(5, 7, "text")])).toEqual([1, 4, "earlier", "after_bad", 1]);
  });

  it("估的是坏锚：它和下一章都不知道（不把估的 +1 升成准的）", () => {
    expect(kinds([row(1, 1, "text"), row(2, 5, "estimated"), row(3, 6, "text"), row(4, 8, "judged")])).toEqual([1, "estimated", "after_bad", 2]);
  });

  it("作者定的照留（哪怕比上一章早），后面的章相对它算；紧跟坏锚的作者天数也照留", () => {
    expect(kinds([row(1, 3, "text"), row(2, 1, "author"), row(3, 2, "text"), row(4, 9, "estimated"), row(5, 4, "author"), row(6, 5, "text")]))
      .toEqual([3, "at 1", 1, "estimated", "at 4", 1]);
  });

  it("本章内过了几天算进上一章结尾", () => {
    expect(legacyTimeOf([row(1, 1, "text", { daysInChapter: 2 }), row(2, 4, "text")])).toEqual([
      { chapter: 1, kind: "offset", daysSincePrevious: 1, basis: "text", daysInChapter: 2 },
      { chapter: 2, kind: "offset", daysSincePrevious: 1, basis: "text" },
    ]);
  });

  it("盘点时：账里记成作者定的、老文件里不是 → 伪裁定，不知道，下一章跟着不知道", () => {
    expect(kinds([row(1, 1, "text"), row(2, 3, "judged", { storedAsAuthor: true }), row(3, 4, "text")])).toEqual([1, "not_author", "after_bad"]);
    const [, fake] = legacyTimeOf([row(1, 1, "text"), row(2, 3, "judged", { storedAsAuthor: true })]);
    expect(fake).toEqual({ chapter: 2, kind: "unknown", legacy: { relation: "at", day: 3, basis: "judged", reason: "not_author" } });
  });

  it("老代码的依据四种照映射，别的一律当估的", () => {
    expect(["author", "declared", "plan", "fallback", "别的"].map((source) => legacyTimelineRow({ chapter: 1, day: 1, source }).basis)).toEqual(["author", "text", "judged", "estimated", "estimated"]);
  });
});
