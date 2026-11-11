// @vitest-environment node
import { splitUnits, type TimeInput } from "@actalk/story-core";
import { describe, expect, it } from "vitest";
import type { KeeperParseResult } from "./keeper-parse.js";
import type { BrainMessage } from "./reader-window.js";
import { buildTimeJudgeTask, buildTimeTask, describeCandidate, parseTimeCandidate, pickField, readingOf, reconcileTime, sameReading, TIME_SPEC, type TimeCandidate } from "./time-check.js";

const day = (min: number, max: number | undefined = min) => ({ unit: "day" as const, min, ...(max !== undefined ? { max } : {}) });
const draft = "# 第3章\n\n傍晚，她出了门。夜里十一点，灯还亮着。第二天上午，雨停了。中午，客人进门。";
const units = splitUnits(draft);
const idOf = (text: string): number => units.find((unit) => draft.slice(unit.start, unit.end).includes(text))!.id;
const sentence = (text: string): string => {
  const unit = units.find((each) => draft.slice(each.start, each.end).includes(text))!;
  return draft.slice(unit.start, unit.end);
};
const material = { chapter: 3, numbered: "（编号正文）", contextText: "【前文原文：第 1～2 章（只用来认人认事、接上上一章结尾）】", endingText: "【上一个当下章结尾（第 2 章）】\n她睡下了。" };

describe("记时间那遍交回来的", () => {
  it("开头按 startId 取那一句；换天按 id 取句；套了一层 time 的照收；整章不在当下、章末不知道照收", () => {
    const reply = JSON.stringify({ cues: [{ id: 1, what: "傍晚" }], start: { offset: { unit: "day", min: 1 }, basis: "judged", startId: idOf("傍晚") }, dayChanges: [{ id: idOf("第二天上午"), offset: day(1) }] });
    expect(parseTimeCandidate(reply, draft, units)).toEqual({
      start: { offset: { unit: "day", min: 1 }, basis: "judged", quote: sentence("傍晚") },
      dayChanges: [{ offset: day(1), quote: sentence("第二天上午") }],
    });
    expect(parseTimeCandidate(JSON.stringify({ time: { start: "unknown", sameDay: true } }), draft, units)).toEqual({ start: "unknown", sameDay: true });
    expect(parseTimeCandidate(JSON.stringify({ notPresent: "true" }), draft, units)).toEqual({ notPresent: true });
    // 没点依据那句、也没抄得上的原句：挂本章第一句，依据记成对照着判断的（不当正文明写）。
    expect(parseTimeCandidate(JSON.stringify({ start: { byBoundary: { midnight: day(0), dawn: day(1) }, basis: "text" }, endUnknown: true }), draft, units)).toEqual({
      start: { byBoundary: { midnight: day(0), dawn: day(1) }, basis: "judged", quote: sentence("傍晚") },
    });
    // 自己抄的原句核得上照用。
    expect(parseTimeCandidate(JSON.stringify({ start: { offset: day(1), basis: "text", quote: "第二天上午，雨停了" }, endUnknown: true }), draft, units)).toEqual({
      start: { offset: day(1), basis: "text", quote: "第二天上午，雨停了" },
    });
  });

  it("startId 点的那句太短核不上（「次日。」）：连上后一句，没有后一句连前一句", () => {
    const short = "# 第3章\n\n次日。她推开了旅店的大门。中午，客人进门。次日。";
    const shortUnits = splitUnits(short);
    const reply = (id: number) => JSON.stringify({ start: { offset: day(1), basis: "text", startId: id }, sameDay: true });
    expect(parseTimeCandidate(reply(1), short, shortUnits)).toMatchObject({ start: { offset: day(1), basis: "text", quote: "次日。她推开了旅店的大门。" } });
    expect(parseTimeCandidate(reply(shortUnits.length), short, shortUnits)).toMatchObject({ start: { quote: "中午，客人进门。次日。" } });
  });

  it("读不了、缺开头、缺结尾、换天编号对不上、又同一天又换天：说原因，不当一份读法", () => {
    const start = { offset: day(1), basis: "text", startId: 1 };
    for (const [reply, reason] of [
      ["不是 JSON", "不是 JSON"],
      [JSON.stringify({ sameDay: true }), "没写本章开头"],
      [JSON.stringify({ start }), "没写本章结尾"],
      [JSON.stringify({ start, dayChanges: [{ id: 99, offset: day(1) }] }), "编号不对"],
      [JSON.stringify({ start, sameDay: true, dayChanges: [{ id: idOf("第二天上午"), offset: day(1) }] }), "又说整章同一天"],
      [JSON.stringify({ start: { offset: "很久" }, sameDay: true }), "开头写得不对"],
    ] as const) {
      expect(parseTimeCandidate(reply, draft, units)).toEqual(expect.stringContaining(reason));
    }
  });
});

