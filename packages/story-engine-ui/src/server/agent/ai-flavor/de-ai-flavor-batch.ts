/**
 * de-ai-flavor-batch —— 「AI 味一键全修」纯核心（题材中立·绝不静默失败·复用 eeee025 span 定位）。
 *
 * 为什么存在：check_ai_flavor 已挑出逐条可定位的 AI 腔句（violation.text=草稿子串），但只能一句句
 * revise_draft 手动改（Codex 真机痛点「费劲巴拉」+ spec 2026-06-18 当时判不做按钮，用户 2026-06-29 反转）。
 * 这里把「批量改写 + 多 span 倒序落盘 + 诚实回报」做成纯函数，由工具/REST 端点接磁盘与快照。
 *
 * 设计要点：
 *   - 改写文本由一次【批量模型调用】产出（喂全部违规句 + novel-deslop 方法论），模型能看到全部、改得更一致。
 *   - 落盘用 locateTargetSpan（含空白/引号归一兜底）逐条定位 → **按 start 倒序一次性切片替换**：
 *     前一处改动不会让后一处的字符区间漂移（顺序替换的经典 bug）。
 *   - 诚实：not_found / ambiguous / noop / overlap 一律跳过并计数，绝不谎报「全改了」（铁律④）。
 */
import { z } from "zod";
import { locateTargetSpan } from "../tools/revise-draft.js";
import type { AiFlavorViolation } from "./ai-flavor-check.js";

export interface DeAiRewrite {
  readonly text: string;       // 要替换的原句（应为草稿子串）
  readonly afterText: string;  // 改后文本
}

export type DeAiSkipReason = "not_found" | "ambiguous" | "noop" | "overlap";

export interface DeAiApplyResult {
  readonly updatedContent: string;
  readonly applied: readonly { readonly before: string; readonly after: string }[];
  readonly skipped: readonly { readonly text: string; readonly reason: DeAiSkipReason }[];
}

/**
 * 纯函数：把 [{text, afterText}] 批量落到 draftContent。
 * 逐条 locate → 丢 not_found/ambiguous/noop → 去重叠 → **按 start 倒序切片替换**（防漂移）。
 * applied 按原文出现顺序返回（供 UI 高亮/计数）。
 */
export function applyDeAiBatch(draftContent: string, rewrites: readonly DeAiRewrite[]): DeAiApplyResult {
  const skipped: { text: string; reason: DeAiSkipReason }[] = [];
  const located: { start: number; end: number; before: string; after: string }[] = [];
  for (const r of rewrites) {
    const span = locateTargetSpan(draftContent, r.text);
    if (span === "not_found") { skipped.push({ text: r.text, reason: "not_found" }); continue; }
    if (span === "ambiguous") { skipped.push({ text: r.text, reason: "ambiguous" }); continue; }
    const before = draftContent.slice(span.start, span.end);
    const after = r.afterText.trim();
    if (!after || after === before.trim()) { skipped.push({ text: r.text, reason: "noop" }); continue; }
    located.push({ start: span.start, end: span.end, before, after });
  }
  // 去重叠：按 start 升序，后一个起点落在前一个区间内 → 跳过（避免切片互相吃掉）。
  located.sort((a, b) => a.start - b.start);
  const nonOverlap: typeof located = [];
  let lastEnd = -1;
  for (const item of located) {
    if (item.start < lastEnd) { skipped.push({ text: item.before, reason: "overlap" }); continue; }
    nonOverlap.push(item);
    lastEnd = item.end;
  }
  // 倒序落盘：从后往前切片替换，前面的 start/end 保持有效。
  let updated = draftContent;
  for (const item of [...nonOverlap].sort((a, b) => b.start - a.start)) {
    updated = updated.slice(0, item.start) + item.after + updated.slice(item.end);
  }
  const applied = nonOverlap.map((i) => ({ before: i.before, after: i.after })); // 原文顺序
  return { updatedContent: updated, applied, skipped };
}

const batchSchema = z.object({
  rewrites: z.array(z.object({
    text: z.string().trim().min(1),
    afterText: z.string().trim().default(""),
  }).strict().partial({ afterText: true })).default([]),
}).strict();

/** 解析模型批量改写 JSON；text 必须是草稿子串、afterText 非空且与原句不同，否则丢弃（保证能定位+真有改动）。 */
export function parseDeAiBatchRewrites(modelText: string, draftText: string): readonly DeAiRewrite[] {
  try {
    const match = modelText.match(/\{[\s\S]*\}/u);
    if (!match) return [];
    const parsed = batchSchema.parse(JSON.parse(match[0]));
    const out: DeAiRewrite[] = [];
    for (const r of parsed.rewrites) {
      const afterText = (r.afterText ?? "").trim();
      if (!afterText) continue;
      if (!draftText.includes(r.text)) continue;
      if (afterText === r.text.trim()) continue;
      out.push({ text: r.text, afterText });
    }
    return out;
  } catch {
    return [];
  }
}

