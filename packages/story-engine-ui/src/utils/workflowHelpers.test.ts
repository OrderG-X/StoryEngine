import { describe, expect, it } from "vitest";
import { ledgerConfirmAction, suggestedAction, withAuthorButton } from "./workflowHelpers.js";

describe("suggestedAction", () => {
  it("returns action with correct label", () => {
    expect(suggestedAction("generate-steering").label).toBe("生成本章方案");
    expect(suggestedAction("quality-check").label).toBe("硬伤检查");
    expect(suggestedAction("commit-apply").label).toBe("确认定稿");
  });

  it("falls back to generate-steering for unknown id", () => {
    expect(suggestedAction("nonexistent" as any).id).toBe("generate-steering");
  });
});

describe("withAuthorButton（一轮里同一种作者档按钮合成一个）", () => {
  it("一轮提了两次改账 → 一个「确认改账」带两次的裁定，标识拼起来", () => {
    const first = ledgerConfirmAction({ key: "ledger:a", decisions: [{ type: "thread.weight", thread: "t1", weight: "major" }], label: "铁箱定为大伏笔" });
    const second = ledgerConfirmAction({ key: "ledger:b", decisions: [{ type: "thread.weight", thread: "t2", weight: "major" }], label: "梅花定为大伏笔" });
    const actions = withAuthorButton(withAuthorButton([suggestedAction("quality-check")], first), second);
    expect(actions.map((action) => action.id)).toEqual(["quality-check", "ledger-confirm"]);
    expect(actions[1]!.ledgerTarget).toEqual({
      key: "ledger:a+ledger:b",
      decisions: [...first.ledgerTarget!.decisions, ...second.ledgerTarget!.decisions],
      label: "铁箱定为大伏笔；梅花定为大伏笔",
    });
  });

  it("同一次提议再投影一遍不重复并", () => {
    const first = ledgerConfirmAction({ key: "ledger:a", decisions: [{ type: "fact.retract", fact: "f1" }] });
    const second = ledgerConfirmAction({ key: "ledger:b", decisions: [{ type: "fact.retract", fact: "f2" }] });
    const merged = withAuthorButton(withAuthorButton(undefined, first), second);
    expect(withAuthorButton(merged, first)).toEqual(merged);
    expect(withAuthorButton(merged, second)).toEqual(merged);
  });

  it("合并时的依据：改账提议不写书，同一份依据才接得上；有一个没依据就都不带", () => {
    const a = "a".repeat(64);
    const ledger = withAuthorButton([ledgerConfirmAction({ key: "ledger:a", decisions: [{}], basis: a })], ledgerConfirmAction({ key: "ledger:b", decisions: [{}], basis: a }));
    expect(ledger[0]!.ledgerTarget).toMatchObject({ basis: a });
    const noBasis = withAuthorButton([ledgerConfirmAction({ key: "ledger:a", decisions: [{}], basis: a })], ledgerConfirmAction({ key: "ledger:b", decisions: [{}] }));
    expect(noBasis[0]!.ledgerTarget!.basis).toBeUndefined();
  });

  it("定稿这类一轮只有一个的：后来的换掉先前的", () => {
    const before = { ...suggestedAction("commit-apply"), commitTarget: { chapter: 3 } };
    const after = { ...suggestedAction("commit-apply"), commitTarget: { chapter: 4 } };
    expect(withAuthorButton([before], after)).toEqual([after]);
  });
});
