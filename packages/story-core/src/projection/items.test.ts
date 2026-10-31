/**
 * 东西现在在哪（写作版本 P3b 设计 2.5～2.7、第 6 节固定反例）：投影这一层。
 * 声明 → 核心校验 → 定稿的整条链在 commands/items.test.ts，撤销依赖在 history/history.test.ts。
 */
import { describe, expect, it } from "vitest";
import { emptySettingCards, type SettingCardsFile } from "../schema/cards.js";
import type { AuthorDecision } from "../schema/decisions.js";
import type { ChapterLedger, EntryInput } from "../schema/ledger.js";
import { declarationsOf, ledgerOf } from "../ledger/entries.js";
import { project } from "./project.js";
import type { ItemView } from "./items.js";

const T = (n: number, body: string): string => `# 第${n}章\n\n${body}`;
type Ref = { id: string } | { tag: string };
const narration = { kind: "narration" as const };
const appear = (tag: string, name: string, quote: string, source: EntryInput["kind"] extends never ? never : { kind: "narration" } | { kind: "character_claim"; speaker?: string } = narration): EntryInput =>
  ({ kind: "item", review: "auto", op: "appear", tag, name, quote, source });
const person = (name: string) => ({ kind: "person" as const, name });
const place = (text: string) => ({ kind: "place" as const, text });
const inside = (item: Ref) => ({ kind: "inside" as const, item });
type Place = ReturnType<typeof person> | ReturnType<typeof place> | ReturnType<typeof inside> | { kind: "unknown" };
const at = (seq: number, item: Ref, to: Place, quote: string, extra: Record<string, unknown> = {}): EntryInput =>
  ({ kind: "item", review: "auto", op: "at", seq, item, to, quote, source: narration, ...extra }) as EntryInput;
const move = (seq: number, item: Ref, to: Place, quote: string, extra: Record<string, unknown> = {}): EntryInput =>
  ({ kind: "item", review: "auto", op: "move", seq, item, to, quote, source: narration, ...extra }) as EntryInput;
const gone = (seq: number, item: Ref, kind: "lost" | "destroyed", quote: string): EntryInput =>
  ({ kind: "item", review: "auto", op: "gone", seq, item, gone: kind, quote, source: narration });
const census = (seq: number, item: Ref, members: Ref[], complete: boolean, quote: string, extra: Record<string, unknown> = {}): EntryInput =>
  ({ kind: "item", review: "auto", op: "census", seq, item, members, complete, quote, source: narration, ...extra }) as EntryInput;
const N = (tag: string): Ref => ({ tag });
const I = (id: string): Ref => ({ id });

const chapter = (n: number, body: string, entries: readonly EntryInput[], extra: Partial<Parameters<typeof ledgerOf>[0]> = {}): ChapterLedger =>
  ledgerOf({ chapter: n, text: T(n, body), entries, ...extra });
const viewOf = (ledgers: readonly ChapterLedger[], decisions: readonly AuthorDecision[] = [], cards?: SettingCardsFile) =>
  project({ ledgers, decisions, ...(cards ? { cards } : {}) });
const item = (view: ReturnType<typeof viewOf>, id: string): ItemView => {
  const found = view.items.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`没有 ${id}`);
  return found;
};
const decision = (id: string, body: Record<string, unknown>): AuthorDecision => ({ id, at: "x", ...body }) as AuthorDecision;