describe("读法", () => {
  it("换天落在哪句不比；几次换天按两种规矩各加起来；同一天 = 0；没说结尾 = 不知道", () => {
    const night = { byBoundary: { midnight: day(1), dawn: day(0) } };
    const dawn = { byBoundary: { midnight: day(0), dawn: day(1) } };
    const a: TimeCandidate = { start: { offset: day(1), basis: "text", quote: "x" }, dayChanges: [{ ...night, quote: "甲" }, { ...dawn, quote: "乙" }] };
    const b: TimeCandidate = { start: { offset: day(1), basis: "judged", quote: "y" }, dayChanges: [{ offset: day(1), quote: "丙" }] };
    expect(readingOf(a)).toEqual({ present: true, start: { midnight: day(1), dawn: day(1) }, span: { midnight: day(1), dawn: day(1) } });
    expect(sameReading(readingOf(a), readingOf(b))).toBe(true);
    expect(sameReading(readingOf({ start: "unknown", sameDay: true }), readingOf({ start: "unknown" }))).toBe(false);
    expect(readingOf({ start: "unknown" })).toEqual({ present: true, start: { midnight: "unknown", dawn: "unknown" }, span: { midnight: "unknown", dawn: "unknown" } });
    expect(readingOf({ notPresent: true })).toEqual({ present: false });
    expect(readingOf({ start: { offset: day(1), basis: "text", quote: "x" }, dayChanges: [{ offset: { unit: "day", min: 1 }, quote: "q" }, { offset: day(2), quote: "q" }] }).span).toEqual({ midnight: { unit: "day", min: 3 }, dawn: { unit: "day", min: 3 } });
  });

  it("一项怎么定：两遍一样照留；裁的和哪边一样用哪边；裁的把两边都包住用它的；都不是按不知道；没裁成照主对话", () => {
    const w = (min: number, max?: number) => ({ midnight: day(min, max), dawn: day(min, max) });
    const open = { midnight: { unit: "day" as const, min: 1 }, dawn: { unit: "day" as const, min: 1 } };
    const unknown = { midnight: "unknown" as const, dawn: "unknown" as const };
    expect(pickField(w(1), w(1), undefined)).toBe("main");
    expect(pickField(w(0), w(1), undefined)).toBe("main");
    expect(pickField(w(0), w(1), w(0))).toBe("main");
    expect(pickField(w(0), w(1), w(1))).toBe("second");
    expect(pickField(w(0), w(1), w(0, 1))).toBe("judge");
    expect(pickField(w(1), w(2), open)).toBe("judge");
    expect(pickField(w(1), open, open)).toBe("second");
    expect(pickField(w(0), w(1), unknown)).toBe("judge");
    expect(pickField(w(0), w(1), w(2))).toBe("unknown");
    expect(pickField(w(0), w(1), w(1, 2))).toBe("unknown");
  });
});

