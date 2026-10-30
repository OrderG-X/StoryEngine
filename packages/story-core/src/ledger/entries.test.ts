// 写作版本 P3a：时间声明存进账、再读回来（重定稿沿用、清单回显都走这条）；段改文后对回句子；定稿前核时间声明。
import { describe, expect, it } from "vitest";
import { project } from "../projection/project.js";
import { checkEntries } from "../review/check.js";
import type { EntryInput, TimeInput } from "../schema/ledger.js";
import { chapterSource, dayDeclarationOf, declarationsOf, ledgerOf, newLedger, relocateScenes, storeLegacyTime, timeDeclarationOf } from "./entries.js";

const TEXT = "# 第2章\n\n第二天傍晚他到了渡口。他想起三年前的那个冬天。那年河面全冻上了。夜里下起了雨。第三天一早雨停了。";
const time: TimeInput = {
  kind: "time",
  review: "auto",
  start: { offset: { unit: "day", min: 1, max: 1 }, basis: "text", quote: "第二天傍晚他到了渡口" },
  dayChanges: [{ byBoundary: { midnight: { unit: "day", min: 1, max: 1 }, dawn: { unit: "day", min: 1, max: 1 } }, quote: "第三天一早雨停了" }],
  segments: [{ frame: "past", firstQuote: "他想起三年前的那个冬天", lastQuote: "那年河面全冻上了", when: { offset: { unit: "year", min: -3, max: -3 } } }],
  weekday: 4,
  timeOfDay: "傍晚",
};

describe("时间声明存进账、读回来", () => {
  it("P3 新账：开头、换天、段原样读回（段补上句子编号），编号跟着声明走", () => {
    const ledger = ledgerOf({ chapter: 2, text: TEXT, committedAt: "x", entries: [{ ...time, id: "c2-1" }] });
    expect(ledger.timeModel).toBe(2);
    expect(ledger.entries.map((entry) => entry.id)).toEqual(["c2-1", "c2-1-d1", "c2-1-s1-t"]);
    // 段的首末句存成整句（之后改文对句子、按编号整句换都按整句）。
    expect(ledger.scenes).toEqual([{ id: "c2-1-s1", units: { from: 2, to: 3 }, order: 0, timeRefs: ["c2-1-s1-t"], frame: "past", quotes: { first: "他想起三年前的那个冬天。", last: "那年河面全冻上了。" } }]);
    const { segments, ...rest } = time;
    expect(timeDeclarationOf(ledger)).toEqual({
      id: "c2-1",
      ...rest,
      segments: [{ ...segments![0]!, firstQuote: "他想起三年前的那个冬天。", lastQuote: "那年河面全冻上了。", units: { from: 2, to: 3 } }],
    });
  });

  it("整章是段（没写开头）：编号从段号推回来；作者定的天数单独读回、给了结尾才有结尾", () => {
    const whole: TimeInput = { kind: "time", review: "auto", segments: [{ frame: "other", firstQuote: "第二天傍晚他到了渡口", lastQuote: "第三天一早雨停了" }] };
    const ledger = ledgerOf({ chapter: 2, text: TEXT, committedAt: "x", entries: [{ ...whole, id: "c2-4" }, { kind: "day", review: "auto", day: 7, id: "c2-5" }] });
    expect(timeDeclarationOf(ledger)).toMatchObject({ id: "c2-4", segments: [{ frame: "other", units: { from: 1, to: 5 } }] });
    expect(timeDeclarationOf(ledger)?.start).toBeUndefined();
    expect(dayDeclarationOf(ledger)).toEqual({ id: "c2-5", kind: "day", review: "author", day: 7 });
    const closed = ledgerOf({ chapter: 2, text: TEXT, committedAt: "x", entries: [{ kind: "day", review: "auto", day: 7, dayEnd: 7 }] });
    expect(dayDeclarationOf(closed)).toMatchObject({ day: 7, dayEnd: 7 });
    expect(declarationsOf(ledger).map((entry) => entry.kind).sort()).toEqual(["day", "time"]);
  });

  it("旧账里作者定的天数没写结尾：当年的意思是本章内过了几天就到哪天，读回成明确的结尾", () => {
    const parsed = newLedger({
      chapter: 3,
      textSha256: "0".repeat(64),
      committedAt: "x",
      origin: "commit",
      legacyTime: true,
      entries: storeLegacyTime({ review: "author", basis: "author", day: 5, daysInChapter: 2 }, "c3-1", { evidence: [], evidenceStatus: "none" }, "migrated"),
    });
    if (!parsed.success) throw parsed.error;
    expect(dayDeclarationOf(parsed.data)).toMatchObject({ day: 5, dayEnd: 7 });
    expect(timeDeclarationOf(parsed.data)).toBeUndefined();
  });
});

