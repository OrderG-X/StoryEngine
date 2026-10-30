// @vitest-environment node
//
// request-context：每请求 projectDir + currentChapter 的注入/读取/解析（H3：让工具在 LLM 没给章号时
// 回退到「用户当前章」，而非引擎推断的最新章）。
import type { ToolExecutionContext } from "@mastra/core/tools";
import { describe, expect, it } from "vitest";

import {
  buildProjectRequestContext,
  readCurrentChapterFromContext,
  readProjectDirFromContext,
  readAuthorWordsFromContext,
  readPickedDirectionFromContext,
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

  it("buildProjectRequestContext 带作者原话 → 可读回（空白条丢掉）", () => {
    const c = ctx(buildProjectRequestContext("/tmp/book", 3, ["写第59章", "  ", "让林溪回来"]));

    expect(readAuthorWordsFromContext(c)).toEqual(["写第59章", "让林溪回来"]);
  });

  it("作者原话缺省或全空白 → 读回 undefined", () => {
    expect(readAuthorWordsFromContext(ctx(buildProjectRequestContext("/tmp/book")))).toBeUndefined();
    expect(readAuthorWordsFromContext(ctx(buildProjectRequestContext("/tmp/book", 3, ["   "])))).toBeUndefined();
    expect(readAuthorWordsFromContext(undefined)).toBeUndefined();
  });
});

describe("request-context 作者挑中的走法", () => {
  it("只对挑的那一章读得回；没带、没字、章号不对都是 undefined", () => {
    const c = ctx(buildProjectRequestContext("/tmp/book", 14, undefined, { chapter: 14, text: " 老民警：1. 去派出所 " }));
    expect(readPickedDirectionFromContext(c, 14)).toBe("老民警：1. 去派出所");
    expect(readPickedDirectionFromContext(c, 15)).toBeUndefined();
    expect(readPickedDirectionFromContext(ctx(buildProjectRequestContext("/tmp/book", 14)), 14)).toBeUndefined();
    expect(readPickedDirectionFromContext(ctx(buildProjectRequestContext("/tmp/book", 14, undefined, { chapter: 14, text: "  " })), 14)).toBeUndefined();
    expect(readPickedDirectionFromContext(undefined, 14)).toBeUndefined();
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
