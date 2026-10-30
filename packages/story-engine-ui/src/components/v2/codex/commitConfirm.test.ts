import { describe, expect, it } from "vitest";

import type { ChapterMessage } from "../../../types.js";
import { confirmableCommitPreviewIds, supersededContinuityMessageIds, undoableCommitReportMessageId } from "./commitConfirm.js";

function assistant(id: string, extra: Partial<ChapterMessage> = {}): ChapterMessage {
  return { id, role: "assistant", content: "", ...extra };
}

const OP = "op-0123456789abcdef0123";
const OP2 = "op-0123456789abcdef0124";
const checklist = (chapter: number) => ({ chapter, canCommit: true });
/** 一条出了定稿清单的消息：op = 消息上那次定稿现在的样子（等作者点的带清单）。 */
function prepared(id: string, chapter: number, opId: string, state: "waiting_author" | "succeeded" | "obsolete", pending = state === "waiting_author"): ChapterMessage {
  return assistant(id, {
    cards: [
      { type: "operation", op: { opId, kind: "commit.prepare", what: `定稿·第 ${chapter} 章`, state, stateText: "", allowed: [], summary: "", eventSeq: 1, ...(pending ? { pending: { kind: "commit", actionId: "confirm-commit", decisions: ["commit"], preview: checklist(chapter) } } : {}) } },
      { type: "commit-preview", preview: checklist(chapter), opId },
    ],
  });
}

describe("confirmableCommitPreviewIds：那次定稿还在等作者点、又是这一章最新那张的清单才能点「确认定稿」", () => {
  it("在等 → 能点；用掉了、作废了的不能点", () => {
    expect([...confirmableCommitPreviewIds([prepared("p1", 1, OP, "waiting_author")])]).toEqual(["p1"]);
    expect(confirmableCommitPreviewIds([prepared("p1", 1, OP, "succeeded")]).size).toBe(0);
    expect(confirmableCommitPreviewIds([prepared("p1", 1, OP, "obsolete")]).size).toBe(0);
  });

  it("重开书还没接上（卡上说在等、清单还没摆回来）→ 先不能点", () => {
    expect(confirmableCommitPreviewIds([prepared("p1", 1, OP, "waiting_author", false)]).size).toBe(0);
  });

  it("同一章后来又出了一张 → 只有新的能点；别的章各自算", () => {
    const messages = [prepared("p1", 1, OP, "waiting_author"), prepared("p2", 2, OP2, "waiting_author"), prepared("p3", 1, "op-0123456789abcdef0125", "waiting_author")];
    expect([...confirmableCommitPreviewIds(messages)].sort()).toEqual(["p2", "p3"]);
  });

  it("消息上的操作卡换成了别的一次（清单不是它出的）→ 不能点", () => {
    const message = prepared("p1", 1, OP, "waiting_author");
    const other = { ...message, cards: message.cards!.map((card) => (card.type === "commit-preview" ? { ...card, opId: OP2 } : card)) };
    expect(confirmableCommitPreviewIds([other]).size).toBe(0);
    expect(confirmableCommitPreviewIds([assistant("a")]).size).toBe(0);
  });
});

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

  it("旧清单不再给「确认定稿」", () => {
    const preview = prepared("p1", 9, OP, "waiting_author");
    expect([...confirmableCommitPreviewIds([preview])]).toEqual(["p1"]);
    expect(confirmableCommitPreviewIds([preview, note]).size).toBe(0);
  });
});
