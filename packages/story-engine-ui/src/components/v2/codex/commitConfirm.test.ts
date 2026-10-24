import { describe, expect, it } from "vitest";

import type { ChapterMessage } from "../../../types.js";
import { confirmableCommitPreviewMessageId, supersededContinuityMessageIds, undoableCommitReportMessageId } from "./commitConfirm.js";

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

describe("undoableCommitReportMessageId：「撤销这次定稿」只挂最近一次改动就是定稿的那张（P11）", () => {
  const snap = (id: string) => [{ toolName: "commit_apply", snapshotId: id }];
  const report = [{ type: "commit-report", report: { chapter: 1 } as never }] as ChapterMessage["cards"];

  it("最近的改动就是定稿 → 挂它；前面那张旧回执不挂", () => {
    const messages = [
      assistant("c1", { cards: report, turnSnapshots: snap("s1") }),
      assistant("c2", { cards: report, turnSnapshots: snap("s2") }),
      assistant("chat", { content: "只是聊了两句" }),
    ];
    expect(undoableCommitReportMessageId(messages)).toBe("c2");
  });

  it("定稿之后又改过东西（出稿、AI 撤销……）→ 谁都不挂", () => {
    const messages = [
      assistant("c1", { cards: report, turnSnapshots: snap("s1") }),
      assistant("w1", { turnSnapshots: [{ toolName: "generate_draft", snapshotId: "s2" }] }),
    ];
    expect(undoableCommitReportMessageId(messages)).toBeNull();
    expect(undoableCommitReportMessageId([])).toBeNull();
  });
});

describe("supersededContinuityMessageIds：同一章后来又核过，旧核账卡算过时", () => {
  const checkCard = (chapter: number) => ({ cards: [{ type: "continuity" as const, check: { chapter, source: "draft" as const, sure: [], maybe: [] } }] });
  it("同章只有最新一张不算过时；别的章各自算", () => {
    const messages = [
      assistant("k1", checkCard(23)),
      assistant("k2", checkCard(22)),
      assistant("k3", checkCard(23)),
      assistant("x", {}),
    ];
    expect([...supersededContinuityMessageIds(messages)]).toEqual(["k1"]);
  });
});