describe("两遍对一下", () => {
  const mainTime: TimeInput = { kind: "time", review: "auto", start: { offset: day(1), basis: "judged", quote: "傍晚，她出了门。" }, sameDay: true, timeOfDay: "傍晚", segments: [] };
  const parsedOf = (time: TimeInput): KeeperParseResult => ({ entries: [{ kind: "summary", review: "auto", text: "t", quote: "q" }, time], drops: [], adjusted: [] });
  const changed: TimeCandidate = { start: { offset: day(1), basis: "judged", quote: "傍晚，她出了门。" }, dayChanges: [{ offset: day(1), quote: sentence("第二天上午") }] };
  const run = async (second: TimeCandidate | string, judge?: () => Promise<string>, impossible = false, main: TimeInput = mainTime, hasPrevious = true) => {
    const asked: BrainMessage[][] = [];
    const outcome = await reconcileTime(parsedOf(main), second, {
      draft,
      units,
      material,
      impossible: () => impossible,
      hasPrevious,
      callModel: async (messages) => {
        asked.push([...messages]);
        if (!judge) throw new Error("不该裁");
        return judge();
      },
    });
    return { ...outcome, asked, time: outcome.parsed.entries.find((entry) => entry.kind === "time") };
  };

  it("一样：照主对话的，不裁；记时间那遍没成：照主对话的，留一句原因", async () => {
    const same = await run({ start: { offset: day(1), basis: "text", quote: "x" }, sameDay: true });
    expect(same.time).toEqual(mainTime);
    expect(same.check).toEqual({ result: "agreed" });
    expect(same.asked).toEqual([]);
    const failed = await run("记时间那遍没成（连不上）");
    expect(failed.time).toEqual(mainTime);
    expect(failed.check).toEqual({ result: "kept", failed: "记时间那遍没成（连不上）" });
  });

  it("章里对不上，裁的和记时间那遍一样：结尾换成它的（换天带那句原句），开头、段、时段照主对话的", async () => {
    const out = await run(changed, async () => JSON.stringify({ start: { offset: day(1), basis: "judged" }, dayChanges: [{ id: idOf("第二天上午"), offset: day(1) }] }));
    expect(out.time).toEqual({ kind: "time", review: "auto", start: mainTime.start, dayChanges: [{ offset: day(1), quote: sentence("第二天上午") }], timeOfDay: "傍晚", segments: [] });
    expect(out.check).toEqual({ result: "judged", took: { start: "main", end: "second" } });
    expect(out.parsed.adjusted).toEqual([]);
    const task = out.asked[0]?.at(-1)?.content ?? "";
    expect(task).toContain("不一样的是：章里换没换天");
    expect(task).toContain("甲：\n本章开头离上一个当下章结尾：1 天（依据 第 1 句「傍晚，她出了门。」）。\n章里：从头到尾同一天。");
    expect(task).toContain(`乙：\n本章开头离上一个当下章结尾：1 天（依据 第 1 句「傍晚，她出了门。」）。\n章里：第 ${idOf("第二天上午")} 句「${sentence("第二天上午")}」换了天，1 天。`);
    expect(task).toContain(material.endingText);
    expect(task).toContain(TIME_SPEC[0]);
  });

  it("开头对不上：裁的和主对话一样照留；给了把两边都包住的区间用它的；给了第三个数按不知道记、如实说", async () => {
    const atLeast: TimeCandidate = { start: { offset: { unit: "day", min: 1 }, basis: "judged", quote: sentence("中午") }, sameDay: true };
    const kept = await run(atLeast, async () => JSON.stringify({ start: { offset: day(1), basis: "judged", startId: 1 }, sameDay: true }));
    expect(kept.time).toEqual(mainTime);
    expect(kept.check).toEqual({ result: "judged", took: { start: "main", end: "main" } });

    const second = await run(atLeast, async () => JSON.stringify({ start: { offset: { unit: "day", min: 1 }, basis: "judged" }, sameDay: true }));
    // 用记时间那遍的开头：原句是它自己的那句，不借主对话那句。
    expect(second.time).toMatchObject({ start: { offset: { unit: "day", min: 1 }, quote: sentence("中午") }, sameDay: true });
    expect(second.check).toEqual({ result: "judged", took: { start: "second", end: "main" } });

    const zero: TimeCandidate = { start: { offset: day(0), basis: "judged", quote: "x" }, sameDay: true };
    const range = await run(zero, async () => JSON.stringify({ start: { offset: day(0, 1), basis: "judged", startId: idOf("傍晚") }, sameDay: true }));
    expect(range.time).toMatchObject({ start: { offset: day(0, 1), quote: sentence("傍晚") }, sameDay: true });
    expect(range.check).toEqual({ result: "judged", took: { start: "judge", end: "main" } });

    const third = await run(zero, async () => JSON.stringify({ start: { offset: day(2), basis: "judged" }, sameDay: true }));
    expect(third.time).toMatchObject({ start: "unknown", sameDay: true });
    expect(third.check).toEqual({ result: "judged", took: { start: "unknown", end: "main" } });
    expect(third.parsed.adjusted).toEqual([{ where: "time", reason: "记时间的几遍对不上，本章开头离上一章隔多久按不知道记" }]);
  });

  it("裁定没成、读不了、拼出来走不通、两遍对本章在不在当下说的不一样：照主对话的，留一句原因", async () => {
    for (const judge of [async () => { throw new Error("fetch failed"); }, async () => "不是 JSON"]) {
      const out = await run(changed, judge);
      expect(out.time).toEqual(mainTime);
      expect(out.check).toMatchObject({ result: "kept", failed: expect.stringContaining("裁定那遍") });
    }
    const blocked = await run(changed, async () => JSON.stringify({ start: { offset: day(1), basis: "judged" }, dayChanges: [{ id: idOf("第二天上午"), offset: day(1) }] }), true);
    expect(blocked.time).toEqual(mainTime);
    expect(blocked.check).toMatchObject({ result: "kept", failed: expect.stringContaining("走不通") });
    const notPresent = await run({ notPresent: true });
    expect(notPresent.time).toEqual(mainTime);
    expect(notPresent.check).toMatchObject({ result: "kept", failed: expect.stringContaining("在不在当下") });
    expect(notPresent.asked).toEqual([]);
  });

  it("记时间那遍、裁定那遍自己整份走不通：不参与比（不裁、不拼成不知道），照主对话的", async () => {
    const twoDays = (time: TimeInput) => time.start !== undefined && time.start !== "unknown" && time.start.offset?.min === 2;
    const call = async (second: TimeCandidate, judge?: string) => {
      const asked: BrainMessage[][] = [];
      const outcome = await reconcileTime(parsedOf(mainTime), second, {
        draft,
        units,
        material,
        impossible: twoDays,
        hasPrevious: true,
        callModel: async (messages) => {
          asked.push([...messages]);
          if (judge === undefined) throw new Error("不该裁");
          return judge;
        },
      });
      return { ...outcome, asked, time: outcome.parsed.entries.find((entry) => entry.kind === "time") };
    };
    const badSecond = await call({ start: { offset: day(2), basis: "judged", quote: sentence("傍晚") }, sameDay: true });
    expect(badSecond.time).toEqual(mainTime);
    expect(badSecond.check).toEqual({ result: "kept", failed: expect.stringContaining("记时间那遍记的按两种换天规矩走不通") });
    expect(badSecond.asked).toEqual([]);
    // 读法和主对话一样，但它自己整份走不通：不记成两遍对上。
    const mainTwo: TimeInput = { ...mainTime, start: { offset: day(2), basis: "judged", quote: "傍晚，她出了门。" } };
    const sameButBad = await reconcileTime(parsedOf(mainTwo), { start: { offset: day(2), basis: "judged", quote: sentence("中午") }, sameDay: true }, {
      draft, units, material, impossible: twoDays, hasPrevious: true, callModel: async () => { throw new Error("不该裁"); },
    });
    expect(sameButBad).toEqual({ parsed: parsedOf(mainTwo), check: { result: "kept", failed: expect.stringContaining("记时间那遍记的") } });
    const badJudge = await call({ start: { offset: day(0), basis: "judged", quote: sentence("傍晚") }, sameDay: true }, JSON.stringify({ start: { offset: day(2), basis: "judged", startId: 1 }, sameDay: true }));
    expect(badJudge.time).toEqual(mainTime);
    expect(badJudge.check).toEqual({ result: "kept", failed: expect.stringContaining("裁定那遍记的按两种换天规矩走不通") });
    expect(badJudge.parsed.adjusted).toEqual([]);
  });

  it("第 1 章：开头是起点，隔多久不比、不裁；章里照样比", async () => {
    const startOnly = await run({ start: "unknown", sameDay: true }, undefined, false, mainTime, false);
    expect(startOnly.check).toEqual({ result: "agreed" });
    expect(startOnly.asked).toEqual([]);
    const both = await run({ start: "unknown", dayChanges: [{ offset: day(1), quote: sentence("第二天上午") }] }, async () => JSON.stringify({ start: "unknown", dayChanges: [{ id: idOf("第二天上午"), offset: day(1) }] }), false, mainTime, false);
    expect(both.check).toEqual({ result: "judged", took: { start: "main", end: "second" } });
    expect(both.time).toMatchObject({ start: mainTime.start, dayChanges: [{ offset: day(1) }] });
    expect(both.asked[0]?.at(-1)?.content).toContain("不一样的是：章里换没换天）");
  });

  it("主对话没记上时间：不比", async () => {
    const parsed: KeeperParseResult = { entries: [], drops: [{ where: "time", reason: "时间里什么都没写" }], adjusted: [] };
    const out = await reconcileTime(parsed, changed, { draft, units, material, impossible: () => false, hasPrevious: true, callModel: async () => { throw new Error("不该调"); } });
    expect(out).toEqual({ parsed });
  });
});