describe("去向按 seq 走", () => {
  it("6.1 同一句里两次转手：seq 1、2，章末在丙手里", () => {
    const ch1 = chapter(1, "甲把一块表交给乙，乙随即转交给丙。", [
      appear("N1", "表", "甲把一块表交给乙"),
      move(1, N("N1"), person("乙"), "甲把一块表交给乙", { from: person("甲") }),
      move(2, N("N1"), person("丙"), "乙随即转交给丙", { from: person("乙") }),
    ]);
    const view = viewOf([ch1]);
    expect(item(view, "i1-1").now).toMatchObject({ kind: "known", place: { kind: "person", name: "丙" } });
    expect(view.itemIssues).toEqual([]);
  });

  it("6.2 同一个 seq 里同一样东西两条去向：正文没说清先后 → 拿不准，两种都列", () => {
    const ch1 = chapter(1, "表一会儿在乙手里，一会儿又到了丙手里，谁也说不清。", [
      appear("N1", "表", "表一会儿在乙手里"),
      at(1, N("N1"), person("乙"), "表一会儿在乙手里"),
      at(1, N("N1"), person("丙"), "一会儿又到了丙手里"),
    ]);
    const view = viewOf([ch1]);
    const now = item(view, "i1-1").now;
    expect(now).toMatchObject({ kind: "uncertain", reason: "order" });
    expect(now?.kind === "uncertain" && now.options.map((option) => option.kind === "known" && option.place.kind === "person" && option.place.name)).toEqual(["乙", "丙"]);
    expect(view.itemIssues.map((issue) => issue.kind)).toEqual(["order"]);
  });

  it("6.2 同号只管那一组：后一组明写到了丁 → 章末丁、不报；同号两条结果一样 → 照走、不报", () => {
    const resolved = chapter(1, "表一会儿在乙手里，一会儿在丙手里。最后表落到了丁手里。", [
      appear("N1", "表", "表一会儿在乙手里"),
      at(1, N("N1"), person("乙"), "表一会儿在乙手里"),
      at(1, N("N1"), person("丙"), "一会儿在丙手里"),
      move(2, N("N1"), person("丁"), "最后表落到了丁手里"),
    ]);
    const view = viewOf([resolved]);
    expect(item(view, "i1-1").now).toMatchObject({ kind: "known", place: { name: "丁" } });
    expect(item(view, "i1-1").history).toHaveLength(3);
    expect(view.itemIssues).toEqual([]);
    const same = chapter(1, "表在乙手里。乙一直攥着表。", [
      appear("N1", "表", "表在乙手里"),
      at(1, N("N1"), person("乙"), "表在乙手里"),
      at(1, N("N1"), person("乙"), "乙一直攥着表"),
    ]);
    expect(item(viewOf([same]), "i1-1").now).toMatchObject({ kind: "known", place: { name: "乙" } });
    expect(viewOf([same]).itemIssues).toEqual([]);
  });

  it("清点给成员的「在里面」也按组算：同号又写它到了乙手里 → 拿不准，不按数组先后挑", () => {
    for (const order of ["census-first", "move-first"] as const) {
      const entries = [
        census(1, N("N1"), [N("N2")], false, "盒里有一块表"),
        move(1, N("N2"), person("乙"), "表被乙拿走了"),
      ];
      const ch1 = chapter(1, "盒里有一块表。表被乙拿走了。", [
        appear("N1", "木盒", "盒里有一块表"),
        appear("N2", "表", "盒里有一块表"),
        ...(order === "census-first" ? entries : [...entries].reverse()),
      ]);
      const view = viewOf([ch1]);
      expect(item(view, "i1-2").now).toMatchObject({ kind: "uncertain", reason: "order" });
      expect(view.itemIssues.map((issue) => issue.kind)).toEqual(["order"]);
    }
  });

  it("6.3 原句在正文里不止一处、本章有段：不放权（不改现状），有 seq 也一样", () => {
    const body = "他把表放进抽屉。\n\n三年前的冬天，他也把表放进抽屉。\n\n那年雪很大。";
    const ch1 = chapter(1, body, [
      { kind: "time", review: "auto", start: { offset: { unit: "day", min: 1, max: 1 }, basis: "judged", quote: "他把表放进抽屉。" }, segments: [{ frame: "past", firstQuote: "三年前的冬天", lastQuote: "那年雪很大" }] },
      appear("N1", "表", "那年雪很大"),
      move(1, N("N1"), place("抽屉"), "把表放进抽屉"),
    ]);
    const view = viewOf([ch1]);
    expect(item(view, "i1-1").now).toBeUndefined();
    expect(item(view, "i1-1").asides).toHaveLength(1);
  });

  it("6.16 人物说的、回忆里的不改现状；作者的 item.state 压过记账员那章记的", () => {
    const ch1 = chapter(1, "表在乙手里。丙说：“表早给了我。”", [
      appear("N1", "表", "表在乙手里"),
      at(1, N("N1"), person("乙"), "表在乙手里"),
      { ...(at(2, N("N1"), person("丙"), "表早给了我") as object), source: { kind: "character_claim", speaker: "丙" } } as EntryInput,
    ]);
    const view = viewOf([ch1]);
    expect(item(view, "i1-1").now).toMatchObject({ kind: "known", place: { name: "乙" } });
    expect(item(view, "i1-1").asides[0]).toMatchObject({ scope: { source: "character_claim", speaker: "丙" } });
    const ruled = viewOf([ch1], [decision("d-1", { type: "item.state", item: "i1-1", chapter: 1, state: { kind: "at", to: { kind: "person", ref: { mention: "丙" } } } })]);
    expect(item(ruled, "i1-1").now).toMatchObject({ kind: "known", place: { name: "丙" }, entry: "d-1" });
  });

  it("挪动写了从哪来、和前一刻接不上：拿不准 + 去处接不上；只比同一种有编号的（人和人、里面和里面），地方和地方、种类不同都不比", () => {
    const ch1 = chapter(1, "表在乙手里。钥匙在柜台上。伞在乙手里。灯在柜台上。盒在桌上。箱在桌上。针在盒里。", [
      appear("N1", "表", "表在乙手里"),
      appear("N2", "钥匙", "钥匙在柜台上"),
      appear("N3", "伞", "伞在乙手里"),
      appear("N4", "灯", "灯在柜台上"),
      appear("N5", "盒", "盒在桌上"),
      appear("N6", "箱", "箱在桌上"),
      appear("N7", "针", "针在盒里"),
      at(1, N("N1"), person("乙"), "表在乙手里"),
      at(2, N("N2"), place("柜台上"), "钥匙在柜台上"),
      at(3, N("N3"), person("乙"), "伞在乙手里"),
      at(4, N("N4"), place("柜台上"), "灯在柜台上"),
      at(5, N("N5"), place("桌上"), "盒在桌上"),
      at(6, N("N6"), place("桌上"), "箱在桌上"),
      at(7, N("N7"), inside(N("N5")), "针在盒里"),
    ]);
    const ch2 = chapter(2, "丁把表从口袋里掏出来递给戊。他把钥匙从柜台拿起来。丁把伞从门后拿出来。丁把灯放进柜里。丁把针从箱里拿出来。", [
      move(1, I("i1-1"), person("戊"), "丁把表从口袋里掏出来递给戊", { from: person("丁") }),
      move(2, I("i1-2"), person("他"), "他把钥匙从柜台拿起来", { from: place("柜台") }),
      move(3, I("i1-3"), person("丁"), "丁把伞从门后拿出来", { from: place("门后") }),
      move(4, I("i1-4"), place("柜里"), "丁把灯放进柜里", { from: person("丁") }),
      move(5, I("i1-7"), person("丁"), "丁把针从箱里拿出来", { from: inside(I("i1-6")) }),
    ]);
    const view = viewOf([ch1, ch2]);
    expect(item(view, "i1-1").now).toMatchObject({ kind: "uncertain", reason: "from" });
    expect(item(view, "i1-2").now).toMatchObject({ kind: "known", place: { name: "他" } });
    expect(item(view, "i1-3").now).toMatchObject({ kind: "known", place: { name: "丁" } });
    expect(item(view, "i1-4").now).toMatchObject({ kind: "known", place: { text: "柜里" } });
    expect(item(view, "i1-7").now).toMatchObject({ kind: "uncertain", reason: "from" });
    expect(view.itemIssues.map((issue) => issue.kind)).toEqual(["from", "from"]);
  });

  it("同号两处结果一样：每处都核（从哪来接不上、毁了又在），和数组里谁在前无关", () => {
    const ch1 = chapter(1, "表在甲手里。", [appear("N1", "表", "表在甲手里"), at(1, N("N1"), person("甲"), "表在甲手里")]);
    const a = at(1, I("i1-1"), person("丙"), "表到了丙手里");
    const b = move(1, I("i1-1"), person("丙"), "乙把表给了丙", { from: person("乙") });
    for (const order of [[a, b], [b, a]]) {
      const view = viewOf([ch1, chapter(2, "表到了丙手里。乙把表给了丙。", order)]);
      expect(item(view, "i1-1").now).toMatchObject({ kind: "uncertain", reason: "from" });
      expect(view.itemIssues.map((issue) => issue.kind)).toEqual(["from"]);
    }
  });

  it("毁了之后清点又列了它：拿不准 + 一条矛盾（不直接复活）", () => {
    const ch1 = chapter(1, "信烧成了灰。木匣在桌上。", [
      appear("N1", "信", "信烧成了灰"),
      appear("N2", "木匣", "木匣在桌上"),
      gone(1, N("N1"), "destroyed", "信烧成了灰"),
      at(2, N("N2"), place("桌上"), "木匣在桌上"),
    ]);
    const ch2 = chapter(2, "木匣里有一封信。", [census(1, I("i1-2"), [I("i1-1")], false, "木匣里有一封信")]);
    const view = viewOf([ch1, ch2]);
    expect(item(view, "i1-1").now).toMatchObject({ kind: "uncertain", reason: "destroyed" });
    expect(view.itemIssues.map((issue) => issue.kind)).toEqual(["destroyed"]);
  });

  it("头一回写它的那条没了、后文只剩说它的事实：清单里照列，头一回写到算那条事实", () => {
    const ch1 = chapter(1, "天阴着。", []);
    const ch2 = chapter(2, "表盖裂了。", [
      { kind: "fact", review: "auto", nature: "state", subject: "表", attribute: "表盖", value: "裂了", text: "表盖裂了", quote: "表盖裂了", source: narration, item: I("i1-1") } as EntryInput,
    ]);
    const view = viewOf([ch1, ch2]);
    expect(item(view, "i1-1")).toMatchObject({ name: "表", firstSeen: { chapter: 2, quote: "表盖裂了" } });
    expect(item(view, "i1-1").dangling).toBeUndefined();
  });

  it("毁了之后又写它在哪：拿不准 + 一条矛盾", () => {
    const ch1 = chapter(1, "信烧成了灰。", [appear("N1", "信", "信烧成了灰"), gone(1, N("N1"), "destroyed", "信烧成了灰")]);
    const ch2 = chapter(2, "信好端端地躺在桌上。", [at(1, I("i1-1"), place("桌上"), "信好端端地躺在桌上")]);
    const view = viewOf([ch1, ch2]);
    expect(item(view, "i1-1").now).toMatchObject({ kind: "uncertain", reason: "destroyed" });
    expect(view.itemIssues.map((issue) => issue.kind)).toEqual(["destroyed"]);
  });
});

