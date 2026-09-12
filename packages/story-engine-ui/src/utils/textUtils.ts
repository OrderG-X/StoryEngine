/**
 * Unified text normalization for UI display.
 * All rules are declarative: add/remove entries in textRules without touching the engine.
 */

import { isRealDraftContent } from "./draftContent.js";

const STORY_WORD_PATTERN = /\bstory\b/giu;

const textRules: Array<[pattern: string | RegExp, replacement: string]> = [
  // Internal state labels → user-facing Chinese
  [/^chapter_(\d+)_committed$/iu, "第$1章已定稿"],
  [/chapter_\d+_committed/giu, "已定稿章节"],
  ["后端未提供", "尚未配置"],
  ["touched", "已触及"],
  // Paths and file-system artifacts
  [/undefined\/drafts(?:\/fast)?/giu, "工作稿目录"],
  ["ENOENT", "本地文件未找到"],
  // Character/location/asset ID fragments
  [/char-[a-z0-9-]+/giu, "角色"],
  [/loc-[a-z0-9-]+/giu, "地点"],
  // Transportation vocabulary
  [/\bstairs\b/giu, "楼梯"],
  [/\bwalk\b/giu, "步行"],
  [/\btaxi\b/giu, "打车"],
  [/\bbus\b/giu, "公交"],
  [/\belevator\b/giu, "电梯"],
  // Object states
  [/\bled\b/giu, "受限"],
  [/\bdamaged\b/giu, "受损"],
  [/\bavailable\b/giu, "可用"],
  [/\bunknown\b/giu, "尚未设定"],
  // Engine module names
  ["HookPool", "伏笔池"],
  ["ThreadPool", "线索池"],
  ["ArcGoal", "主线目标"],
  ["arcGoal", "主线目标"],
  ["Commit Preview", "定稿预览"],
  ["cleanup-visible intent", "需要清理的低价值意图"],
  ["stale intent", "过期意图"],
  // Narrative terminology
  [/\s*[·•]\s*open\b/giu, " · 未闭合"],
  ["Location Bible", "地点设定"],
  ["Story Bible", "故事设定"],
  ["Character Bible", "角色设定"],
  ["World Bible", "世界设定"],
  [/\barc\b/giu, "主线"],
  [/\bHook\b/gu, "伏笔"],
  [/\bThread\b/gu, "线索"],
  [/\bhook\b/gu, "伏笔"],
  [/\bthread\b/gu, "线索"],
  [STORY_WORD_PATTERN, "章节"],
  [/\btimeline\b/giu, "时间线"],
  [/\bworld\b/giu, "世界"],
  [/\bcharacter\b/giu, "角色"],
  // Domain terminology
  ["Character State", "角色状态"],
  ["World State", "世界状态"],
  ["Asset ChangePlan", "道具变更建议"],
  ["Location ChangePlan", "地点变更建议"],
  // UI flow labels
  ["提交预览", "定稿预览"],
  ["入库预览", "定稿预览"],
  ["正式提交", "确认定稿"],
  ["正式状态", "正式故事"],
];

export function cleanUiText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let result = value;
  for (const [pattern, replacement] of textRules) {
    if (pattern === STORY_WORD_PATTERN && looksLikePathText(result)) continue;
    if (typeof pattern === "string") {
      result = result.replaceAll(pattern, replacement);
    } else {
      result = result.replace(pattern, replacement);
    }
  }
  return result;
}

function looksLikePathText(value: string): boolean {
  return value.includes("/") || /\.json\b/iu.test(value);
}

/**
 * 全仓唯一字数口径（UI 审计 T14：稿纸顶栏 / AI 回执 / 审稿计量 / 候选面板同函数同口径）：
 * 正文字数 = 去掉开头 frontmatter（---…--- 块）与 Markdown 标题行后的中文字符数
 * （字符集 [\u3400-\u9fff]，与引擎 countDraftChineseCharacters 同源；标点、空白、西文不计）。
 * 显示用空草稿占位符（「还没有草稿正文…」，见 draftContent.isRealDraftContent）不是正文 → 0，
 * 空稿顶栏不再显示假字数。
 */
export function countTextWords(text: string): number {
  if (!isRealDraftContent(text)) return 0;
  const body = text
    .replace(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/u, "")
    .replace(/^#.*$/gmu, "");
  return (body.match(/[\u3400-\u9fff]/gu) ?? []).length;
}

/**
 * 毫秒时间戳 → 用户可读的相对时间标签（刚刚 / N 分钟前 / N 小时前 / N 天前 / 具体日期）。
 * 服务端书架扫描与前端共用（此文件是纯函数、服务端可安全导入）。
 * 非法/零值按「时间未知」兜底——不能显示「刚刚」：排序把 0 当最旧沉底，标签却装最新，自相矛盾（评审加固）。
 */
export function formatRelativeTimeMs(thenMs: number, nowMs: number = Date.now()): string {
  if (!Number.isFinite(thenMs) || thenMs <= 0) return "时间未知";
  const diffSec = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (diffSec < 60) return "刚刚";
  const mins = Math.round(diffSec / 60);
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(thenMs).toLocaleDateString("zh-CN");
}

export function compactStrings(values: readonly (string | undefined | null)[]): string[] {
  return values.map((value) => cleanUiText(value?.trim())).filter((value): value is string => Boolean(value));
}

export function looksLikeDraftBody(text: string): boolean {
  const normalized = text.trim();
  if (normalized.length > 700) return true;
  const paragraphs = normalized.split(/\n\s*\n/u).filter((item) => item.trim().length > 0);
  return paragraphs.length >= 3 && normalized.length > 360;
}

export function extractDraftTitle(content: string | undefined): string | null {
  if (!content) return null;
  const firstLine = content.split(/\r?\n/u).find((line) => line.trim().length > 0)?.trim();
  if (!firstLine?.startsWith("#")) return null;
  const title = firstLine.replace(/^#+\s*/u, "").replace(/^第[一二三四五六七八九十百\d]+章\s*[·：:、-]?\s*/u, "").trim();
  return title || null;
}
