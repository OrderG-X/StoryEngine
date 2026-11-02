import { describe, expect, it } from "vitest";

import type { ChapterMessage } from "../../../types.js";
import { supersededContinuityMessageIds, undoableCommitReportMessageId } from "./commitConfirm.js";

function assistant(id: string, extra: Partial<ChapterMessage> = {}): ChapterMessage {
  return { id, role: "assistant", content: "", ...extra };
}

describe("undoableCommitReportMessageId：「撤销这次定稿」只挂最近一次改动就是定稿的那张（P11）", () => {
  const snap = (id: string) => [{ toolName: "prepare_commit", snapshotId: id }];
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

describe("操作历史里恢复过之后（2026-10-25 桌面包走查）", () => {
  const note = { id: "r1", role: "system", kind: "restore", content: "已恢复到「定稿：第9章」之前。" } as ChapterMessage;

  it("旧定稿回执不再给「撤销这次定稿」", () => {
    const report = assistant("c1", { cards: [{ type: "commit-report", report: { chapter: 9 } as never }], turnSnapshots: [{ toolName: "prepare_commit", snapshotId: "s1" }] });
    expect(undoableCommitReportMessageId([report])).toBe("c1");
    expect(undoableCommitReportMessageId([report, note])).toBeNull();
  });

});