describe("清点", () => {
  const box = (extra: EntryInput[] = []) => chapter(1, "铁盒里只有一封信。他把铁盒放在床底下。", [
    appear("N1", "铁盒", "他把铁盒放在床底下"),
    appear("N2", "信", "铁盒里只有一封信"),
    at(1, N("N1"), place("床底下"), "他把铁盒放在床底下"),
    census(2, N("N1"), [N("N2")], true, "铁盒里只有一封信"),
    ...extra,
  ]);

  it("6.4 完整清点「只有信」，后来从盒里拿出表：清点里没有它，清点改记对不上", () => {
    const ch2 = chapter(2, "他从铁盒里拿出一块表。", [appear("N1", "表", "他从铁盒里拿出一块表"), move(1, N("N1"), person("他"), "他从铁盒里拿出一块表", { from: inside(I("i1-1")) })]);
    const view = viewOf([box(), ch2]);
    expect(view.itemIssues.map((issue) => issue.kind)).toEqual(["not-in-census"]);
    expect(item(view, "i1-1").census).toMatchObject({ status: "conflict" });
  });

  it("完整清点「什么也没有」，后来写他从盒里拿出表看完又放回去（前一刻表在他手里）：拿出来就反证了清点，放回去也不算完整", () => {
    const ch1 = chapter(1, "表在他手里。盒子是空的。", [
      appear("N1", "表", "表在他手里"),
      appear("N2", "盒子", "盒子是空的"),
      at(1, N("N1"), person("他"), "表在他手里"),
      census(2, N("N2"), [], true, "盒子是空的"),
    ]);
    const ch2 = chapter(2, "他从盒里取出表，看完又放回盒里。", [
      move(1, I("i1-1"), inside(I("i1-2")), "他从盒里取出表，看完又放回盒里", { from: inside(I("i1-2")) }),
    ]);
    const view = viewOf([ch1, ch2]);
    expect(view.itemIssues.map((issue) => issue.kind)).toEqual(["not-in-census"]);
    expect(item(view, "i1-2").census).toMatchObject({ status: "conflict" });
  });

  it("6.5 没列全的清点（盒里有信），后来从盒里拿出表：不报", () => {
    const ch1 = chapter(1, "铁盒里有一封信。", [appear("N1", "铁盒", "铁盒里有一封信"), appear("N2", "信", "铁盒里有一封信"), census(1, N("N1"), [N("N2")], false, "铁盒里有一封信")]);
    const ch2 = chapter(2, "他从铁盒里拿出一块表。", [appear("N1", "表", "他从铁盒里拿出一块表"), move(1, N("N1"), person("他"), "他从铁盒里拿出一块表", { from: inside(I("i1-1")) })]);
    const view = viewOf([ch1, ch2]);
    expect(view.itemIssues).toEqual([]);
    expect(item(view, "i1-1").census).toBeUndefined();
    expect(item(view, "i1-1").inside).toEqual(["i1-2"]);
  });

  it("6.6 完整清点后有一章账待记：此后没核全，取出没列的不报、不当完整", () => {
    const ch2 = ledgerOf({ chapter: 2, text: T(2, "过了几天。"), entries: [], status: "pending" });
    const ch3 = chapter(3, "他从铁盒里拿出一块表。", [appear("N1", "表", "他从铁盒里拿出一块表"), move(1, N("N1"), person("他"), "他从铁盒里拿出一块表", { from: inside(I("i1-1")) })]);
    const view = viewOf([box(), ch2, ch3]);
    expect(view.itemIssues).toEqual([]);
    expect(item(view, "i1-1").census).toMatchObject({ status: "unverified", since: 2 });
    expect(item(view, "i1-2")).toMatchObject({ now: { kind: "known", place: { kind: "inside", item: "i1-1" } }, unverifiedSince: 2 });
  });

  it("6.7 同章先记钥匙在盒里、再清点只有信：清点对不上，两边证据都在", () => {
    const ch1 = chapter(1, "他把钥匙放进铁盒。铁盒里只有一封信。", [
      appear("N1", "铁盒", "他把钥匙放进铁盒"),
      appear("N2", "钥匙", "他把钥匙放进铁盒"),
      appear("N3", "信", "铁盒里只有一封信"),
      move(1, N("N2"), inside(N("N1")), "他把钥匙放进铁盒"),
      census(2, N("N1"), [N("N3")], true, "铁盒里只有一封信"),
    ]);
    const view = viewOf([ch1]);
    expect(item(view, "i1-1").census).toMatchObject({ status: "conflict" });
    expect(view.itemIssues[0]).toMatchObject({ kind: "census", entries: ["c1-5", "c1-4"] });
    expect(item(view, "i1-2").now).toMatchObject({ kind: "known", place: { kind: "inside", item: "i1-1" } });
  });

  it("6.8 盒子在甲手里，正文只清点「盒里有表」：表在盒里；读回声明再交，往返不丢", () => {
    const entries = [
      appear("N1", "木盒", "甲捧着木盒"),
      appear("N2", "表", "盒里有一块表"),
      at(1, N("N1"), person("甲"), "甲捧着木盒"),
      census(2, N("N1"), [N("N2")], false, "盒里有一块表"),
    ];
    const ch1 = chapter(1, "甲捧着木盒。盒里有一块表。", entries);
    const view = viewOf([ch1]);
    expect(item(view, "i1-2").now).toMatchObject({ kind: "known", place: { kind: "inside", item: "i1-1" } });
    expect(item(view, "i1-1").now).toMatchObject({ kind: "known", place: { kind: "person", name: "甲" } });
    const again = ledgerOf({ chapter: 1, text: T(1, "甲捧着木盒。盒里有一块表。"), entries: declarationsOf(ch1) });
    expect(again.entries).toEqual(ch1.entries);
  });

  it("6.9 完整清点后成员不知道在哪了 / 丢了：清点此后没核全", () => {
    for (const later of [at(1, I("i1-2"), { kind: "unknown" }, "信不知去了哪里"), gone(1, I("i1-2"), "lost", "信不知去了哪里")]) {
      const ch2 = chapter(2, "信不知去了哪里。", [later]);
      const view = viewOf([box(), ch2]);
      expect(item(view, "i1-1").census).toMatchObject({ status: "unverified", since: 2 });
    }
    const ch2 = chapter(2, "他把信交给了乙。", [move(1, I("i1-2"), person("乙"), "他把信交给了乙")]);
    expect(item(viewOf([box(), ch2]), "i1-1").census).toMatchObject({ status: "valid", members: [] });
  });

  it("完整清点之后记全了的挪进挪出照算，清点照样有效", () => {
    const ch2 = chapter(2, "他把表放进铁盒，又把信拿出来交给乙。", [
      appear("N1", "表", "他把表放进铁盒"),
      move(1, N("N1"), inside(I("i1-1")), "他把表放进铁盒"),
      move(2, I("i1-2"), person("乙"), "又把信拿出来交给乙", { from: inside(I("i1-1")) }),
    ]);
    const view = viewOf([box(), ch2]);
    expect(item(view, "i1-1").census).toMatchObject({ status: "valid", members: ["i2-1"] });
    expect(view.itemIssues).toEqual([]);
  });

  it("同一个 seq 里有它的清点、又有挪进它的：清点不再当完整用", () => {
    const ch2 = chapter(2, "盒里就剩信了，他又塞进一块表。", [
      appear("N1", "表", "他又塞进一块表"),
      census(1, I("i1-1"), [I("i1-2")], true, "盒里就剩信了"),
      move(1, N("N1"), inside(I("i1-1")), "他又塞进一块表"),
    ]);
    expect(item(viewOf([box(), ch2]), "i1-1").census).toMatchObject({ status: "unverified" });
  });

  it("6.19 完整清点「只有信」之后，只是开放清点 / 写它此刻在盒里（没记放进去）：表在盒里，清点里没有它、对不上；作者放进去的 → 此后没核全", () => {
    const observed = [
      census(1, I("i1-1"), [N("N1")], false, "盒里有一块表"),
      at(1, N("N1"), inside(I("i1-1")), "盒里有一块表"),
    ];
    for (const entry of observed) {
      const ch2 = chapter(2, "盒里有一块表。", [appear("N1", "表", "盒里有一块表"), entry]);
      const view = viewOf([box(), ch2]);
      expect(item(view, "i2-1").now).toMatchObject({ kind: "known", place: { kind: "inside", item: "i1-1" } });
      expect(view.itemIssues.map((issue) => issue.kind)).toEqual(["not-in-census"]);
      expect(item(view, "i1-1").census).toMatchObject({ status: "conflict" });
    }
    const ch2 = chapter(2, "他手里有一块表。", [appear("N1", "表", "他手里有一块表"), at(1, N("N1"), person("他"), "他手里有一块表")]);
    const ruled = viewOf([box(), ch2], [decision("d-1", { type: "item.state", item: "i2-1", chapter: 2, state: { kind: "at", to: { kind: "inside", ref: { id: "i1-1" } } } })]);
    expect(ruled.itemIssues).toEqual([]);
    expect(item(ruled, "i1-1").census).toMatchObject({ status: "unverified", since: 2 });
    expect(item(ruled, "i2-1").now).toMatchObject({ kind: "known", place: { kind: "inside", item: "i1-1" }, entry: "d-1" });
  });

  it("6.21 完整清点 → 一章账待记 → 新完整清点「空了」：新清点有效、不报；缺账前在里面的信改成不知道在哪了，旧去向在历史", () => {
    const ch2 = ledgerOf({ chapter: 2, text: T(2, "过了几天。"), entries: [], status: "pending" });
    const ch3 = chapter(3, "铁盒空了。", [census(1, I("i1-1"), [], true, "铁盒空了")]);
    const view = viewOf([box(), ch2, ch3]);
    expect(view.itemIssues).toEqual([]);
    expect(item(view, "i1-1").census).toMatchObject({ status: "valid", chapter: 3, members: [] });
    expect(item(view, "i1-2").now).toMatchObject({ kind: "unknown", chapter: 3, entry: "c3-1" });
    expect(item(view, "i1-2").unverifiedSince).toBeUndefined();
    expect(item(view, "i1-2").history[0]).toMatchObject({ chapter: 1, entry: "c1-4" });
    // 中间都记全了的：照旧对不上。
    const ch2full = chapter(2, "过了几天。", []);
    expect(item(viewOf([box(), ch2full, ch3]), "i1-1").census).toMatchObject({ status: "conflict" });
  });

  it("6.13 作者改：误闭合改开放（撤回 / 作者给没列全的清点）、毁了改丢了；撤掉这些裁定原状回来，容器自己在哪不变", () => {
    const ledgers = [box()];
    expect(item(viewOf(ledgers), "i1-1").census).toMatchObject({ status: "valid" });
    const retracted = viewOf(ledgers, [decision("d-1", { type: "item.retract", entry: "c1-4" })]);
    expect(item(retracted, "i1-1").census).toBeUndefined();
    const opened = viewOf(ledgers, [decision("d-1", { type: "item.state", item: "i1-1", chapter: 1, state: { kind: "census", members: [{ id: "i1-2" }], complete: false } })]);
    expect(item(opened, "i1-1").census).toBeUndefined();
    expect(item(opened, "i1-1").now).toMatchObject({ kind: "known", place: { kind: "place", text: "床底下" } });
    expect(item(opened, "i1-2").now).toMatchObject({ kind: "known", place: { kind: "inside", item: "i1-1" } });

    const burnt = chapter(2, "信烧成了灰。", [gone(1, I("i1-2"), "destroyed", "信烧成了灰")]);
    const lost = viewOf([...ledgers, burnt], [decision("d-1", { type: "item.retract", entry: "c2-1" }), decision("d-2", { type: "item.state", item: "i1-2", chapter: 2, state: { kind: "gone", gone: "lost" } })]);
    expect(item(lost, "i1-2").now).toMatchObject({ kind: "gone", gone: "lost", entry: "d-2" });
    expect(item(viewOf([...ledgers, burnt]), "i1-2").now).toMatchObject({ kind: "gone", gone: "destroyed" });
  });

  it("作者同一章既定盒子在哪、又定里面有什么：两方面各管各的，谁先定都一样", () => {
    const where = decision("d-1", { type: "item.state", item: "i1-1", chapter: 1, state: { kind: "at", to: { kind: "person", ref: { mention: "乙" } } } });
    const contents = decision("d-2", { type: "item.state", item: "i1-1", chapter: 1, state: { kind: "census", members: [{ id: "i1-2" }], complete: true } });
    for (const decisions of [[where, contents], [contents, where]]) {
      const view = viewOf([box()], decisions);
      expect(item(view, "i1-1").now).toMatchObject({ kind: "known", place: { kind: "person", name: "乙" }, entry: "d-1" });
      expect(item(view, "i1-1").census).toMatchObject({ entry: "d-2", status: "valid", members: ["i1-2"] });
    }
  });

  it("容器毁了（同一组里、之后哪章都一样）：清点不再当完整用", () => {
    const sameGroup = chapter(2, "铁盒里只有一封信，铁盒烧了。", [census(1, I("i1-1"), [I("i1-2")], true, "铁盒里只有一封信"), gone(1, I("i1-1"), "destroyed", "铁盒烧了")]);
    expect(item(viewOf([box(), sameGroup]), "i1-1").census).toMatchObject({ status: "unverified", since: 2 });
    const tied = chapter(2, "铁盒里只有一封信，铁盒烧了，铁盒在甲手里。", [census(1, I("i1-1"), [I("i1-2")], true, "铁盒里只有一封信"), gone(1, I("i1-1"), "destroyed", "铁盒烧了"), at(1, I("i1-1"), person("甲"), "铁盒在甲手里")]);
    const tiedView = viewOf([box(), tied]);
    expect(item(tiedView, "i1-1").now).toMatchObject({ kind: "uncertain", reason: "order" });
    expect(item(tiedView, "i1-1").census).toMatchObject({ status: "unverified", since: 2 });
    const later = chapter(2, "铁盒烧了。", [gone(1, I("i1-1"), "destroyed", "铁盒烧了")]);
    expect(item(viewOf([box(), later]), "i1-1").census).toMatchObject({ status: "unverified", since: 2 });
  });

  it("清点之后成员丢了：清点此后没核全，那次清点列的照留（不改成「空了」）", () => {
    const ch2 = chapter(2, "信不见了。", [gone(1, I("i1-2"), "lost", "信不见了")]);
    expect(item(viewOf([box(), ch2]), "i1-1").census).toMatchObject({ chapter: 1, status: "unverified", since: 2, listed: ["i1-2"] });
  });

  it("装在里面绕成圈：报结构冲突", () => {
    const ch1 = chapter(1, "大盒装进小盒，小盒又装进大盒。", [
      appear("N1", "大盒", "大盒装进小盒"),
      appear("N2", "小盒", "小盒又装进大盒"),
      move(1, N("N1"), inside(N("N2")), "大盒装进小盒"),
      move(2, N("N2"), inside(N("N1")), "小盒又装进大盒"),
    ]);
    expect(viewOf([ch1]).itemIssues.map((issue) => issue.kind)).toContain("cycle");
  });
});

