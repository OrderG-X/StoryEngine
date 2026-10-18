import type { ChapterFlowStatus, DevApiPermission, SuggestedAction } from "../../types.js";

/**
 * 枚举值整串映射成中文。只认整串，不在别人写的字里做词替换（重构 P7「不猜」：
 * 原来整段 replace「story→章节 / world→世界 / 提交预览→定稿预览」，作者的英文人名、设定原文也会被改掉）。
 */
const ENUM_LABELS: Readonly<Record<string, string>> = {
  touched: "本章提到",
  open: "未闭合",
  locked: "受限",
  damaged: "受损",
  lost: "丢失",
  consumed: "已用完",
  available: "可用",
  stairs: "楼梯",
  walk: "步行",
  taxi: "打车",
  bus: "公交",
  elevator: "电梯",
};

export function uiText(value: string | null | undefined, fallback = "尚未设定"): string {
  const raw = value?.trim() ?? "";
  if (!raw || raw === "unknown" || raw === "后端未提供") return fallback;
  const label = ENUM_LABELS[raw.toLowerCase()];
  if (label) return label;
  // 只剩不让界面露出程序内部名：裸 id、内部目录、错误码（铁律 4）。
  return raw
    .replace(/undefined\/drafts(?:\/fast)?/giu, "工作稿目录")
    .replace(/ENOENT/giu, "本地文件未找到")
    .replace(/chapter_\d+_committed/giu, "已定稿章节")
    .replace(/char-[a-z0-9-]+/giu, "角色")
    .replace(/loc-[a-z0-9-]+/giu, "地点");
}

export function uiList(values: readonly string[] | undefined): readonly string[] {
  return (values ?? []).map((item) => uiText(item)).filter((item) => item !== "尚未设定");
}

export function uiJoin(values: readonly string[] | undefined, fallback = "尚未设定"): string {
  const list = uiList(values);
  return list.length > 0 ? list.join("、") : fallback;
}

export function chapterHeading(chapterNumber: number, title: string): string {
  const cleaned = uiText(title, "");
  // 模型给的标题常自带章号标记，且不一定与 UI 当前章一致——可能是阿拉伯数字「第1章」、中文数字「第二章」，
  // 甚至跨章号叠在一起（「第1章 · 第二章 · …」，旧前缀正则只认本章阿拉伯数字 → 残留拼出脏标题）。
  // 一律剥掉开头连续的「第<阿拉伯/中文数字>章 ·」标记，统一换成 canonical「第{chapterNumber}章」。
  const chapterToken = "第[0-9一二三四五六七八九十百零两]+章";
  const chapterOnly = new RegExp(`^${chapterToken}$`, "u");
  const prefix = new RegExp(`^(?:${chapterToken}\\s*[·.．、:-]?\\s*)+`, "u");
  if (!cleaned || chapterOnly.test(cleaned)) return `第${chapterNumber}章`;
  const withoutPrefix = cleaned.replace(prefix, "").trim();
  // 占位章名（「待补」之类）不摆进标题，只显示章号。
  return withoutPrefix && !isPlaceholderChapterTitle(withoutPrefix) ? `第${chapterNumber}章 · ${withoutPrefix}` : `第${chapterNumber}章`;
}

/** 占位章名（「待补」「未命名」，还有章节列表给没写的章垫的「下一章」）：按没名字显示，不把占位词当章名摆出来。闭集查表。 */
const PLACEHOLDER_CHAPTER_TITLES = new Set(["待补", "待定", "未命名", "无题", "标题待定", "下一章", "tbd"]);

export function isPlaceholderChapterTitle(title: string): boolean {
  return PLACEHOLDER_CHAPTER_TITLES.has(title.trim().toLowerCase());
}

/** 列表/面板里显示用的章名：去章号前缀，占位词当没名字（返回空串，调用方显示「未命名」）。 */
export function chapterDisplayTitle(title: string): string {
  const bare = chapterBareTitle(title);
  return isPlaceholderChapterTitle(bare) ? "" : bare;
}

