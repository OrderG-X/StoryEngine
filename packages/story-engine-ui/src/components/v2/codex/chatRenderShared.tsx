/**
 * chatRenderShared — codex 聊天面板（AiChatCodex）的消息渲染共享纯函数 + 组件。
 *
 * 纯渲染逻辑（消息分块/富文本/占位/状态标题/思考指示器），与具体壳无关，
 * 单独成模块便于测试与复用。
 */
import type { ReactNode } from "react";
import type { WritingWorkspaceLayoutProps } from "../../../types.js";
import { uiText } from "../v2Utils.js";

// ─── 类型 ────────────────────────────────────────────────────────────────────

export type MessageBlock =
  | { readonly kind: "paragraph"; readonly text: string }
  | { readonly kind: "list"; readonly items: readonly string[] }
  | { readonly kind: "table"; readonly headers: readonly string[]; readonly rows: readonly (readonly string[])[] };

// ─── 私有 helper（仅服务于 formatMessageBlocks）─────────────────────────────

function parseMarkdownTableLine(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  const cells = trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
  return cells.length >= 2 ? cells : null;
}

function isMarkdownTableDivider(cells: readonly string[]): boolean {
  return cells.every((cell) => /^:?-{2,}:?$/u.test(cell));
}

function normalizeTableRows(rows: readonly (readonly string[])[], width: number): readonly (readonly string[])[] {
  return rows.map((row) => Array.from({ length: width }, (_, index) => row[index] ?? ""));
}

/** markdown 分隔线行（--- 、 -- 、 *** 、 - - - 等）：只由横线/星号/下划线与空格组成且至少 2 个符号。 */
function isHorizontalRuleLine(line: string): boolean {
  return /^(?:[-*_]\s*){2,}$/u.test(line);
}

