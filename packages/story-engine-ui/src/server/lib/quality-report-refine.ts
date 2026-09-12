/**
 * quality-report-refine —— 质检报告分层 + 软误报降级（产品内核·内置·UI 侧·引擎零改）。
 *
 * 治用户痛点（2026-06-25）：质检「软误报噪音」——引擎 checkDraftBeforeCommit 产一堆 warning/info，
 * 旧 summary 笼统说成「有 X 条提醒」，英文 message，把真正拦入库的硬伤淹了。对标 inkos：
 *   - **分层**：硬伤(error·拦入库) / 软提示(warning·参考不拦) / 参考(info)。
 *   - **软误报降级**（inkos smoke_relaxed 思路）：确属"装饰性/非正文质量"的 warning → 降成参考(info)，留痕透明。
 *   - **规则透明**：每个引擎 type 映射成中文标签（像 inkos 的命名规则清单）。
 *
 * 内置常量（与 builtin-anti-ai-rules 同观）：标签表 / 降级表是我们的内置规则，只我们改、用户不可调。
 * 纯函数、确定性、不调 LLM、不改 passed（只动 warning↔info，硬伤一律不碰）。
 */
import type { CommitQualityIssue, CommitQualityReport } from "@actalk/story-engine";

type Severity = CommitQualityIssue["severity"];

/**
 * 内置：引擎 issue.type → 中文标签（规则透明，像 inkos 的命名维度）。未收录的 type 原样显示。
 * ⚠️ type 名以引擎 commit-quality-check.ts / continuity-quality-check.ts 实际发出的为准（实测核对过，别猜）。
 */
export const QUALITY_TYPE_LABELS: Readonly<Record<string, string>> = {
  // 硬伤（error）
  empty_draft: "正文为空",
  draft_not_found_for_check: "还没有正文可质检",
  tool_or_json_artifact: "像工具/JSON 产物、不是正文",
  title_only: "只有标题没正文",
  too_short: "正文过短",
  model_explanation: "夹带模型解释/拒答话术",
  missing_character_name: "没出现任何已知角色名",
  // 格式/装饰
  missing_chapter_title: "缺章节标题",
  no_dialogue: "通篇无对话",
  // 入库元数据
  semantic_chapter_summary_missing: "定稿缺本章摘要",
  semantic_key_events_missing: "定稿缺关键事件",
  semantic_timeline_missing: "定稿缺时间线事件",
  semantic_timeline_summary_generic: "时间线摘要太笼统",
  // 一致性/设定漂移（writing_context_*）
  writing_context_age_drift: "角色年龄与设定不符",
  writing_context_first_chapter_setup_missing: "没铺第一章设定",
  writing_context_floor_structure_conflict: "楼层/空间结构冲突",
  writing_context_forbidden_reveal: "提前泄露了禁止揭示的秘密",
  writing_context_identity_detail_drift: "身份细节与设定漂移",
  writing_context_knowledge_boundary: "角色越界知道了不该知道的",
  writing_context_location_drift: "地点与本章设定漂移",
  writing_context_required_location_missing: "没用到本章要求的地点",
  writing_context_setup_asset_missing: "没用到本章应出现的道具",
  writing_context_speech_style_risk: "说话风格与人设有出入",
  writing_context_travel_rule_violation: "违反移动/路程规则",
  writing_context_unavailable_asset_used: "用了当前不可用的道具",
  cross_chapter_pronoun_drift: "跨章代词指代漂移",
  // 连贯性「没接到/没提到 X」家族（continuity-quality-check）
  arc_goals_not_referenced: "没呼应当前卷目标",
  open_intents_not_referenced: "没接任何角色未了意图",
  open_leads_not_referenced: "没接任何未收口线索",
  open_threads_not_referenced: "没接任何未收口故事线",
  recent_characters_not_referenced: "没提到近期出场角色",
  recent_events_not_referenced: "没轻带近期剧情",
  recent_locations_not_referenced: "没提到近期地点",
  possible_homogeneous_loop_repetition: "动作原地打转",
  possible_repeated_paragraph: "句子/相邻段高度重复",
  possible_restart: "疑似另起炉灶没接上文",
};

