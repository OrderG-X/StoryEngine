import { describe, expect, it } from "vitest";

import type { ChapterMessage } from "../../../types.js";
import { confirmableCommitPreviewMessageId } from "./commitConfirm.js";

function assistant(id: string, extra: Partial<ChapterMessage> = {}): ChapterMessage {
  return { id, role: "assistant", content: "", ...extra };
}

describe("confirmableCommitPreviewMessageId：「确认定稿」按钮只挂最新一张未用掉的预览卡", () => {
  it("最新预览可定稿 → 挂它（旧预览不挂）", () => {
    const messages = [
      assistant("p1", { cards: [{ type: "commit-preview", preview: { chapter: 1, canCommit: true } }] }),
      { id: "u1", role: "user", content: "改一下" } as ChapterMessage,
      assistant("p2", { cards: [{ type: "commit-preview", preview: { chapter: 1, canCommit: true } }] }),
    ];
    expect(confirmableCommitPreviewMessageId(messages)).toBe("p2");
  });

  it("预览之后已定稿（有入库 delta 卡）→ 不再挂按钮", () => {
    const messages = [
      assistant("p1", { cards: [{ type: "commit-preview", preview: { chapter: 1, canCommit: true } }] }),
      assistant("c1", { cards: [{ type: "commit-report", report: { chapter: 1 } as never }] }),
    ];
    expect(confirmableCommitPreviewMessageId(messages)).toBeNull();
  });

  it("定稿没成（无入库 delta 卡）→ 预览卡按钮留着可重试", () => {
    const messages = [
      assistant("p1", { cards: [{ type: "commit-preview", preview: { chapter: 1, canCommit: true } }] }),
      assistant("fail", { content: "未定稿：工作稿在预览之后又改动过。" }),
    ];
    expect(confirmableCommitPreviewMessageId(messages)).toBe("p1");
  });

  it("最新预览不可定稿 → 不挂（不去翻更早的可定稿预览）", () => {
    const messages = [
      assistant("p1", { cards: [{ type: "commit-preview", preview: { chapter: 1, canCommit: true } }] }),
      assistant("p2", { cards: [{ type: "commit-preview", preview: { chapter: 1, canCommit: false, blockingReasons: ["字数不足。"] } }] }),
    ];
    expect(confirmableCommitPreviewMessageId(messages)).toBeNull();
  });

  it("没有预览 → null", () => {
    expect(confirmableCommitPreviewMessageId([assistant("a")])).toBeNull();
  });
});
