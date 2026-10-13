import { describe, expect, it } from "vitest";
import type { ChapterMessage } from "../types.js";
import { stripStaleTurnSuggestions } from "./staleTurnSuggestions.js";

function assistant(overrides: Partial<ChapterMessage>): ChapterMessage {
  return { id: `m-${Math.random().toString(36).slice(2)}`, role: "assistant", content: "" , ...overrides };
}

const action = {
  id: "confirm-write",
  label: "确认写入资料",
  description: "写入资料",
  permission: "project_config_write" as const,
  requiresConfirmation: true,
  endpoint: "suggestion-1",
};

// R7.2（十章验收 3.2）：撤销/回退重载后，建议条指向的是已被回退的旧状态——落盘前剥掉，重载后不再显示。
describe("stripStaleTurnSuggestions", () => {
  it("剥掉所有消息上的 suggestedActions（建议条数据源），其余字段原样保留", () => {
    const withSuggestion = assistant({
      id: "a1",
      content: "已写入，请确认。",
      suggestedActions: [action],
      toolSteps: [{ id: "t1", label: "更新故事资料", toolName: "foundation_write", status: "completed", startedAt: 1 }],
    });
    const clean = assistant({ id: "a2", content: "纯回复。" });
    const stripped = stripStaleTurnSuggestions([withSuggestion, clean]);

    expect(stripped[0]).not.toBe(withSuggestion);
    expect((stripped[0] as ChapterMessage).suggestedActions).toBeUndefined();
    expect(stripped[0]?.content).toBe("已写入，请确认。");
    expect(stripped[0]?.toolSteps).toHaveLength(1);
    // 干净消息复用原对象（少一次无谓拷贝）。
    expect(stripped[1]).toBe(clean);
  });

  it("本来就没有建议 → 返回原数组引用（no-op）", () => {
    const messages: readonly ChapterMessage[] = [assistant({ id: "a1", content: "你好" })];
    expect(stripStaleTurnSuggestions(messages)).toBe(messages);
  });
});