/**
 * 内置：软误报降级表——把"装饰性/非正文质量"+"子串匹配高误报、低风险"的 warning → 降成参考(info)，附透明留痕。
 * **不降**可能是真问题的：`*_drift`（年龄/身份/地点/代词漂移可能是真矛盾）、`forbidden_reveal`/`knowledge_boundary`/
 * `unavailable_asset_used`/`travel_rule_violation` 等硬设定违规、`possible_*`（原地打转/重复/重启正是要抓的）——
 * 它们仍当软提示（可见、框成"参考不拦"，但不压成参考）。error 硬伤一律不碰。
 */
export const QUALITY_DOWNGRADE_RULES: Readonly<Record<string, { readonly to: Severity; readonly note: string }>> = {
  missing_chapter_title: { to: "info", note: "标题可在定稿时自动补，非正文质量问题" },
  no_dialogue: { to: "info", note: "无对话不一定是问题（过场/独白章正常）" },
  semantic_timeline_summary_generic: { to: "info", note: "时间线摘要措辞，非正文质量" },
  // 「没提到/没接到 X」家族：靠子串匹配，角色用代称、线索隐性推进时极易误报，且低风险 → 降参考。
  recent_characters_not_referenced: { to: "info", note: "近期角色靠子串匹配，代称/换名常误报" },
  recent_locations_not_referenced: { to: "info", note: "近期地点靠子串匹配，常误报" },
  recent_events_not_referenced: { to: "info", note: "近期剧情靠子串匹配，常误报" },
  open_leads_not_referenced: { to: "info", note: "线索常隐性推进，子串匹配易误报" },
  open_threads_not_referenced: { to: "info", note: "故事线常隐性推进，子串匹配易误报" },
  open_intents_not_referenced: { to: "info", note: "角色意图常隐性推进，子串匹配易误报" },
  arc_goals_not_referenced: { to: "info", note: "卷目标常隐性呼应，子串匹配易误报" },
};

export interface RefinedQualityIssue {
  readonly type: string;
  readonly label: string;
  readonly severity: Severity;
  readonly message: string;
  /** 被降级时的留痕原因（透明，不静默压制）。 */
  readonly downgradeNote?: string;
}

export interface RefinedQualityReport {
  /** 与引擎一致：无未消解的 error 即通过（降级只动 warning↔info，不影响此判定）。severe 不影响 passed（不硬拦·守可撤销）。 */
  readonly passed: boolean;
  readonly blocking: readonly RefinedQualityIssue[];   // error·拦入库
  /** AI 判定 confirmed+high 的非 error 问题：严重但不硬拦（强烈建议先改）。治「可入库」与严重问题并列读着矛盾。 */
  readonly severe: readonly RefinedQualityIssue[];
  readonly soft: readonly RefinedQualityIssue[];        // warning·软提示（参考不拦），不含 severe
  readonly reference: readonly RefinedQualityIssue[];   // info·参考
  readonly downgraded: readonly RefinedQualityIssue[];  // 本次被降级的软误报（透明留痕）
  /** 分层人话摘要（不带章号，调用方自行前缀「第N章质检：」）。 */
  readonly summary: string;
}

const labelOf = (type: string): string => QUALITY_TYPE_LABELS[type] ?? type;

/**
 * 严重度信号取自 AI 判定层（题材中立）：verdict=confirmed 且「该改」——severity=high，**或** AI 明确建议
 * 修改/需确认（recommendedAction=revise / require_confirmation）。
 * retest 教训：只认 high 太窄——Codex 真机里「能力使用违规·建议修改后再入库」是 confirmed+medium+revise，
 * 漏出 severe 档 → 又出现「✅ 可入库」与「建议修改后再入库」并存。把「AI 已确认且建议先改」一并升 severe。
 * 不靠 type/题材词（forbidden_reveal 等靠子串匹配、误报率高，引擎刻意定为 warning）；uncertain/dismissed/
 * ignore/watch 一律不升（避免把中危噪音抬成严重）。
 */
