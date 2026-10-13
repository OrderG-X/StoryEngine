/**
 * 撤销/回退重载前清掉过时的建议条（R7.2·报告 3.2）。
 *
 * 建议条（suggestedActions）渲染的是「最后一轮」的动作：确认定稿 / 确认写入资料 / 重新确认定稿……
 * 它们都指向撤销前的工作区状态。agent 撤销整页重载后，这些建议已过时（对应写入已被回退），
 * 再显示就是误导。重载前从消息上剥掉 suggestedActions 再落盘（sessionStorage + 会话文件同源），
 * 重载后不再显示。纯函数：没有可剥的返回原数组引用。
 */
import type { ChapterMessage } from "../types.js";

export function stripStaleTurnSuggestions(messages: readonly ChapterMessage[]): readonly ChapterMessage[] {
  if (!messages.some((message) => (message.suggestedActions ?? []).length > 0)) return messages;
  return messages.map((message) =>
    (message.suggestedActions ?? []).length > 0
      ? { ...message, suggestedActions: undefined }
      : message,
  );
}