describe("身份：归并、拆开、同名、事实", () => {
  const cards = (): SettingCardsFile => ({ ...emptySettingCards(), cards: [{ id: "k-watch", kind: "item", name: "许兰的表", aliases: [], fields: [], by: "author", at: "x" }] });

  it("6.11 归并表 A 进卡号：容器成员、事实主体都跟着解析", () => {
    const ch1 = chapter(1, "抽屉里有一块旧表，表壳刻着字。", [
      appear("N1", "抽屉", "抽屉里有一块旧表"),
      appear("N2", "旧表", "抽屉里有一块旧表"),
      census(1, N("N1"), [N("N2")], false, "抽屉里有一块旧表"),
      { kind: "fact", review: "auto", nature: "hard", subject: "旧表", attribute: "表壳", value: "刻着字", item: N("N2"), text: "表壳刻着字", quote: "表壳刻着字", source: narration },
    ]);
    const merged = viewOf([ch1], [decision("d-1", { type: "item.merge", from: ["i1-2"], into: "k-watch" })], cards());
    expect(item(merged, "k-watch")).toMatchObject({ name: "许兰的表", mergedFrom: ["i1-2"], now: { kind: "known", place: { kind: "inside", item: "i1-1" } } });
    expect(merged.items.some((view) => view.id === "i1-2")).toBe(false);
    expect(merged.facts.find((fact) => fact.id === "c1-4")).toMatchObject({ item: "k-watch", subject: "许兰的表", subjectKey: "item:k-watch" });
  });

  it("6.12 拆开：只拆容器成员那一处，盒子主体不动", () => {
    const ch1 = chapter(1, "表在乙手里。抽屉里也有一块表。", [
      appear("N1", "表", "表在乙手里"),
      appear("N2", "抽屉", "抽屉里也有一块表"),
      at(1, N("N1"), person("乙"), "表在乙手里"),
      census(2, N("N2"), [N("N1")], false, "抽屉里也有一块表"),
    ]);
    const split = viewOf([ch1], [decision("d-1", { type: "item.split", item: "i1-1", refs: [{ entry: "c1-4", at: "member", index: 0 }], name: "抽屉里那块表" })]);
    expect(item(split, "i1-1").now).toMatchObject({ kind: "known", place: { name: "乙" } });
    expect(item(split, "x-d-1")).toMatchObject({ name: "抽屉里那块表", now: { kind: "known", place: { kind: "inside", item: "i1-2" } } });
  });

  it("同名两样两个号：特征按编号成格子，各算各的、不报矛盾", () => {
    const ch1 = chapter(1, "崔家的表是梅花牌。许家的表是上海牌。", [
      appear("N1", "表", "崔家的表是梅花牌"),
      appear("N2", "表", "许家的表是上海牌"),
      { kind: "fact", review: "auto", nature: "hard", subject: "表", attribute: "牌子", value: "梅花", item: N("N1"), text: "崔家的表是梅花牌", quote: "崔家的表是梅花牌", source: narration },
      { kind: "fact", review: "auto", nature: "hard", subject: "表", attribute: "牌子", value: "上海", item: N("N2"), text: "许家的表是上海牌", quote: "许家的表是上海牌", source: narration },
    ]);
    const view = viewOf([ch1]);
    expect(view.conflicts).toEqual([]);
    expect(view.subjects.filter((subject) => subject.item !== undefined).map((subject) => subject.key)).toEqual(["item:i1-1", "item:i1-2"]);
  });

  it("没有一条证明它存在、只被装在里面用到的：摆进 dangling", () => {
    const ch2 = chapter(2, "他把表放进铁盒。", [appear("N1", "表", "他把表放进铁盒"), move(1, N("N1"), inside(I("i1-9")), "他把表放进铁盒")]);
    const view = viewOf([ch2]);
    expect(item(view, "i1-9").dangling).toBe(true);
    expect(view.dangling).toContainEqual(expect.objectContaining({ kind: "item", ref: "i1-9" }));
  });
});

