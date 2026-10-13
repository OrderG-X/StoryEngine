import { describe, expect, it } from "vitest";
import type { ChapterMessage } from "../types.js";
import { lastTurnUndoHintFromMessages } from "./lastTurnUndoHint.js";

const ID_A = "a".repeat(40);
const ID_B = "b".repeat(40);

function assistant(overrides: Partial<ChapterMessage>): ChapterMessage {
  return { id: `m-${Math.random().toString(36).slice(2)}`, role: "assistant", content: "", ...overrides };
}

// R7.2（十章验收 3.2）：「撤销上一步」要撤上一回合的全部写盘改动——锚点取「最后一个带写盘快照的回合」
// 的 turnSnapshots[0]（该回合第一次写盘前，与块级「撤销到此」同一回退点）。
describe("lastTurnUndoHintFromMessages", () => {
  it("上一回合写了两个快照 → 取首个快照 id + changes=2（整回合锚点）", () => {
    const messages: readonly ChapterMessage[] = [
      { id: "u1", role: "user", content: "改两处" },
      assistant({
        turnSnapshots: [
          { toolName: "revise_draft", snapshotId: ID_A },
          { toolName: "foundation_write", snapshotId: ID_B },
        ],
      }),
      { id: "u2", role: "user", content: "撤销上一步" },
    ];
    expect(lastTurnUndoHintFromMessages(messages)).toEqual({ snapshotId: ID_A, changes: 2 });
  });

  it("中间隔了纯聊天回合 → 往前找上一个有写盘的回合", () => {
    const messages: readonly ChapterMessage[] = [
      assistant({ turnSnapshots: [{ toolName: "revise_draft", snapshotId: ID_A }] }),
      { id: "u2", role: "user", content: "谢了" },
      assistant({ content: "不客气。" }),
      { id: "u3", role: "user", content: "撤销上一步" },
    ];
    expect(lastTurnUndoHintFromMessages(messages)).toEqual({ snapshotId: ID_A, changes: 1 });
  });

  it("纯聊天会话 / 没有 assistant 消息 → undefined", () => {
    expect(lastTurnUndoHintFromMessages([{ id: "u1", role: "user", content: "你好" }])).toBeUndefined();
    expect(lastTurnUndoHintFromMessages([])).toBeUndefined();
  });

  it("旧数据里快照 id 不是合法 commit hash → 不当锚点，继续往前找", () => {
    const messages: readonly ChapterMessage[] = [
      assistant({ turnSnapshots: [{ toolName: "revise_draft", snapshotId: ID_B }] }),
      assistant({ turnSnapshots: [{ toolName: "foundation_write", snapshotId: "snap-legacy" }] }),
      { id: "u2", role: "user", content: "撤销上一步" },
    ];
    expect(lastTurnUndoHintFromMessages(messages)).toEqual({ snapshotId: ID_B, changes: 1 });
  });
});