const isAiConfirmedSevere = (issue: CommitQualityIssue): boolean => {
  const j = issue.judgement;
  if (j?.verdict !== "confirmed") return false;
  return j.severity === "high" || j.recommendedAction === "revise" || j.recommendedAction === "require_confirmation";
};

/** 把引擎质检报告分层 + 软误报降级。纯确定性。 */
export function refineQualityReport(report: CommitQualityReport): RefinedQualityReport {
  // 1) 去重（同 type+message 只留一条）+ 跳过已 dismissed。
  const seen = new Set<string>();
  const deduped: CommitQualityIssue[] = [];
  for (const issue of report.issues) {
    if (issue.userDisplayCategory === "dismissed") continue;
    const key = `${issue.type}|${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(issue);
  }

  // 2) 软误报降级（只降 warning→更低；硬伤 error 一律不碰）。
  const downgraded: RefinedQualityIssue[] = [];
  const refined: RefinedQualityIssue[] = deduped.map((issue) => {
    const rule = QUALITY_DOWNGRADE_RULES[issue.type];
    if (rule && issue.severity === "warning") {
      const item: RefinedQualityIssue = { type: issue.type, label: labelOf(issue.type), severity: rule.to, message: issue.message, downgradeNote: rule.note };
      downgraded.push(item);
      return item;
    }
    return { type: issue.type, label: labelOf(issue.type), severity: issue.severity, message: issue.message };
  });

  // 3) 分层（refined[i] 与 deduped[i] 同序，severe 用原始 issue 的 AI 判定分）。
  const blocking: RefinedQualityIssue[] = [];
  const severe: RefinedQualityIssue[] = [];
  const soft: RefinedQualityIssue[] = [];
  const reference: RefinedQualityIssue[] = [];
  refined.forEach((item, i) => {
    if (item.severity === "error") { blocking.push(item); return; }
    if (item.severity === "info") { reference.push(item); return; }
    // warning：AI 判定 confirmed+high → severe（严重但不拦），否则普通软提示。
    if (isAiConfirmedSevere(deduped[i]!)) severe.push(item);
    else soft.push(item);
  });
  const passed = blocking.length === 0; // severe 不拦入库（守「直接做+可撤销」），只治误导措辞

  // 4) 分层人话摘要。severe 存在时绝不把头部读成「✅ 没硬伤、可入库」（治自相矛盾）。
  const parts: string[] = [];
  if (!passed) {
    parts.push(`❌ ${blocking.length} 处硬伤拦着定稿：${blocking.map((i) => i.label).join("、")}。先改这些再定稿`);
    if (severe.length > 0) {
      parts.push(`另有 ${severe.length} 处严重问题：${severe.map((i) => i.label).join("、")}`);
    }
  } else if (severe.length > 0) {
    parts.push(`⚠️ 没有拦截定稿的硬伤，但有 ${severe.length} 处严重问题（AI 已确认/判为高风险），强烈建议先改再定稿：${severe.map((i) => i.label).join("、")}（可以继续定稿，但请知悉）`);
  } else {
    parts.push("✅ 没硬伤、可以定稿");
  }
  if (soft.length > 0) {
    parts.push(`另有 ${soft.length} 处软提示（参考、不拦）：${soft.map((i) => i.label).join("、")}`);
  }
  if (reference.length > 0) {
    parts.push(`${reference.length} 处仅参考${downgraded.length > 0 ? `（含 ${downgraded.length} 处已自动降噪）` : ""}`);
  }
  const summary = `${parts.join("；")}。`;

  return { passed, blocking, severe, soft, reference, downgraded, summary };
}
