import { describe, expect, it } from "vitest";
import { foundationAcceptAction, ledgerConfirmAction, suggestedAction, withAuthorButton } from "./workflowHelpers.js";

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

  it("一轮两次改设定 → 一个「认下」带两次的改动", () => {
    const first = foundationAcceptAction({ key: "card-1", input: { ops: [{ op: "create", kind: "character", name: "沈砚" }] } });
    const second = foundationAcceptAction({ key: "card-2", input: { ops: [{ op: "create", kind: "character", name: "顾青禾" }] } });
    const actions = withAuthorButton([first], second);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.foundationTarget).toEqual({ key: "card-1+card-2", input: { ops: [...(first.foundationTarget!.input.ops as unknown[]), ...(second.foundationTarget!.input.ops as unknown[])] } });
  });

  it("合并时的依据：后一个接得上前一个（中间只有它自己那批写）用后一个的；接不上留前一个的；有一个没依据就都不带", () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    const c = "c".repeat(64);
    const first = foundationAcceptAction({ key: "card-1", input: { ops: [] }, basis: a, basisFrom: a });
    // 第二次 foundation_write 先写了 AI 那批（a → b）：接得上，合并后照 b 核
    const chained = withAuthorButton([first], foundationAcceptAction({ key: "card-2", input: { ops: [] }, basis: b, basisFrom: a }));
    expect(chained[0]!.foundationTarget).toMatchObject({ basis: b, basisFrom: a });
    // 中间书被别的改过（c ≠ a）：留前一个的依据，点了如实说过期
    const broken = withAuthorButton([first], foundationAcceptAction({ key: "card-3", input: { ops: [] }, basis: c, basisFrom: c }));
    expect(broken[0]!.foundationTarget).toMatchObject({ basis: a });
    // 改账提议不写书：同一份依据才接得上
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