function normalizeMessageText(value: string): string {
  return value
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/\s*[（(][a-zA-Z][A-Za-z0-9_.-]{2,}[）)]/gu, "")
    .replace(/(?:^|\s)(\d+[.、]\s*)/gu, "\n$1")
    .replace(/\s+(?=(?:必须优先补|建议逐步补|当前结论|已够用|需要补|另外|此外|建议先|下一步)[:：])/gu, "\n")
    .replace(/[ \t]{2,}/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

// ─── 导出函数 ─────────────────────────────────────────────────────────────────

export function formatMessageBlocks(content: string): readonly MessageBlock[] {
  const cleaned = normalizeMessageText(uiText(content));
  const lines = cleaned
    .split(/\n+/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const blocks: MessageBlock[] = [];
  let listItems: string[] = [];
  let tableRows: string[][] = [];

  const flushList = () => {
    if (listItems.length) {
      blocks.push({ kind: "list", items: listItems });
      listItems = [];
    }
  };
  const flushTable = () => {
    if (!tableRows.length) return;
    if (tableRows.length >= 2) {
      const [headers, ...rows] = tableRows;
      blocks.push({ kind: "table", headers, rows: normalizeTableRows(rows, headers.length) });
    } else {
      blocks.push({ kind: "paragraph", text: tableRows[0].join("：") });
    }
    tableRows = [];
  };

  for (const line of lines) {
    const tableCells = parseMarkdownTableLine(line);
    if (tableCells) {
      flushList();
      if (!isMarkdownTableDivider(tableCells)) tableRows.push(tableCells);
      continue;
    }
    flushTable();
    // 分隔线不是列表：`---` 若走下面的列表剥离会剩下「--」假列表项（马拉松实测）。按块边界跳过、不渲染。
    if (isHorizontalRuleLine(line)) {
      flushList();
      continue;
    }
    const listItem = line.replace(/^[-•]\s*/u, "").replace(/^\d+[.、]\s*/u, "").trim();
    if (listItem !== line || /^\d+[.、]\s*/u.test(line)) {
      if (listItem) {
        listItems.push(listItem);
      } else if (!/^[-•]\s*$/u.test(line)) {
        // 只丢弃孤立的「-/•」空列表符；孤立的「1.」等序号剥空后保留为段落，不吞用户内容（评审加固）
        flushList();
        blocks.push({ kind: "paragraph", text: line });
      }
      continue;
    }
    flushList();
    blocks.push({ kind: "paragraph", text: line });
  }
  flushTable();
  flushList();
  return blocks;
}

export function getPlaceholder(flowStatus: string, isOpenBook = false): string {
  // 开书阶段（新书、只有开场气泡）：placeholder 跟开书语气一致——别显示「说说这章想写什么」（rerun2 P2）。
  if (isOpenBook) return "说说主角和大概的世界…想到哪说到哪";
  switch (flowStatus) {
    case "idle":
      return "说说这章想写什么…";
    case "steering_ready":
      return "补充想法，或说「写吧」开始生成…";
    case "draft_generating":
      return "正在生成工作稿…";
    case "draft_ready":
      return "说说修改意见，或说「硬伤检查」检查穿帮…";
    case "quality_checked":
      return "说「定稿预览」生成定稿预览，或让 AI 做内容审阅…";
    case "commit_preview_ready":
    case "waiting_commit_confirmation":
      return "检查定稿预览，或说「确认定稿」执行…";
    case "committed":
    case "ready_for_next":
      return "说「下一章」继续…";
    default:
      return "输入你的想法…";
  }
}

export function workflowErrorTitle(flowStatus: WritingWorkspaceLayoutProps["workspace"]["flowStatus"]): string {
  if (flowStatus === "waiting_commit_confirmation" || flowStatus === "commit_preview_ready") return "定稿失败";
  if (flowStatus === "quality_checked") return "硬伤检查失败";
  if (flowStatus === "draft_generating" || flowStatus === "draft_ready") return "工作稿处理失败";
  if (flowStatus === "steering_ready" || flowStatus === "idle") return "本章方案整理失败";
  return "流程执行失败";
}

/**
 * 把含 **加粗** 标记的文本渲染成 ReactNode：`**X**` → `<b>X</b>`，其余原样。
 * codex 的 .bub.bot b 是金色（codex.css），故 AI 气泡里的加粗短语会呈金色强调，对齐设计稿。
 */
export function renderRichText(text: string): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/gu);
  return parts.map((part, index) => {
    const bold = /^\*\*([^*]+)\*\*$/u.exec(part);
    return bold ? <b key={index}>{bold[1]}</b> : part;
  });
}

/**
 * 会动的「思考中」指示：错峰跳动的三个金点 + 流光扫过 + 呼吸辉光，替代原先静态的「正在调用 AI」灰框。
 * 动画全是纯 CSS（无动画库）；放在 .se-v2-shell 内，降低动效总闸（.is-reduced-motion）会自动把动画一刀切关掉，
 * 退化成三颗静态金点 + 文案，不必单独写 reduce-motion 兜底。role=status + aria-live 让读屏也能播报。
 */
export function ThinkingIndicator() {
  return (
    <article className="se-v2-thinking" role="status" aria-live="polite">
      <span className="se-v2-thinking-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className="se-v2-thinking-copy">
        <strong>正在思考</strong>
        <span className="se-v2-thinking-sub">助手正在读取状态、组织回复…</span>
      </span>
    </article>
  );
}

/** 工具耗时格式化：<1s 显示 ms，<60s 显示 Xs（整数不带小数），否则 XmYs。供 ToolStepFold / StepCard 共用。 */
export function formatStepElapsed(ms: number): string {
  if (ms <= 0) return "";
  if (ms < 1000) return `${ms}ms`;
  const totalSec = ms / 1000;
  if (totalSec < 60) {
    const rounded = Math.round(totalSec * 10) / 10;
    return Number.isInteger(rounded) ? `${rounded}s` : `${rounded.toFixed(1)}s`;
  }
  const sec = Math.round(totalSec);
  return `${Math.floor(sec / 60)}m${sec % 60}s`;
}
