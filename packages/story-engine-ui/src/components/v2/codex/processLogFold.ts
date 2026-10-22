/**
 * 一轮 AI 回复拆成两块（2026-10-22 AI 栏减字）：
 *  - 过程：思考、调工具、工具之间的旁白（「我先读一下…」），收成一行，点开才看；
 *  - 答复：最后一个干活的工具之后的正文——作者真正要读的。
 * 「建议下一步」做成了输入框上方的选项，这一步不进过程（没成功的照样进，不藏失败）。
 * 纯函数；进行中和已完成同一套切法，只是进行中那行跑光。
 */
import type { ToolStep } from "../../../api/types.js";
import type { RenderSegment } from "./messageSegments.js";

export type ProcessFoldStep =
  | { readonly kind: "reasoning"; readonly text: string }
  | { readonly kind: "narration"; readonly text: string }
  | { readonly kind: "tool"; readonly step: ToolStep };

export interface TurnFold {
  readonly process: readonly ProcessFoldStep[];
  readonly answer: readonly string[];
}

/** 已经换成别处界面的工具：做成了就不在过程里占一步。 */
const HIDDEN_WHEN_DONE = new Set(["suggest_next_steps"]);

function hidden(step: ToolStep): boolean {
  return Boolean(step.toolName && HIDDEN_WHEN_DONE.has(step.toolName)) && step.status === "completed";
}

/** 结果自带一张卡的工具 → 那张卡（卡上已经写清做了什么、结果如何）。 */
const CARD_OF_TOOL: Readonly<Record<string, string>> = {
  check_continuity: "continuity",
  commit_preview: "commit-preview",
  quality_check: "quality",
  ai_review: "draft-review",
  check_ai_flavor: "ai-flavor",
  commit_apply: "commit-report",
};

export function hasOwnCard(step: ToolStep): boolean {
  return Boolean(step.toolName && CARD_OF_TOOL[step.toolName]);
}

/**
 * 答复从「最后一个干活的工具」之后算起。自带卡片的工具（核账、定稿预览…）不算分界：
 * 服务端会在模型说完话之后补发一次核账，不能因此把模型那段答复收进过程。
 */
export function foldTurn(segments: readonly RenderSegment[]): TurnFold {
  const kept = segments.filter((seg) => seg.kind !== "tool" || !hidden(seg.step));
  let boundary = -1;
  kept.forEach((seg, index) => {
    if (seg.kind === "tool" && !hasOwnCard(seg.step)) boundary = index;
  });
  const process: ProcessFoldStep[] = [];
  const answer: string[] = [];
  kept.forEach((seg, index) => {
    if (seg.kind === "tool") process.push({ kind: "tool", step: seg.step });
    else if (seg.kind === "reasoning") process.push({ kind: "reasoning", text: seg.text });
    else if (index > boundary) answer.push(seg.text);
    else process.push({ kind: "narration", text: seg.text });
  });
  return { process, answer };
}

/**
 * 过程那一行有没有必要显示：只调了一个自带卡片的工具（比如点「核账」按钮）、做成了、没想没说，
 * 卡片已经把事说清，再挂一行「核账」是重复。没成功 / 被停 / 还在跑的照样显示。
 */
export function processWorthShowing(process: readonly ProcessFoldStep[], cardTypes: ReadonlySet<string>, live: boolean): boolean {
  if (process.length === 0) return false;
  if (live || process.length > 1) return true;
  const only = process[0]!;
  if (only.kind !== "tool") return true;
  const card = only.step.toolName ? CARD_OF_TOOL[only.step.toolName] : undefined;
  const settled = only.step.status === "completed" || only.step.status === "verdict";
  return !(card && settled && cardTypes.has(card));
}

export interface ProcessSummary {
  /** 收起时那一行：做了哪几样事。 */
  readonly label: string;
  /** 没成功的步数（照实标出来，不藏）。 */
  readonly failed: number;
  readonly stopped: boolean;
  /** 进行中时正在做的那一步。 */
  readonly current: string | null;
}

/** 收起那一行的说法：最多点名两样事，多了说「等 N 步」；只有思考就叫「思考过程」。 */
export function summarizeProcess(
  steps: readonly ProcessFoldStep[],
  labelOf: (step: ToolStep) => string,
  live: boolean,
): ProcessSummary {
  const tools = steps.flatMap((step) => (step.kind === "tool" ? [step.step] : []));
  const names = [...new Set(tools.map(labelOf).filter(Boolean))];
  const label = names.length === 0
    ? "思考过程"
    : names.length <= 2
      ? names.join("、")
      : `${names.slice(0, 2).join("、")} 等 ${tools.length} 步`;
  const last = steps.at(-1);
  const current = !live
    ? null
    : !last
      ? "在想"
      : last.kind === "tool"
        ? (last.step.status === "running" ? labelOf(last.step) : "在想")
        : "在想";
  return {
    label,
    failed: tools.filter((step) => step.status === "failed").length,
    stopped: tools.some((step) => step.status === "stopped"),
    current,
  };
}