describe("旧记法", () => {
  const legacy = (): ChapterLedger => {
    const ledger = ledgerOf({
      chapter: 1,
      text: T(1, "借据在沈知秋身上。表和信都在盒里。"),
      entries: [
        { kind: "fact", review: "auto", nature: "state", subject: "借据", attribute: "在谁手里", value: "沈知秋", text: "借据在沈知秋身上", quote: "借据在沈知秋身上" },
        { kind: "fact", review: "auto", nature: "state", subject: "表和信", attribute: "在哪", value: "盒里", text: "表和信都在盒里", quote: "表和信都在盒里" },
      ],
    });
    const { itemModel: _itemModel, ...rest } = ledger;
    return rest as ChapterLedger;
  };

  it("6.15 只说一样的旧事实被 replaces 顶掉；一句说几样的 overlaps 不顶、记没逐样对齐；撤回新条目旧的重新当现状", () => {
    const ch2 = chapter(2, "借据还在沈知秋身上。他把表交给了乙。", [
      appear("N1", "借据", "借据还在沈知秋身上"),
      appear("N2", "表", "他把表交给了乙"),
      at(1, N("N1"), person("沈知秋"), "借据还在沈知秋身上", { replaces: ["c1-1"] }),
      move(2, N("N2"), person("乙"), "他把表交给了乙", { overlaps: ["c1-2"] }),
    ]);
    const view = viewOf([legacy(), ch2]);
    expect(view.facts.find((fact) => fact.id === "c1-1")).toMatchObject({ status: "superseded", supersededBy: "c2-3" });
    expect(view.facts.find((fact) => fact.id === "c1-2")).toMatchObject({ status: "current", unaligned: ["i2-2"] });
    expect(view.chapters[0]).toMatchObject({ itemsLegacy: true });
    const undone = viewOf([legacy(), ch2], [decision("d-1", { type: "item.retract", entry: "c2-3" }), decision("d-2", { type: "item.retract", entry: "c2-4" })]);
    expect(undone.facts.find((fact) => fact.id === "c1-1")).toMatchObject({ status: "current" });
    expect(undone.facts.find((fact) => fact.id === "c1-2")?.unaligned).toBeUndefined();
  });

  it("6.15 只在清点里出现的成员、作者 item.state 也能关联旧事实：不顶、记没逐样对齐；撤掉作者那条，旧事实回到原样", () => {
    const ch2 = chapter(2, "乙的木盒里有一块表。", [
      appear("N1", "木盒", "乙的木盒里有一块表"),
      appear("N2", "表", "乙的木盒里有一块表"),
      census(1, N("N1"), [{ tag: "N2", overlaps: ["c1-2"] } as Ref], false, "乙的木盒里有一块表"),
    ]);
    const view = viewOf([legacy(), ch2]);
    expect(view.facts.find((fact) => fact.id === "c1-2")).toMatchObject({ status: "current", unaligned: ["i2-2"] });
    expect(item(view, "i2-2").now).toMatchObject({ kind: "known", place: { kind: "inside", item: "i2-1" } });

    const ch2b = chapter(2, "过了几天，乙看了一眼那块表。", [appear("N1", "表", "乙看了一眼那块表")]);
    const ruling = decision("d-1", { type: "item.state", item: "i2-1", chapter: 2, state: { kind: "at", to: { kind: "person", ref: { mention: "乙" } } }, overlaps: ["c1-2"], replaces: ["c1-1"] });
    const ruled = viewOf([legacy(), ch2b], [ruling]);
    expect(ruled.facts.find((fact) => fact.id === "c1-2")).toMatchObject({ status: "current", unaligned: ["i2-1"] });
    expect(ruled.facts.find((fact) => fact.id === "c1-1")).toMatchObject({ status: "superseded", supersededBy: "d-1" });
    const undone = viewOf([legacy(), ch2b]);
    expect(undone.facts.find((fact) => fact.id === "c1-2")?.unaligned).toBeUndefined();
    expect(undone.facts.find((fact) => fact.id === "c1-1")).toMatchObject({ status: "current" });
  });

  it("东西账在旧记法的章之后算此后没核全", () => {
    const ch1 = chapter(1, "表在乙手里。", [appear("N1", "表", "表在乙手里"), at(1, N("N1"), person("乙"), "表在乙手里")]);
    const { itemModel: _itemModel, ...old } = ledgerOf({ chapter: 2, text: T(2, "过了几天。"), entries: [] });
    const view = viewOf([ch1, old as ChapterLedger]);
    expect(item(view, "i1-1").unverifiedSince).toBe(2);
  });
});