/** 只要章名本身：剥掉开头的「第N章 ·」标记（阿拉伯/中文数字、可叠多个）；只有章号时返回空串。 */
export function chapterBareTitle(title: string): string {
  const cleaned = uiText(title, "");
  const chapterToken = "第[0-9一二三四五六七八九十百零两]+章";
  const prefix = new RegExp(`^(?:${chapterToken}\\s*[·.．、:-]?\\s*)+`, "u");
  return cleaned.replace(prefix, "").trim();
}

/**
 * 只读展示用：去掉正文开头的「# 第N章 …」标题行与成对的 **粗体** / __粗体__ 记号。
 * 只用于定稿只读视图——不回写、不改用户文件（生成侧已在引擎里同口径清洗，这里兜旧数据）。
 */
export function cleanProseForDisplay(content: string): string {
  const lines = content.replace(/\r\n?/gu, "\n").split("\n");
  const first = lines.findIndex((line) => line.trim().length > 0);
  if (first >= 0 && /^#{1,6}\s*第[0-9一二三四五六七八九十百零两]+章/u.test(lines[first].trim())) lines.splice(first, 1);
  return lines.join("\n")
    .replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/gu, "$1")
    .replace(/__(?=\S)([^_\n]*?\S)__/gu, "$1")
    .trim();
}

export function flowLabel(state: ChapterFlowStatus | undefined | null): string {
  const labels: Record<ChapterFlowStatus, string> = {
    idle: "待开始",
    steering_ready: "已定方案",
    draft_generating: "正在生成工作稿",
    draft_ready: "工作稿中",
    quality_checked: "已硬伤检查",
    commit_preview_ready: "待定稿预览",
    waiting_commit_confirmation: "待确认定稿",
    committed: "已定稿",
    ready_for_next: "可进入下一章",
  };
  // 未知/缺失 flowStatus 绝不渲染空串或裸「·」（dogfood 问题 9：刷新后徽标变点）。
  if (!state || !(state in labels)) return "工作稿中";
  return labels[state];
}

export function flowHint(state: ChapterFlowStatus): string {
  const hints: Record<ChapterFlowStatus, string> = {
    idle: "当前章节已就绪。可以让 AI 拟章纲，也可以直接说这一章想怎么写。",
    steering_ready: "章纲拟好了。看过没问题，就可以写这一章。",
    draft_generating: "正在写工作稿，不会更新已定稿版。",
    draft_ready: "工作稿已生成。请先阅读，再做硬伤检查或生成定稿预览。",
    quality_checked: "硬伤检查完成。若没有阻断问题，可以生成定稿预览。",
    commit_preview_ready: "定稿预览已生成。点「确认定稿」将写入已定稿版，可在操作历史撤销。",
    waiting_commit_confirmation: "定稿预览已生成。点「确认定稿」即可写入，可在操作历史撤销。",
    committed: "本章已定稿。可以继续下一章。",
    ready_for_next: "已进入新章节。你可以先说这一章想怎么写，也可以让 AI 拟章纲。",
  };
  return hints[state];
}

export function permissionLabel(permission: SuggestedAction["permission"]): string {
  return permissionValues(permission).map((item) => {
    const labels: Record<DevApiPermission, string> = {
      safe_read: "不会修改内容",
      model_call: "调用 AI",
      draft_write: "写入工作稿",
      project_config_write: "写入配置",
      formal_state_write: "写入正式故事",
      destructive_write: "危险操作",
      local_side_effect: "本地操作",
    };
    return labels[item];
  }).join(" · ");
}

export function permissionValues(permission: SuggestedAction["permission"]): readonly DevApiPermission[] {
  return Array.isArray(permission) ? permission as readonly DevApiPermission[] : [permission as DevApiPermission];
}

export function primaryPermission(permission: SuggestedAction["permission"]): DevApiPermission {
  return permissionValues(permission)[0] ?? "safe_read";
}
