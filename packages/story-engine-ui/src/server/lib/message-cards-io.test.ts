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
