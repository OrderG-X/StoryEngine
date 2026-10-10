// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildLedgerChecklist, excludeFromCommitPlan, splitExclusions } from "./ledger-checklist.js";

const plan = {
  calendar: { storyDay: 3 },
  hookTrackingUpdates: [
    { id: "hook-a1", title: "铜钥匙的来历", status: "active", firstSeenChapter: 5, evidence: ["她摸出一把铜钥匙。"] },
    { id: "hook-b2", title: "旧信", status: "resolved", firstSeenChapter: 2, evidence: ["信终于拆开了。"] },
  ],
  threadTrackingUpdates: [{ id: "intent-c3", type: "intent", title: "去码头找老周", status: "open", firstSeenChapter: 4, evidence: [] }],
  arcGoalUpdates: [{ id: "arc-d4", title: "查清火灾", status: "touched", firstSeenChapter: 1, evidence: ["火灾那晚的事。"] }],
  hookUpdates: [{ hookId: "hook-b2", status: "resolved" }],
  worldUpdates: { activeHooks: ["hook-a1", "hook-b2"] },
};

const facts = {
  ok: true,
  adds: [{ text: "铜钥匙在林溪手里", quote: "她摸出一把铜钥匙。" }, { text: "老周住在码头" }],
  changes: [{ factId: "fact-9", oldText: "信没拆", newText: "信拆开了", quote: "信终于拆开了。" }],
  conflicts: [{ old: "第2章「信在抽屉里」", quote: "信在她兜里。", note: "" }],
  newCharacters: ["阿满"],
};

describe("定稿前的账本清单", () => {
  it("逐条列成人话：第几天、伏笔新开 / 收回、人物打算、目标推进、记下的事实、改记；对不上和新人物只提示", () => {
    const items = buildLedgerChecklist({ chapter: 5, plan, facts });
    expect(items.map((item) => item.label)).toEqual([
      "这一章记为故事第 3 天",
      "新伏笔：铜钥匙的来历",
      "收回伏笔：旧信",
      "推进人物打算：去码头找老周",
      "推进目标：查清火灾",
      "记下：铜钥匙在林溪手里",
      "记下：老周住在码头",
      "改记：「信没拆」→「信拆开了」",
      "和旧设定对不上（账本不动，你定）：第2章「信在抽屉里」",
      "新出现的人物（不建卡，要建就说一声）：阿满",
    ]);
    expect(items.filter((item) => !item.removable).map((item) => item.kind)).toEqual(["day", "conflict", "new_character"]);
    expect(items.find((item) => item.id === "hook:hook-a1")?.detail).toBe("她摸出一把铜钥匙。");
  });

  it("没抽成事实就只列计划里的", () => {
    const items = buildLedgerChecklist({ chapter: 5, plan, facts: { ...facts, ok: false } });
    expect(items.some((item) => item.kind === "fact")).toBe(false);
  });

  it("勾掉的伏笔从计划里拿掉：跟踪更新、状态更新、活跃伏笔都不留；其它不动", () => {
    const exclusions = splitExclusions(["hook:hook-b2", "thread:intent-c3", "fact:1", "change:fact-9", "乱写的"]);
    expect([...exclusions.facts.adds!]).toEqual([1]);
    expect([...exclusions.facts.changes!]).toEqual(["fact-9"]);
    const next = excludeFromCommitPlan(plan, exclusions);
    expect(next.hookTrackingUpdates.map((update) => update.id)).toEqual(["hook-a1"]);
    expect(next.hookUpdates).toEqual([]);
    expect(next.worldUpdates.activeHooks).toEqual(["hook-a1"]);
    expect(next.threadTrackingUpdates).toEqual([]);
    expect(next.arcGoalUpdates).toHaveLength(1);
    expect(excludeFromCommitPlan(plan, splitExclusions([]))).toBe(plan);
  });
});
