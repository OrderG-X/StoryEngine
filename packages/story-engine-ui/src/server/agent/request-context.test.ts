// @vitest-environment node
//
// request-context：每请求 projectDir + currentChapter 的注入/读取/解析（H3：让工具在 LLM 没给章号时
// 回退到「用户当前章」，而非引擎推断的最新章）。
import type { ToolExecutionContext } from "@mastra/core/tools";
import { describe, expect, it } from "vitest";

import {
  buildProjectRequestContext,
  parseLastTurnUndoHint,
  readCurrentChapterFromContext,
  readLastTurnUndoHintFromContext,
  readProjectDirFromContext,
  readUserTurnTextFromContext,
  resolveChapterFromInputOrContext,
} from "./request-context.js";

function ctx(requestContext: ReturnType<typeof buildProjectRequestContext>): ToolExecutionContext {
  return { requestContext } as unknown as ToolExecutionContext;
}

describe("request-context projectDir + currentChapter 注入/读取", () => {
  it("buildProjectRequestContext 带 currentChapter → 两者都能读回", () => {
    const c = ctx(buildProjectRequestContext("/tmp/book", 3));
    expect(readProjectDirFromContext(c)).toBe("/tmp/book");
    expect(readCurrentChapterFromContext(c)).toBe(3);
  });

  it("buildProjectRequestContext 不带 currentChapter → 章号读回 undefined（projectDir 仍在）", () => {
    const c = ctx(buildProjectRequestContext("/tmp/book"));
    expect(readProjectDirFromContext(c)).toBe("/tmp/book");
    expect(readCurrentChapterFromContext(c)).toBeUndefined();
  });

  it("currentChapter 非正整数（0/负/小数/NaN）不注入 → 读回 undefined", () => {
    for (const bad of [0, -1, 2.5, Number.NaN]) {
      const c = ctx(buildProjectRequestContext("/tmp/book", bad));
      expect(readCurrentChapterFromContext(c)).toBeUndefined();
    }
  });

  it("readCurrentChapterFromContext 对 undefined context 安全返回 undefined", () => {
    expect(readCurrentChapterFromContext(undefined)).toBeUndefined();
  });

  it("buildProjectRequestContext 带 userTurnText → 可读回本轮用户原话", () => {
    const c = ctx(buildProjectRequestContext("/tmp/book", 3, undefined, "继续写第59章正文。只写这一章，不要写其他章。"));

    expect(readUserTurnTextFromContext(c)).toBe("继续写第59章正文。只写这一章，不要写其他章。");
  });

  it("userTurnText 缺省或空白 → 读回 undefined（向后兼容）", () => {
    expect(readUserTurnTextFromContext(ctx(buildProjectRequestContext("/tmp/book")))).toBeUndefined();
    expect(readUserTurnTextFromContext(ctx(buildProjectRequestContext("/tmp/book", 3, undefined, "   ")))).toBeUndefined();
    expect(readUserTurnTextFromContext(undefined)).toBeUndefined();
  });
});

// R7.2：前端带的「上一个有写盘回合的首个快照」——undo 工具优先按它整回合回退。
describe("request-context lastTurnUndoHint 注入/读取/容错", () => {
  const validHint = { snapshotId: "a".repeat(40), changes: 2 };

  it("buildProjectRequestContext 带 hint → 工具层原样读回", () => {
    const c = ctx(buildProjectRequestContext("/tmp/book", 3, undefined, undefined, validHint));
    expect(readLastTurnUndoHintFromContext(c)).toEqual(validHint);
  });

  it("不带 hint → 读回 undefined（老客户端向后兼容，undo 走默认逐步回退）", () => {
    expect(readLastTurnUndoHintFromContext(ctx(buildProjectRequestContext("/tmp/book")))).toBeUndefined();
    expect(readLastTurnUndoHintFromContext(undefined)).toBeUndefined();
  });

  it("parseLastTurnUndoHint 容错：非对象 / snapshotId 非 40 位 hex / changes 非正整数 → 一律 undefined", () => {
    expect(parseLastTurnUndoHint(undefined)).toBeUndefined();
    expect(parseLastTurnUndoHint(null)).toBeUndefined();
    expect(parseLastTurnUndoHint("a".repeat(40))).toBeUndefined();
    expect(parseLastTurnUndoHint({ snapshotId: "snap-1", changes: 2 })).toBeUndefined();
    expect(parseLastTurnUndoHint({ snapshotId: "A".repeat(40), changes: 2 })).toBeUndefined(); // 大写/非 hex
    expect(parseLastTurnUndoHint({ snapshotId: "a".repeat(40) })).toBeUndefined();
    expect(parseLastTurnUndoHint({ snapshotId: "a".repeat(40), changes: 0 })).toBeUndefined();
    expect(parseLastTurnUndoHint({ snapshotId: "a".repeat(40), changes: 1.5 })).toBeUndefined();
    expect(parseLastTurnUndoHint({ snapshotId: "a".repeat(40), changes: "2" })).toBeUndefined();
    expect(parseLastTurnUndoHint(validHint)).toEqual(validHint);
  });
});

describe("resolveChapterFromInputOrContext 章号回退优先级", () => {
  it("LLM 明确给了章号 → 用 input（即便 context 是别的章）", () => {
    const c = ctx(buildProjectRequestContext("/tmp/book", 2));
    expect(resolveChapterFromInputOrContext(5, c)).toBe(5);
  });

  it("LLM 没给章号 → 回退到用户当前章（context）", () => {
    const c = ctx(buildProjectRequestContext("/tmp/book", 2));
    expect(resolveChapterFromInputOrContext(undefined, c)).toBe(2);
  });

  it("两者都没有 → undefined（由调用方兜底）", () => {
    const c = ctx(buildProjectRequestContext("/tmp/book"));
    expect(resolveChapterFromInputOrContext(undefined, c)).toBeUndefined();
  });

  it("input 是非法章号（0）也回退到 context", () => {
    const c = ctx(buildProjectRequestContext("/tmp/book", 4));
    expect(resolveChapterFromInputOrContext(0, c)).toBe(4);
  });
});
