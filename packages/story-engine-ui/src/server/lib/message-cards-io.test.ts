// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readMessageCards } from "./message-cards-io.js";

describe("消息卡读回：出错卡（P11）", () => {
  it("原因跟着存、跟着读回；认不得的原因丢掉，不编", () => {
    expect(readMessageCards([{ type: "error", detail: "401 Unauthorized", reason: "auth" }])).toEqual([
      { type: "error", detail: "401 Unauthorized", reason: "auth" },
    ]);
    expect(readMessageCards([{ type: "error", detail: "x", reason: "坏值" }])).toEqual([{ type: "error", detail: "x" }]);
    expect(readMessageCards([{ type: "error" }])).toEqual([{ type: "error" }]);
  });
});

describe("消息卡读回：定论卡（P12）", () => {
  const settle = {
    token: "0123456789abcdef",
    canon: "杜长顺十年前去世",
    canonExists: false,
    edits: [{ key: "e1", chapter: 2, draft: false, from: "五年", to: "十年" }],
    facts: [],
    fields: [{ key: "f1", card: "杜长顺", label: "去世", from: "五年前", to: "十年前" }],
    searched: [1, 2],
    missed: [],
    failures: [],
  };
  it("划掉的只认卡上真有的；改齐了那句跟着存；票号不对整张不认", () => {
    expect(readMessageCards([{ type: "settle", settle, excluded: ["e1", "e9"], applied: "改齐了。" }])).toEqual([
      { type: "settle", settle, excluded: ["e1"], applied: "改齐了。" },
    ]);
    expect(readMessageCards([{ type: "settle", settle: { ...settle, token: "x" } }])).toEqual([]);
  });

  it("「不改了」跟着存；改齐了的不算不改了；只认 true", () => {
    expect(readMessageCards([{ type: "settle", settle, dropped: true }])).toEqual([{ type: "settle", settle, dropped: true }]);
    expect(readMessageCards([{ type: "settle", settle, dropped: true, applied: "改齐了。" }])).toEqual([{ type: "settle", settle, applied: "改齐了。" }]);
    expect(readMessageCards([{ type: "settle", settle, dropped: "true" }])).toEqual([{ type: "settle", settle }]);
  });
});

describe("消息卡读回：另外几版", () => {
  it("几版全文跟着存、跟着读回；没章号整张不认", () => {
    const versions = { chapter: 38, versions: [{ index: 1, body: "甲版正文。" }] };
    expect(readMessageCards([{ type: "draft-versions", versions }])).toEqual([{ type: "draft-versions", versions }]);
    expect(readMessageCards([{ type: "draft-versions", versions: { versions: versions.versions } }])).toEqual([]);
  });
});

describe("消息卡读回：操作卡（写作版本 P2a）", () => {
  const op = {
    opId: "op-0123456789abcdef0123", kind: "inspect.run", mode: "quality", chapter: 3, what: "质检·第 3 章", state: "paused",
    stateText: "停着：模型连不上", allowed: ["resume", "cancel", "resume", "删掉"], summary: "", progress: "在看第 3 章", eventSeq: 4,
  };
  it("号、种类、状态对得上才认；按钮去重只认两种；结束时说过结论跟着存", () => {
    expect(readMessageCards([{ type: "operation", op }])).toEqual([{
      type: "operation",
      op: { ...op, allowed: ["resume", "cancel"] },
    }]);
    expect(readMessageCards([{ type: "operation", op: { ...op, state: "succeeded", allowed: [], progress: undefined, announced: true } }])).toEqual([{
      type: "operation",
      op: { opId: op.opId, kind: op.kind, mode: "quality", chapter: 3, what: op.what, state: "succeeded", stateText: op.stateText, allowed: [], summary: "", eventSeq: 4, announced: true },
    }]);
    for (const bad of [{ ...op, opId: "op-x" }, { ...op, kind: "" }, { ...op, state: "done" }]) {
      expect(readMessageCards([{ type: "operation", op: bad }])).toEqual([]);
    }
  });

  it("缺的给中性说法，长的截断；announced 只认 true", () => {
    const [card] = readMessageCards([{ type: "operation", op: { opId: op.opId, kind: "inspect.run", state: "failed", summary: "字".repeat(3000), announced: "true" } }]);
    expect(card).toMatchObject({ type: "operation", op: { what: "这次操作", stateText: "", allowed: [], eventSeq: 0 } });
    expect(card?.type === "operation" ? card.op.summary.length : 0).toBe(2000);
    expect(card?.type === "operation" ? card.op.announced : "x").toBeUndefined();
  });

  it("检查结果卡的查的是哪一版跟着存", () => {
    expect(readMessageCards([{ type: "quality", report: { blocking: [] }, checkedVersion: "v3" }])).toEqual([{ type: "quality", report: { blocking: [] }, checkedVersion: "v3" }]);
    expect(readMessageCards([{ type: "draft-review", review: { issues: [] }, checkedVersion: null }])).toEqual([{ type: "draft-review", review: { issues: [] }, checkedVersion: null }]);
    expect(readMessageCards([{ type: "ai-flavor", report: { violations: [] }, checkedVersion: 5 }])).toEqual([{ type: "ai-flavor", report: { violations: [] } }]);
  });
});
