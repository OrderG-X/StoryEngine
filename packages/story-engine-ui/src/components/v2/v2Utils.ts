import type { ChapterFlowStatus, DevApiPermission, SuggestedAction } from "../../types.js";

export function uiText(value: string | null | undefined, fallback = "尚未设定"): string {
  const raw = value?.trim() ?? "";
  if (!raw || raw === "unknown" || raw === "后端未提供") return fallback;
  return raw
    .replace(/undefined\/drafts(?:\/fast)?/giu, "工作稿目录")
    .replace(/ENOENT/giu, "本地文件未找到")
    .replace(/chapter_\d+_committed/giu, "已定稿章节")
    .replace(/char-[a-z0-9-]+/giu, "角色")
    .replace(/loc-[a-z0-9-]+/giu, "地点")
    .replace(/\btouched\b/giu, "本章提到")
    .replace(/\bstairs\b/giu, "楼梯")
    .replace(/\bwalk\b/giu, "步行")
    .replace(/\btaxi\b/giu, "打车")
    .replace(/\bbus\b/giu, "公交")
    .replace(/\belevator\b/giu, "电梯")
    .replace(/\blocked\b/giu, "受限")
    .replace(/\bdamaged\b/giu, "受损")
    .replace(/\bavailable\b/giu, "可用")
    .replace(/\bunknown\b/giu, "尚未设定")
    .replace(/HookPool/gu, "伏笔池")
    .replace(/ThreadPool/gu, "线索池")
    .replace(/ArcGoal/gu, "主线目标")
    .replace(/arcGoal/gu, "主线目标")
    .replace(/Commit Preview/giu, "定稿预览")
    .replace(/cleanup-visible intent/giu, "需要清理的低价值意图")
    .replace(/stale intent/giu, "过期意图")
    .replace(/\s*[·•]\s*open\b/giu, " · 未闭合")
    .replace(/Location Bible/giu, "地点设定")
    .replace(/Story Bible/giu, "故事设定")
    .replace(/Character Bible/giu, "角色设定")
    .replace(/World Bible/giu, "世界设定")
    .replace(/\barc\b/giu, "主线")
    .replace(/\bHook\b/gu, "伏笔")
    .replace(/\bThread\b/gu, "线索")
    .replace(/\bhook\b/gu, "伏笔")
    .replace(/\bthread\b/gu, "线索")
    .replace(/\bstory\b(?![/-])/giu, "章节")
    .replace(/\btimeline\b/giu, "时间线")
    .replace(/\bworld\b/giu, "世界")
    .replace(/\bcharacter\b/giu, "角色")
    .replace(/Character State/giu, "角色状态")
    .replace(/World State/giu, "世界状态")
    .replace(/Asset ChangePlan/giu, "资产变更建议")
    .replace(/Location ChangePlan/giu, "地点变更建议")
    .replace(/提交预览/gu, "定稿预览")
    .replace(/入库预览/gu, "定稿预览")
    .replace(/正式提交/gu, "确认定稿")
    .replace(/正式状态/gu, "已定稿版");
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
  return withoutPrefix ? `第${chapterNumber}章 · ${withoutPrefix}` : `第${chapterNumber}章`;
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
    idle: "当前章节已就绪。可以让 AI 生成本章方案，也可以直接说这一章想怎么写。",
    steering_ready: "本章方案已准备好。确认方向后，可以生成工作稿正文。",
    draft_generating: "正在写工作稿，不会更新已定稿版。",
    draft_ready: "工作稿已生成。请先阅读，再做硬伤检查或生成定稿预览。",
    quality_checked: "硬伤检查完成。若没有阻断问题，可以生成定稿预览。",
    commit_preview_ready: "定稿预览已生成。说「确认定稿」将写入已定稿版，可在操作历史撤销。",
    waiting_commit_confirmation: "定稿预览已生成。说「确认定稿」即可写入，可在操作历史撤销。",
    committed: "本章已定稿。可以继续下一章。",
    ready_for_next: "已进入新章节。你可以先说本章方向，也可以让系统整理本章方案。",
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
