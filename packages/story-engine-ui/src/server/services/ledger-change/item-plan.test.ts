// @vitest-environment node
/**
 * 改账里东西那四种（写作版本 P3b 设计 2.7）：按名字找东西（同名如实列）→ 裁定草案 → 作者档记下 → 投影跟着变。
 * 执行器那一层（停下等「确认改账」、依据变了作废）和别的改账同一套，见 ledger-change.test.ts。
 */
import { rm } from "node:fs/promises";
import { chapterCommit, decisionRecord, project, readBookSnapshot, runCommand, type EntryInput } from "@actalk/story-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHomeTempDir } from "../../lib/home-test-tmp.js";
import { planLedgerRequests, readLedgerRequest } from "./plan.js";

const narration = { kind: "narration" as const };
const appear = (tag: string, name: string, quote: string): EntryInput => ({ kind: "item", review: "auto", op: "appear", tag, name, quote, source: narration });
const at = (seq: number, item: { id: string } | { tag: string }, to: Record<string, unknown>, quote: string): EntryInput =>
  ({ kind: "item", review: "auto", op: "at", seq, item, to, quote, source: narration }) as EntryInput;

/** 编号只给程序用，给人看的话里一个都不许出现。 */
const RAW_ID = /\b[icx]\d*-\d/u;

let dir: string;
beforeEach(async () => {
  dir = await makeHomeTempDir("item-plan-");
  const commit = async (chapter: number, text: string, entries: EntryInput[]) => {
    const outcome = await runCommand(dir, chapterCommit, { chapter, text: `# 第${chapter}章\n\n${text}`, entries }, { caller: "author", idempotencyKey: `c${chapter}` });
    if (!outcome.ok || outcome.result.rejected.length > 0) throw new Error(outcome.ok ? JSON.stringify(outcome.result.rejected) : outcome.message);
  };
  await commit(1, "甲手里攥着一块表。乙的桌上也放着一块表。", [
    appear("N1", "表", "甲手里攥着一块表"),
    appear("N2", "表", "乙的桌上也放着一块表"),
    at(1, { tag: "N1" }, { kind: "person", name: "甲" }, "甲手里攥着一块表"),
    at(1, { tag: "N2" }, { kind: "place", text: "乙的桌上" }, "乙的桌上也放着一块表"),
  ]);
  await commit(2, "甲把怀表塞进抽屉。抽屉里还有一封信。", [
    appear("N1", "怀表", "甲把怀表塞进抽屉"),
    appear("N2", "信", "抽屉里还有一封信"),
    at(1, { tag: "N1" }, { kind: "place", text: "抽屉" }, "甲把怀表塞进抽屉"),
    at(2, { tag: "N2" }, { kind: "place", text: "抽屉" }, "抽屉里还有一封信"),
  ]);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function plan(raw: Record<string, unknown>) {
  const snapshot = await readBookSnapshot(dir);
  const request = readLedgerRequest(raw);
  if (!request) throw new Error("请求没读出来");
  return planLedgerRequests(project(snapshot), [request], snapshot.ledgers);
}

async function apply(decisions: readonly unknown[], key: string) {
  const outcome = await runCommand(dir, decisionRecord, { decisions } as never, { caller: "author", idempotencyKey: key });
  if (!outcome.ok) throw new Error(outcome.message);
  return project(await readBookSnapshot(dir));
}

describe("改账：东西", () => {
  it("同名两样：如实列出来让作者点明，不挑一样", async () => {
    const planned = await plan({ op: "itemState", query: "表", chapter: 2, where: { person: "乙" } });
    expect(planned.decisions).toEqual([]);
    expect(planned.notDone).toEqual(["「表」对得上 2 样东西：「表（「甲手里攥着一块表」那件）」、「表（「乙的桌上也放着一…」那件）」，请说清是哪一样"]);
  });

  it("并成一样：怀表就是甲那块表；之后账里写怀表的地方都算它", async () => {
    // 照候选里给的带区分的说法点明。
    const view = project(await readBookSnapshot(dir));
    const first = view.items.find((item) => item.firstSeen?.quote === "甲手里攥着一块表")!;
    const merged = await plan({ op: "itemMerge", groups: [["表（「甲手里攥着一块表」那件）", "怀表"]] });
    expect(merged.lines).toEqual(["把「怀表」并进「表（「甲手里攥着一块表」那件）」（账里写它的地方都算同一样）"]);
    const after = await apply(merged.decisions, "merge");
    expect(after.items.find((item) => item.id === first.id)).toMatchObject({ now: { kind: "known", place: { kind: "place", text: "抽屉" }, chapter: 2 } });
    expect(after.items.some((item) => item.name === "怀表")).toBe(false);
  });

  it("拆开：第 2 章那封信其实是两样里的另一样；按位置拆、撤回那条、作者定在哪，给人看的话里没有编号", async () => {
    const split = await plan({ op: "itemSplit", query: "信", chapter: 2, text: "密信" });
    expect(split.lines).toEqual(["第 2 章写的「信」（1 处）不是那一样，另记成「密信」"]);
    const afterSplit = await apply(split.decisions, "split");
    expect(afterSplit.items.find((item) => item.name === "密信")).toMatchObject({ now: { kind: "known", place: { kind: "place", text: "抽屉" } } });

    const retract = await plan({ op: "itemRetract", query: "怀表", chapter: 2 });
    expect(retract.lines).toEqual(["第 2 章「怀表：在抽屉」这条记错了，不算"]);
    const afterRetract = await apply(retract.decisions, "retract");
    expect(afterRetract.items.find((item) => item.name === "怀表")?.now).toBeUndefined();

    const state = await plan({ op: "itemState", query: "怀表", chapter: 2, where: { inside: "密信" } });
    expect(state.lines).toEqual(["到第 2 章末，「怀表」在密信里（以你定的为准）"]);
    const afterState = await apply(state.decisions, "state");
    const container = afterState.items.find((item) => item.name === "密信")!;
    expect(afterState.items.find((item) => item.name === "怀表")?.now).toMatchObject({ kind: "known", place: { kind: "inside", item: container.id } });

    for (const line of [...split.lines, ...retract.lines, ...state.lines]) expect(line).not.toMatch(RAW_ID);
  });

  it("作者定清点、丢了；去处说两种、没说如实问", async () => {
    const census = await plan({ op: "itemState", query: "怀表", chapter: 2, members: [], complete: true });
    expect(census.lines).toEqual(["到第 2 章末，「怀表」里面空了（以你定的为准）"]);
    const lost = await plan({ op: "itemState", query: "信", chapter: 2, where: { gone: "lost" } });
    expect(lost.decisions).toEqual([expect.objectContaining({ type: "item.state", state: { kind: "gone", gone: "lost" } })]);
    expect((await plan({ op: "itemState", query: "信", chapter: 2, where: { person: "甲", place: "抽屉" } })).notDone).toEqual(["去处只能说一种"]);
    expect((await plan({ op: "itemState", query: "信", chapter: 2 })).notDone[0]).toContain("它在哪？说一种");
    expect((await plan({ op: "itemRetract", query: "信" })).notDone).toEqual(["「信」是第几章那条记错了？"]);
    expect((await plan({ op: "itemState", query: "烟斗", chapter: 2, where: { person: "甲" } })).notDone).toEqual(["账里没找到叫「烟斗」的东西"]);
  });
});
