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
    // 不猜白名单：去裸id
    .replace(/\s*[（(][a-zA-Z][A-Za-z0-9_.-]{2,}[）)]/gu, "")
    // 列表编号只在「行首 / 上一行末（\n）/ 句末标点后」才另起一行（R7.7·报告 4.3）：
    // 旧版把任何「空白后跟 1、/1.」都拆行，「第 1、2 章」「用时 1.5 分钟」这类正文枚举/小数全被撕开。
    // 新口径纯结构判定：编号前必须是串首、换行或 。！？!?；;；编号后紧跟数字（1、2 / 1.5）不算列表。
    // 不猜白名单：切句
    .replace(/(^|(?<=[。！？!?；;\n]))(?=\d+[.、](?!\d))/gu, "\n")
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
    // 列表编号判定与 normalizeMessageText 同口径：编号后紧跟数字（「1、2 章」「1.5 分钟」）不是列表项。
    // 不猜白名单：切句
    const numberedListItem = /^\d+[.、](?!\d)\s*/u;
    const listItem = line.replace(/^[-•]\s*/u, "").replace(numberedListItem, "").trim();
    if (listItem !== line || numberedListItem.test(line)) {
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
      return "还想补什么，直接说…";
    case "draft_generating":
      return "正在生成工作稿…";
    case "draft_ready":
    case "quality_checked":
      return "哪里想改，直接说…";
    case "commit_preview_ready":
    case "waiting_commit_confirmation":
      return "在定稿清单里看一遍，点「确认定稿」…";
    case "committed":
    case "ready_for_next":
      return "下一章想写什么…";
    default:
      return "输入你的想法…";
  }
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

/** 工具用时：不到 1 秒不报（作者不关心毫秒）；1 分钟内「N 秒」，再长「M 分 S 秒」。供过程里的工具行 / StepCard 共用。 */
export function formatStepElapsed(ms: number): string {
  if (ms < 1000) return "";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec} 秒`;
  return sec % 60 === 0 ? `${sec / 60} 分` : `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
}
