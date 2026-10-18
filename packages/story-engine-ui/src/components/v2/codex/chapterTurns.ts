/**
 * 右栏「这一章的对话」（重构 P6 第 6 步：对话简化成这一章的对话）。
 *
 * 一轮＝作者一句话开头、到下一句作者的话之前；这一轮算哪一章看作者发话时在看的章（ChapterMessage.chapter）。
 * 只露：当前章的轮 ∪ 没记章号的轮（旧对话 / 开书问候）∪ 最后一轮（刚说的话总在眼前）；别的章的收成顶上一行。
 */
import type { ChapterMessage } from "../../../types.js";

export interface ChapterTurns {
  /** 收起来的消息 id。 */
  readonly hidden: ReadonlySet<string>;
  /** 收起来几轮。 */
  readonly hiddenTurns: number;
}

export function chapterTurns(messages: readonly ChapterMessage[], currentChapter: number | undefined): ChapterTurns {
  const turns: ChapterMessage[][] = [];
  for (const message of messages) {
    if (message.role === "user" || turns.length === 0) turns.push([message]);
    else turns[turns.length - 1]!.push(message);
  }
  const hidden = new Set<string>();
  let hiddenTurns = 0;
  turns.forEach((turn, index) => {
    const opener = turn[0]!;
    const chapter = opener.role === "user" ? opener.chapter : undefined;
    if (chapter === undefined || currentChapter === undefined || chapter === currentChapter || index === turns.length - 1) return;
    hiddenTurns += 1;
    for (const message of turn) hidden.add(message.id);
  });
  return { hidden, hiddenTurns };
}
