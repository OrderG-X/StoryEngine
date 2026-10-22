/**
 * 把助手消息的有序分段（ChapterMessage.segments）+ 工具详情（toolSteps）解析成
 * codex 聊天「按真实时间顺序逐段渲染」的列表：想 → 调工具（内联在发生处）→ 再想 → 答。
 *
 * 纯函数、无 React 依赖（便于单测）。没有分段的旧消息按「思考 → 工具 → 正文」三桶拼成同样的列表，渲染只走一条路。
 */
import type { ChapterMessage } from "../../../types.js";
import type { ToolStep } from "../../../api/types.js";

export type RenderSegment =
  | { readonly kind: "reasoning"; readonly text: string }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tool"; readonly step: ToolStep };

/**
 * 解析渲染列表：
 * - reasoning / text：去空白后非空才保留（跳过纯空白增量段）。
 * - tool：按 toolCallId 在 toolSteps 里查实体；查不到（race / 旧数据）则跳过，不崩。
 * 没有 segments（旧消息）或 segments 全解析为空时，退回三桶拼法（不丢内容）。
 */
export function buildMessageRenderSegments(message: ChapterMessage): readonly RenderSegment[] {
  const steps = message.toolSteps ?? [];
  const out: RenderSegment[] = [];
  for (const segment of message.segments ?? []) {
    if (segment.kind === "tool") {
      const step = steps.find((s) => s.id === segment.toolCallId);
      if (step) out.push({ kind: "tool", step });
      continue;
    }
    if (segment.text.trim().length === 0) continue;
    out.push({ kind: segment.kind, text: segment.text });
  }
  return out.length > 0 ? out : bucketSegments(message);
}

function bucketSegments(message: ChapterMessage): readonly RenderSegment[] {
  const thinking = message.thinking?.trim();
  const content = message.content.trim();
  return [
    ...(thinking ? [{ kind: "reasoning" as const, text: thinking }] : []),
    ...(message.toolSteps ?? []).map((step) => ({ kind: "tool" as const, step })),
    ...(content ? [{ kind: "text" as const, text: content }] : []),
  ];
}