/** novel-deslop 方法论批量改写 prompt：6 门禁 + 改最少字 + show-don't-tell + 不动剧情 + 结构化输出。 */
export function buildDeAiRewriteMessages(
  violations: readonly AiFlavorViolation[],
  antiRules: readonly string[],
): { readonly role: "system" | "user"; readonly content: string }[] {
  const system = [
    "你是中文小说『去 AI 味』改写专家。下面给你若干条有 AI 腔的原句，逐条改写成自然、像人写的。",
    "核心纪律（务必遵守）：",
    "1. 改最少字：能改一个词就不改一句，能删就删；不是重写，是把『味』改过来。",
    "2. 不动剧情/人设/信息：只改『怎么说』，不改『说什么』，afterText 必须保留原句承载的剧情与信息。",
    "3. show, don't tell：把命名情绪（很紧张/愤怒）换成具体动作或身体反应；把套路表情/心理词换成可见细节。",
    "4. 去禁用词与套路：删『仿佛/不禁/缓缓/一丝/深吸一口气/眼中闪过/这一刻终于明白』等套话；拆『不是…而是』『虽然…但是』；去『，带着…的』万能状语；结尾用具体动作收尾，不升华。",
    "5. 对话口语化、按角色区分语气；比喻生活化，别用『如寒冰般』套路。",
    ...(antiRules.length > 0 ? ["", "本项目额外的反 AI / 写作规则（一并遵守）：", ...antiRules.slice(0, 20).map((r, i) => `- ${r}`)] : []),
    "",
    "只输出一个 JSON：{\"rewrites\":[{\"text\":\"<原句，逐字照抄、与给你的完全一致>\",\"afterText\":\"<改后句>\"}]}。",
    "text 必须与给你的原句一字不差（用于定位）；afterText 是改后的句子。改不动的就别放进 rewrites。不要 Markdown、不要解释。",
  ].join("\n");
  const list = violations.map((v, i) => `${i + 1}. ${v.text}${v.suggestedFix ? `（方向：${v.suggestedFix}）` : ""}`).join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: `【要去 AI 味的原句】\n${list}` },
  ];
}

/** 跳过计数的按原因分布（generate_draft 自动去味要如实进 autoDeAi.skipped；各键之和恒等于 skipped）。 */
export interface DeAiSkippedByReason {
  readonly notFound: number;
  readonly ambiguous: number;
  readonly noop: number;
  readonly overlap: number;
  /** 模型没给有效改写（没返回这条 / afterText 为空或与原句相同 / text 不在草稿里被解析层丢弃）。 */
  readonly noRewrite: number;
}

export interface DeAiBatchResult {
  readonly ok: boolean;
  readonly detected: number;
  readonly rewritten: number;
  readonly skipped: number;
  readonly skippedByReason: DeAiSkippedByReason;
  readonly changes: readonly { readonly before: string; readonly after: string }[];
  readonly updatedContent: string;
  readonly summary: string;
  /** 改写模型调用失败的原始错误信息（仅 ok:false 时带），供调用方如实上报。 */
  readonly error?: string;
}

const EMPTY_SKIPPED_BY_REASON: DeAiSkippedByReason = { notFound: 0, ambiguous: 0, noop: 0, overlap: 0, noRewrite: 0 };

/** applyDeAiBatch 的 snake_case 跳过原因 → 报告用 camelCase 计数键。 */
function countApplySkipped(skipped: readonly { readonly reason: DeAiSkipReason }[]): DeAiSkippedByReason {
  const counts = { ...EMPTY_SKIPPED_BY_REASON };
  for (const s of skipped) {
    if (s.reason === "not_found") counts.notFound += 1;
    else if (s.reason === "ambiguous") counts.ambiguous += 1;
    else if (s.reason === "noop") counts.noop += 1;
    else counts.overlap += 1;
  }
  return counts;
}

/**
 * 编排：违规句 → 一次批量改写模型调用 → 解析 → applyDeAiBatch 倒序落盘 → 诚实回报。
 * 不碰磁盘（updatedContent 交由调用方写盘 + 快照）。callModel 注入，便于单测。
 */
export async function runDeAiFlavorBatch(input: {
  readonly draftText: string;
  readonly violations: readonly AiFlavorViolation[];
  readonly callModel: (prompt: string) => Promise<string>;
  readonly antiRules?: readonly string[];
}): Promise<DeAiBatchResult> {
  const draftText = input.draftText;
  if (!draftText.trim()) {
    return { ok: false, detected: 0, rewritten: 0, skipped: 0, skippedByReason: EMPTY_SKIPPED_BY_REASON, changes: [], updatedContent: draftText, summary: "本章还没正文，先出稿再一键去 AI 味。" };
  }
  const detected = input.violations.length;
  if (detected === 0) {
    return { ok: true, detected: 0, rewritten: 0, skipped: 0, skippedByReason: EMPTY_SKIPPED_BY_REASON, changes: [], updatedContent: draftText, summary: "没挑出 AI 腔，无需一键全修。" };
  }
  let modelText: string;
  try {
    modelText = await input.callModel(buildDeAiRewriteMessages(input.violations, input.antiRules ?? []).map((m) => m.content).join("\n\n"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false, detected, rewritten: 0, skipped: detected,
      skippedByReason: { ...EMPTY_SKIPPED_BY_REASON, noRewrite: detected },
      changes: [], updatedContent: draftText,
      summary: `一键全修没成：改写模型没跑成（${message}），原稿没动，可重试或逐句手动改。`,
      error: message,
    };
  }
  const rewrites = parseDeAiBatchRewrites(modelText, draftText);
  const { updatedContent, applied, skipped: applySkipped } = applyDeAiBatch(draftText, rewrites);
  const rewritten = applied.length;
  const skipped = detected - rewritten;
  const skippedByReason = { ...countApplySkipped(applySkipped), noRewrite: Math.max(0, detected - rewrites.length) };
  const summary = rewritten > 0
    ? `一键全修：${detected} 处 AI 腔，改了 ${rewritten} 处${skipped > 0 ? `，${skipped} 处没动（没定位到 / 与原句无异 / 重复 / 模型没给有效改写）` : ""}。`
    : `一键全修没改动：${detected} 处都没能安全替换（模型没给有效改写或定位不到），原稿没动，可逐句手动改。`;
  return { ok: true, detected, rewritten, skipped, skippedByReason, changes: applied, updatedContent, summary };
}
