import { describe, expect, it } from "vitest";
import type { SettingCardsFile } from "../schema/cards.js";
import type { AuthorDecision } from "../schema/decisions.js";
import type { ChapterLedger, ReviewMark } from "../schema/ledger.js";
import { ledgerOf, type EntryDraft } from "../ledger/entries.js";
import { project } from "./project.js";

type Draft = EntryDraft extends infer E ? (E extends EntryDraft ? Omit<E, "review"> & { readonly id?: string; readonly review?: ReviewMark } : never) : never;

function ledger(chapter: number, drafts: Draft[]): ChapterLedger {
  return ledgerOf({ chapter, committedAt: "2026-10-17T00:00:00.000Z", entries: drafts.map((draft) => ({ review: "auto", ...draft }) as EntryDraft & { id?: string }) });
}

const presence = (name: string, nameUsed = name, viewpoint?: boolean): Draft => ({ kind: "presence", name, nameUsed, quote: `${nameUsed}来了`, ...(viewpoint ? { viewpoint } : {}) });
const state = (subject: string, attribute: string, value: string, id?: string): Draft => ({
  kind: "fact", nature: "state", subject, attribute, value, text: `${subject}${attribute}${value}`, quote: "原句原句", ...(id ? { id } : {}),
});
const hard = (subject: string, attribute: string, value: string, extra: { id?: string; replaces?: string[] } = {}): Draft => ({
  kind: "fact", nature: "hard", subject, attribute, value, text: `${subject}${attribute}${value}`, quote: "原句原句", ...extra,
});
const open = (thread: string, title: string): Draft => ({ kind: "thread", op: "open", thread, type: "question", title, note: title, quote: "原句原句" });
const touch = (thread: string, op: "advance" | "close"): Draft => ({ kind: "thread", op, thread, note: op, quote: "原句原句" });
const decision = (input: Record<string, unknown>, index = 1): AuthorDecision => ({ id: `d-${index}`, at: "2026-10-17T00:00:00.000Z", ...input }) as AuthorDecision;