describe("给模型的话", () => {
  it("记时间那遍：本章编号正文、前文原文、上一个当下章结尾、要求；要求里要依据、没依据只写下限，不写书名人名", () => {
    const task = buildTimeTask(material);
    expect(task.indexOf("【第 3 章 正文（每句前面是编号）】")).toBeLessThan(task.indexOf("【前文原文"));
    expect(task.indexOf("【前文原文")).toBeLessThan(task.indexOf("【上一个当下章结尾"));
    expect(task).toContain("请只记本章的时间");
    expect(TIME_SPEC.join("\n")).toContain("只写 min（至少几天），不写 max");
    expect(TIME_SPEC.join("\n")).toContain("id 写过了半夜那句");
    expect(buildTimeTask({ chapter: 1, numbered: "[1] 她醒了。", contextText: "", endingText: "" })).not.toContain("\n\n\n");
  });

  it("裁定那遍：两份读法摆出来、说清哪里不一样；按换天规矩各写的、往回接、没上限、按月的都说成人话", () => {
    expect(describeCandidate({ start: { byBoundary: { midnight: day(0), dawn: day(1) }, basis: "judged", quote: "" }, dayChanges: [{ offset: day(1), quote: "不在正文里的话" }] }, draft, units)).toBe(
      "本章开头离上一个当下章结尾：过了半夜就算第二天时 0 天，天亮才算第二天时 1 天。\n章里：「不在正文里的话」换了天，1 天。",
    );
    expect(describeCandidate({ start: { offset: day(-2), basis: "text", quote: "" } }, draft, units)).toBe("本章开头离上一个当下章结尾：往回 2 天。\n章里：章末是哪天说不出。");
    expect(describeCandidate({ start: { offset: { unit: "month", min: 6, max: 6 }, basis: "text", quote: "" }, sameDay: true }, draft, units)).toContain("6 个月");
    expect(describeCandidate({ start: { offset: { unit: "day", min: 1 }, basis: "judged", quote: "" }, sameDay: true }, draft, units)).toContain("至少 1 天");
    expect(describeCandidate({ notPresent: true }, draft, units)).toBe("整章不在当下（回忆、梦这类）。");
    const task = buildTimeJudgeTask(material, "甲的读法", "乙的读法", ["本章开头离上一章隔多久", "章里换没换天"]);
    expect(task).toContain("不一样的是：本章开头离上一章隔多久、章里换没换天");
    expect(task).toContain("正文定不下的，照下面的规矩写区间或 unknown，不要硬挑一个");
  });
});