describe("悬空的东西（设计 3.3：重定稿删了唯一的出处）", () => {
  // 第 1 章重定稿后没再认上表（appear 没了），第 2 章那条完整清点还写着「盒里只有表」：用不上它，也不是空盒。
  const ch1 = chapter(1, "甲手里拿着一个木盒。", [appear("N1", "木盒", "甲手里拿着一个木盒"), at(1, N("N1"), person("甲"), "甲手里拿着一个木盒")]);
  const ch2 = chapter(2, "木盒里只有那块表。表和信原先都在柜里。", [census(1, I("i1-1"), [I("i1-2")], true, "木盒里只有那块表")]);
  it("清点不再当完整、表不从清点复活、记一条 dangling 问题", () => {
    const view = viewOf([ch1, ch2]);
    const box = item(view, "i1-1");
    expect(box.census).toBeUndefined();
    expect(box.inside).toEqual([]);
    expect(box.history.at(-1)).toMatchObject({ op: "census", members: [], complete: false });
    const watch = item(view, "i1-2");
    expect(watch).toMatchObject({ dangling: true, history: [] });
    expect(watch.now).toBeUndefined();
    expect(view.itemIssues).toEqual([expect.objectContaining({ kind: "dangling", item: "i1-1", chapter: 2 })]);
    expect(view.dangling).toContainEqual(expect.objectContaining({ kind: "item", ref: "i1-2" }));
  });
  it("装进悬空东西里的去向记成不知道；悬空成员带的旧记法关联不生效", () => {
    const legacy = chapter(1, "表和信原先都在柜里。", [{ kind: "fact", review: "auto", nature: "state", subject: "表和信", attribute: "在哪", value: "柜里", text: "表和信都在柜里", quote: "表和信原先都在柜里" }]);
    const ch2b = chapter(2, "信塞进了那个铁盒。木盒里只有那块表。", [
      appear("N1", "信", "信塞进了那个铁盒"),
      appear("N2", "木盒", "木盒里只有那块表"),
      move(1, N("N1"), inside(I("i9-9")), "信塞进了那个铁盒", { replaces: ["c1-1"] }),
      census(2, N("N2"), [{ id: "i9-8", overlaps: ["c1-1"] } as Ref], true, "木盒里只有那块表"),
    ]);
    const view = viewOf([legacy, ch2b]);
    expect(item(view, "i2-1").now).toMatchObject({ kind: "unknown", chapter: 2 });
    expect(view.facts.find((fact) => fact.id === "c1-1")).toMatchObject({ status: "current" });
    expect(view.facts.find((fact) => fact.id === "c1-1")?.unaligned).toBeUndefined();
    expect(view.itemIssues.map((issue) => [issue.kind, issue.item])).toEqual([["dangling", "i2-1"], ["dangling", "i2-2"]]);
  });
  it("作者裁定指着悬空的东西：不生效、进悬空", () => {
    const ruling = decision("d-1", { type: "item.state", item: "i1-1", chapter: 2, state: { kind: "census", members: [{ id: "i1-2" }], complete: true } });
    const view = viewOf([ch1, chapter(2, "过了几天。", [])], [ruling]);
    expect(item(view, "i1-1").census).toBeUndefined();
    expect(view.dangling).toContainEqual(expect.objectContaining({ kind: "item", ref: "i1-2", source: "d-1" }));
    expect(view.itemIssues).toContainEqual(expect.objectContaining({ kind: "dangling", item: "i1-1", chapter: 2, entries: ["d-1"] }));
  });
});
