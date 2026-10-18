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
import type { CommitQualityIssue, CommitQualityReport } from "../writing/commit-quality-check.js";

type Severity = CommitQualityIssue["severity"];

/**
 * 内置：引擎 issue.type → 中文标签（规则透明，像 inkos 的命名维度）。未收录的 type 原样显示。
 * ⚠️ type 名以引擎 commit-quality-check.ts 实际发出的为准（重构 P7 删了靠词表猜的连续性规则，这里只剩硬检查）。
 */
export const QUALITY_TYPE_LABELS: Readonly<Record<string, string>> = {
  // 硬伤（error）
  empty_draft: "正文为空",
  draft_not_found_for_check: "还没有正文可做硬伤检查",
  tool_or_json_artifact: "像工具/JSON 产物、不是正文",
  title_only: "只有标题没正文",
  too_short: "正文过短",
  missing_character_name: "没出现任何已知角色名",
  // 格式/装饰
  missing_chapter_title: "缺章节标题",
  no_dialogue: "通篇无对话",
};

/**
 * 内置：软误报降级表——把"装饰性/非正文质量"的 warning → 降成参考(info)，附透明留痕。error 硬伤一律不碰。
 */
export const QUALITY_DOWNGRADE_RULES: Readonly<Record<string, { readonly to: Severity; readonly note: string }>> = {
  missing_chapter_title: { to: "info", note: "标题可在定稿时自动补，非正文质量问题" },
  no_dialogue: { to: "info", note: "无对话不一定是问题（过场/独白章正常）" },
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
  /** 原来是 AI 判定 confirmed+high 的问题；判定层已删（重构 P7），恒为空。 */
  readonly severe: readonly RefinedQualityIssue[];
  readonly soft: readonly RefinedQualityIssue[];        // warning·软提示（参考不拦），不含 severe
  readonly reference: readonly RefinedQualityIssue[];   // info·参考
  readonly downgraded: readonly RefinedQualityIssue[];  // 本次被降级的软误报（透明留痕）
  /** 分层人话摘要（不带章号，调用方自行前缀「第N章质检：」）。 */
  readonly summary: string;
}

const labelOf = (type: string): string => QUALITY_TYPE_LABELS[type] ?? type;

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

  // 3) 分层。severe 原来由 AI 判定层给（重构 P7 已删），留着字段给老卡片兼容，恒为空。
  const blocking: RefinedQualityIssue[] = [];
  const severe: readonly RefinedQualityIssue[] = [];
  const soft: RefinedQualityIssue[] = [];
  const reference: RefinedQualityIssue[] = [];
  for (const item of refined) {
    if (item.severity === "error") blocking.push(item);
    else if (item.severity === "info") reference.push(item);
    else soft.push(item);
  }
  const passed = blocking.length === 0; // severe 不拦入库（守「直接做+可撤销」），只治误导措辞

  // 4) 分层人话摘要。
  const parts: string[] = [];
  if (!passed) {
    parts.push(`${blocking.length} 处硬伤拦着定稿：${blocking.map((i) => i.label).join("、")}。先改这些再定稿`);
  } else {
    parts.push("没硬伤、可以定稿");
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
