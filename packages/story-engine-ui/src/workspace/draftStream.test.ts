import { describe, expect, it } from "vitest";
import { applyDraftDelta, draftPhaseOfStep, EMPTY_DRAFT_STREAM, type DraftStreamState } from "./draftStream.js";

const delta = (text: string, streamSeq: number, extra: { readonly exec?: string; readonly replace?: true; readonly base?: true } = {}) => {
  const { exec = "e1", ...flags } = extra;
  return { type: "draft-delta" as const, exec, streamSeq, text, ...flags };
};
const feed = (...events: ReturnType<typeof delta>[]): DraftStreamState => events.reduce(applyDraftDelta, EMPTY_DRAFT_STREAM);

describe("applyDraftDelta：写稿操作的正文流按执行、按号拼", () => {
  it("同一个执行里按号往后接；号小的丢掉，号一样的追加不重复拼", () => {
    expect(feed(delta("一", 1), delta("二", 2), delta("三", 3)).text).toBe("一二三");
    expect(feed(delta("一", 1), delta("二", 2), delta("旧", 1)).text).toBe("一二");
    expect(feed(delta("一", 1), delta("二", 2), delta("二", 2)).text).toBe("一二");
  });

  it("订阅时补发到现在的那份（整段换，同一个号）：换掉、不重复", () => {
    expect(feed(delta("一二", 2), delta("一二", 2, { replace: true }), delta("三", 3)).text).toBe("一二三");
    expect(feed(delta("一", 1), delta("重写", 2, { replace: true })).text).toBe("重写");
  });

  it("base 是接着写时本来写好的那段：单独记，新写的从空接着拼", () => {
    const state = feed(delta("作者写的。\n\n", 1, { base: true }), delta("新写的", 2));
    expect(state).toMatchObject({ base: "作者写的。\n\n", text: "新写的" });
  });

  it("换了执行（一步重做）：之前流的作废、从新的那份重新拼；旧执行迟到的丢掉", () => {
    const redone = feed(delta("旧的一版", 1), delta("新", 1, { exec: "e2" }), delta("迟到", 2), delta("的一版", 2, { exec: "e2" }));
    expect(redone).toMatchObject({ exec: "e2", superseded: ["e1"], text: "新的一版", base: "" });
  });

  it("换了执行的第一段号从头算（不跟上一个执行比）", () => {
    expect(feed(delta("旧", 5), delta("新", 1, { exec: "e2" })).text).toBe("新");
  });
});

describe("draftPhaseOfStep：步骤 → 稿纸顶上说 AI 在干什么", () => {
  it("拟纲 / 写正文 / 核账三段；别的步不说", () => {
    for (const step of ["notes", "plan", "plan-save"]) expect(draftPhaseOfStep(step)).toBe("plan");
    for (const step of ["write:1", "write:2", "extend", "deai"]) expect(draftPhaseOfStep(step)).toBe("write");
    for (const step of ["check", "fix", "recheck", "apply"]) expect(draftPhaseOfStep(step)).toBe("check");
    for (const step of ["materials", "select", "beats"]) expect(draftPhaseOfStep(step)).toBeUndefined();
  });
});