describe("投影", () => {
  it("状态按最新一章算，历史留着", () => {
    const result = project({
      ledgers: [
        ledger(1, [state("钟箱钥匙", "在哪", "老周手里")]),
        ledger(3, [state("钟箱钥匙", "在哪", "铜盒里")]),
        ledger(10, [state("钟箱钥匙", "在哪", "沈青禾包里")]),
      ],
      decisions: [],
    });
    const key = result.subjects.find((subject) => subject.name === "钟箱钥匙");
    const where = key?.attributes[0];
    expect(where?.current).toEqual(["c10-1"]);
    expect(where?.history).toEqual(["c1-1", "c3-1", "c10-1"]);
    expect(result.facts.find((fact) => fact.id === "c1-1")).toMatchObject({ status: "superseded", supersededAt: 3, supersededBy: "c3-1" });
    expect(result.conflicts).toEqual([]);
  });

  it("不会变的：值不同又没明写推翻 = 矛盾，两条都还有效；明写推翻才作废", () => {
    const conflict = project({ ledgers: [ledger(1, [hard("老周", "年纪", "六十")]), ledger(4, [hard("老周", "年纪", "七十")])], decisions: [] });
    expect(conflict.conflicts).toHaveLength(1);
    expect(conflict.facts.every((fact) => fact.status === "current")).toBe(true);

    const replaced = project({
      ledgers: [ledger(1, [hard("老周", "年纪", "六十")]), ledger(4, [hard("老周", "年纪", "七十", { replaces: ["c1-1"] })])],
      decisions: [],
    });
    expect(replaced.conflicts).toEqual([]);
    expect(replaced.facts[0]).toMatchObject({ status: "superseded", supersededBy: "c4-1" });
  });

  it("作者说「不是问题」的矛盾不再报；说「记错了」的事实不参与比对", () => {
    const ledgers = [ledger(1, [hard("老周", "年纪", "六十")]), ledger(4, [hard("老周", "年纪", "七十")])];
    expect(project({ ledgers, decisions: [decision({ type: "issue.dismiss", issue: "hard-fact:c1-1:c4-1" })] }).conflicts).toEqual([]);
    const retracted = project({ ledgers, decisions: [decision({ type: "fact.retract", fact: "c1-1" })] });
    expect(retracted.conflicts).toEqual([]);
    expect(retracted.facts[0]?.status).toBe("retracted");
  });

  it("作者说「从第几章起不再成立」：那章起作废；之后同一方面的新值不算矛盾", () => {
    const result = project({
      ledgers: [ledger(1, [hard("铜盒", "锁", "黄铜锁")]), ledger(6, [hard("铜盒", "锁", "密码锁")])],
      decisions: [decision({ type: "fact.expire", fact: "c1-1", chapter: 4 }), decision({ type: "fact.expire", fact: "c9-9", chapter: 2 }, 2)],
    });
    expect(result.facts[0]).toMatchObject({ status: "superseded", supersededAt: 4 });
    expect(result.facts[0]?.supersededBy).toBeUndefined();
    expect(result.conflicts).toEqual([]);
    expect(result.dangling).toEqual([{ kind: "decision", ref: "c9-9", source: "d-2" }]);
  });

  it("作者补记事实：算在那一章末尾、走同一套顶替和矛盾规则；改写的那条作废；章没定稿的摆进 dangling", () => {
    const result = project({
      ledgers: [ledger(1, [state("铜钥匙", "在哪", "老周手里"), hard("老周", "年纪", "六十")]), ledger(3, [state("铜钥匙", "在哪", "铜盒里")])],
      decisions: [
        decision({ type: "fact.assert", chapter: 1, nature: "state", subject: "铜钥匙", attribute: "在哪", value: "沈青禾包里", text: "钥匙其实在沈青禾包里" }, 1),
        decision({ type: "fact.assert", chapter: 1, nature: "hard", subject: "老周", attribute: "年纪", value: "六十二", text: "老周六十二", corrects: "c1-2" }, 2),
        decision({ type: "fact.assert", chapter: 2, nature: "event", text: "第二章没定稿" }, 3),
        decision({ type: "fact.assert", chapter: 1, nature: "event", text: "钟楼失过一次火" }, 4),
      ],
    });
    expect(result.facts.map((fact) => [fact.id, fact.status])).toEqual([
      ["c1-1", "superseded"],
      ["c1-2", "retracted"],
      ["d-1", "superseded"],
      ["d-2", "current"],
      ["d-4", "current"],
      ["c3-1", "current"],
    ]);
    expect(result.facts.find((fact) => fact.id === "d-1")).toMatchObject({ chapter: 1, review: "author", supersededAt: 3, supersededBy: "c3-1" });
    expect(result.facts.find((fact) => fact.id === "d-1")?.quote).toBeUndefined();
    expect(result.conflicts).toEqual([]);
    expect(result.dangling).toEqual([{ kind: "decision", ref: "chapter:2", chapter: 2, source: "d-3" }]);
  });

  it("别名：正文里的新称呼归到已确立的人；主体名也按别名归并", () => {
    const result = project({
      ledgers: [
        ledger(1, [presence("周守义"), presence("沈青禾", "沈青禾", true)]),
        ledger(2, [presence("周守义", "老周"), state("老周", "在哪", "钟楼")]),
        ledger(3, [state("周守义", "在哪", "镇上")]),
      ],
      decisions: [],
    });
    const zhou = result.cast.find((member) => member.name === "周守义");
    expect(zhou).toMatchObject({ aliases: ["老周"], chapters: [1, 2] });
    // 每章出场的原句（别名那章也算在本人名下），故事地图点格子回原文用。
    expect(zhou?.appearances).toEqual([{ chapter: 1, quote: "周守义来了" }, { chapter: 2, quote: "老周来了" }]);
    expect(result.subjects).toHaveLength(1);
    expect(result.subjects[0]?.attributes[0]?.current).toEqual(["c3-1"]);
    expect(result.chapters[0]?.viewpoint).toBe("沈青禾");
  });

  it("别名：设定卡上写的别名也算——账里记成别名的人和事实归到卡名；别名是另一张卡的名字的不收", () => {
    const at = "2026-10-27T00:00:00.000Z";
    const cards = {
      schema: "setting-cards/1",
      story: { fields: [] },
      rules: { style: [], musts: [], bans: [], avoid: [], exemplars: [] },
      cards: [
        { id: "k-1", kind: "character", name: "林国栋", aliases: ["林父", "老林"], fields: [], by: "author", at },
        { id: "k-2", kind: "character", name: "老林", aliases: [], fields: [], by: "author", at },
      ],
      relations: [],
      canon: [],
      skipped: [],
    } as unknown as SettingCardsFile;
    const result = project({
      ledgers: [
        ledger(1, [state("林父", "伤势病情", "住院")]),
        ledger(2, [presence("林国栋", "父亲"), state("林国栋", "伤势病情", "失语")]),
        ledger(3, [presence("老林")]),
      ],
      decisions: [],
      cards,
    });
    expect(result.subjects).toHaveLength(1);
    expect(result.subjects[0]?.name).toBe("林国栋");
    expect(result.subjects[0]?.attributes[0]?.current).toEqual(["c2-2"]);
    // 「老林」自己有卡：是另一个人，不归到林国栋。
    expect(result.cast.map((member) => member.name).sort()).toEqual(["林国栋", "老林"]);
    // 不给卡照旧：林父、林国栋各算各的。
    expect(project({ ledgers: [ledger(1, [state("林父", "伤势病情", "住院")]), ledger(2, [state("林国栋", "伤势病情", "失语")])], decisions: [] }).subjects).toHaveLength(2);
  });

  it("别名：泛称（generic）只认那一章是他，不记成别名、不顶替别人", () => {
    const result = project({
      ledgers: [
        ledger(1, [presence("周守义")]),
        ledger(2, [{ kind: "presence", name: "周守义", nameUsed: "那人", generic: true, quote: "那人来了" }]),
        ledger(3, [presence("沈青禾", "那人")]),
      ],
      decisions: [],
    });
    expect(result.cast.find((member) => member.name === "周守义")).toMatchObject({ aliases: [], chapters: [1, 2] });
    // 第 3 章「那人」是另一个人，不会因为第 2 章用过就归到周守义名下。
    expect(result.cast.find((member) => member.name === "沈青禾")?.chapters).toEqual([3]);
  });

  it("线索：开、推进、收；停太久；收了又推进算重开", () => {
    const result = project({
      ledgers: [
        ledger(1, [open("t1-1", "钟为什么停"), open("t1-2", "外乡人是谁")]),
        ledger(2, [touch("t1-1", "advance")]),
        ledger(3, [touch("t1-2", "close")]),
        ledger(5, [touch("t1-2", "advance")]),
        ledger(9, [open("t9-1", "谁卖了机芯")]),
      ],
      decisions: [],
    });
    const byTitle = Object.fromEntries(result.threads.map((thread) => [thread.title, thread]));
    expect(byTitle["钟为什么停"]?.status).toBe("stale");
    expect(byTitle["外乡人是谁"]).toMatchObject({ status: "active", lastTouchedAt: 5 });
    expect(byTitle["外乡人是谁"]?.closedAt).toBeUndefined();
    expect(byTitle["谁卖了机芯"]?.status).toBe("open");
  });

  it("大伏笔要埋很久：停 9 章不算停太久，停满 20 章才提醒；普通线索照旧 5 章", () => {
    const at = (upTo: number) => project({
      ledgers: [ledger(1, [open("t1-1", "铁箱里是什么"), open("t1-2", "工钱补没补")]), ledger(upTo, [])],
      decisions: [decision({ type: "thread.weight", thread: "t1-1", weight: "major" }, 1)],
    });
    const status = (upTo: number, title: string) => at(upTo).threads.find((thread) => thread.title === title)?.status;
    expect(status(10, "铁箱里是什么")).toBe("open");
    expect(status(10, "工钱补没补")).toBe("stale");
    expect(status(20, "铁箱里是什么")).toBe("open");
    expect(status(21, "铁箱里是什么")).toBe("stale");
  });

  it("作者裁定：归并、收口、分量；指向不存在的线索摆出来不吞", () => {
    const result = project({
      ledgers: [ledger(1, [open("t1-1", "老周回避"), open("t1-2", "阿笙被打断")]), ledger(4, [touch("t1-2", "advance"), touch("t9-9", "advance")])],
      decisions: [
        decision({ type: "thread.merge", from: ["t1-2"], into: "t1-1" }, 1),
        decision({ type: "thread.weight", thread: "t1-1", weight: "major" }, 2),
        decision({ type: "thread.close", thread: "t1-1", chapter: 6 }, 3),
        decision({ type: "thread.weight", thread: "t1-2", weight: "minor" }, 4),
      ],
    });
    expect(result.threads).toHaveLength(1);
    expect(result.threads[0]).toMatchObject({ id: "t1-1", mergedFrom: ["t1-2"], weight: "major", closedAt: 6, closedBy: "author", status: "closed", lastTouchedAt: 4 });
    expect(result.dangling).toEqual([
      { kind: "thread", ref: "t9-9", chapter: 4, source: "c4-2" },
      { kind: "decision", ref: "t1-2", source: "d-4" },
    ]);
  });

  // 长篇实跑：第 41 章梗概记成「离云州北上」（其实往南），定稿后没处改。
  it("作者裁定改一章的梗概：顶掉账单记的，改过几次按最后一次", () => {
    const ledgers = [
      ledger(1, [{ kind: "summary", text: "离城北上。", quote: "出了城" }]),
      ledger(2, [{ kind: "summary", text: "到了渡口。", quote: "渡口" }]),
    ];
    const result = project({
      ledgers,
      decisions: [decision({ type: "chapter.summary", chapter: 1, text: "离城南下。" }), decision({ type: "chapter.summary", chapter: 1, text: "离城往南。" }, 2)],
    });
    expect(result.chapters.map((chapter) => chapter.summary)).toEqual(["离城往南。", "到了渡口。"]);
  });

  it("定稿后改过正文：和账单记的 sha256 对不上就标出来", () => {
    const result = project({
      ledgers: [ledger(1, []), ledger(2, [])],
      decisions: [],
      textHashes: new Map([[1, "0".repeat(64)], [2, "f".repeat(64)]]),
    });
    expect(result.chapters.map((chapter) => chapter.editedSinceCommit)).toEqual([false, true]);
  });

  it("只算到第 k 章：和只给前 k 章账单算出来的一样", () => {
    const ledgers = Array.from({ length: 12 }, (_, index) => ledger(index + 1, [state("钥匙", "在哪", `第${index + 1}处`), open(`t${index + 1}-1`, `问题${index + 1}`)]));
    expect(project({ ledgers, decisions: [] }, { upTo: 7 })).toEqual(project({ ledgers: ledgers.slice(0, 7), decisions: [] }));
  });

  it("量级：200 章、每章 60 条，全量重算够快", () => {
    const ledgers = Array.from({ length: 200 }, (_, index) => {
      const chapter = index + 1;
      const drafts: Draft[] = [{ kind: "time", start: { offset: { unit: "day", min: 1, max: 1 }, basis: "judged", quote: "原句原句" }, sameDay: true }];
      for (let n = 0; n < 20; n += 1) drafts.push(state(`物件${n}`, "在哪", `第${chapter}章的地方`));
      for (let n = 0; n < 20; n += 1) drafts.push(presence(`人物${n}`, n % 3 === 0 ? `阿${n}` : `人物${n}`));
      drafts.push(open(`t${chapter}-1`, `问题${chapter}`));
      for (let n = 1; n < Math.min(chapter, 18); n += 1) drafts.push(touch(`t${chapter - n}-1`, "advance"));
      return ledger(chapter, drafts);
    });
    const started = performance.now();
    const result = project({ ledgers, decisions: [] });
    const elapsed = performance.now() - started;
    expect(result.facts).toHaveLength(4000);
    expect(result.threads).toHaveLength(200);
    expect(elapsed).toBeLessThan(500);
  });
});