describe("段改文后对回句子", () => {
  const ledger = ledgerOf({ chapter: 2, text: TEXT, committedAt: "x", entries: [time] });

  it("首末句还在、只是挪了位置：换成新的句子编号", () => {
    const moved = TEXT.replace("第二天傍晚他到了渡口。", "第二天傍晚他到了渡口。船还没来。");
    expect(relocateScenes(ledger.scenes, chapterSource(2, moved))).toMatchObject([{ units: { from: 3, to: 4 } }]);
    expect(relocateScenes(ledger.scenes, chapterSource(2, moved))[0]).not.toHaveProperty("stale");
  });

  it("首句或末句改没了：标 stale，句子编号留着不用", () => {
    const edited = TEXT.replace("那年河面全冻上了", "那年雪下得很大");
    expect(relocateScenes(ledger.scenes, chapterSource(2, edited))).toMatchObject([{ stale: true, units: { from: 2, to: 3 } }]);
  });

  it("定论改句时，原句跟着换成新的再对", () => {
    const edited = TEXT.replace("那年河面全冻上了", "那年河面只冻了一半");
    const scenes = relocateScenes(ledger.scenes, chapterSource(2, edited), (quote) => (quote === "那年河面全冻上了。" ? "那年河面只冻了一半。" : quote));
    expect(scenes).toMatchObject([{ units: { from: 2, to: 3 }, quotes: { last: "那年河面只冻了一半。" } }]);
  });
});

describe("定稿前核时间声明", () => {
  const empty = project({ ledgers: [], decisions: [] });
  const reasons = (entry: EntryInput) => checkEntries([entry], TEXT, empty).rejected.map((item) => item.message);

  it("段要定位得上、互不重叠；没写开头的段要盖住整章", () => {
    expect(reasons(time)).toEqual([]);
    expect(reasons({ ...time, segments: [{ frame: "past", firstQuote: "那年河面全冻上了", lastQuote: "他想起三年前的那个冬天" }] })).toEqual(["本章时间没记上：段的首句在末句后面"]);
    expect(reasons({
      ...time,
      segments: [
        { frame: "past", firstQuote: "他想起三年前的那个冬天", lastQuote: "那年河面全冻上了" },
        { frame: "other", firstQuote: "那年河面全冻上了", lastQuote: "夜里下起了雨" },
      ],
    })).toEqual(["本章时间没记上：两段的句子重叠了"]);
    expect(reasons({ kind: "time", review: "auto", segments: time.segments })).toEqual(["本章时间没记上：没写本章开头，段却没盖住整章"]);
    // 整章是一段就不在当下线上：不能再说当下的开头、结尾。
    expect(reasons({ ...time, start: undefined })).toEqual(["本章时间没记上：整章是一段时不写当下的开头、结尾"]);
  });

  it("原句没附、找不到的不收；作者定的天数一章一条", () => {
    expect(reasons({ ...time, start: { ...(time.start as Exclude<TimeInput["start"], "unknown" | undefined>), quote: "这句正文里没有" } })).toEqual(["本章时间没记上：附的原句在正文里找不到"]);
    const two = checkEntries([{ kind: "day", review: "auto", day: 3 }, { kind: "day", review: "auto", day: 4 }], TEXT, empty);
    expect(two.rejected.map((item) => item.message)).toEqual(["作者定的天数没记上：作者定的天数一章只有一条"]);
  });
});
