/**
 * ai-flavor-check — 纯逻辑：去 AI 味体检的提示词组装 + 模型输出解析 + 编排。
 *
 * 只读、题材中立、绝不静默失败：
 *   - parseAiFlavorReport：解析模型 JSON；**原句 text 必须逐字出现在草稿里（草稿子串）**，
 *     否则丢弃该条（保证下游「改掉这句」能在草稿里定位）。任何异常 → ok:false，不编造违规。
 *   - runAiFlavorCheck：空稿诚实回报 ok:false；有稿则注入 callModel 调模型再解析。
 *
 * callModel 注入式（单 prompt 字符串），与 tools/ai-review.ts 的 callModel 同构，便于单测 mock。
 */
import { z } from "zod";
import { detectAiFlavorRules } from "./ai-flavor-rules.js";
import { rethrowIfStopped } from "../../lib/operations/context.js";

const SEVERITY_RANK: Readonly<Record<AiFlavorViolation["severity"], number>> = { high: 3, medium: 2, low: 1 };

export type AiFlavorViolation = {
  readonly id: string;
  readonly text: string;        // AI 腔原句，逐字取自草稿、草稿内唯一
  readonly reason: string;      // 为什么是 AI 腔 / 踩了哪条规则
  readonly severity: "high" | "medium" | "low";
  readonly suggestedFix?: string;
};
export type AiFlavorReport = {
  readonly ok: boolean;
  readonly summary: string;
  readonly violations: readonly AiFlavorViolation[];
  readonly usedFallback: boolean;
};

export type AiFlavorCallModel = (prompt: string) => Promise<string>;

const MAX_VIOLATIONS = 8;

const violationSchema = z.object({
  text: z.string().trim().min(1),
  reason: z.string().trim().min(1),
  severity: z.enum(["high", "medium", "low"]).default("medium"),
  suggestedFix: z.string().trim().optional(),
}).strict().partial({ suggestedFix: true });

const reportSchema = z.object({
  summary: z.string().trim().default(""),
  violations: z.array(violationSchema).default([]),
}).strict();

/** 通用 AI 腔判据（项目没配反 AI 规则时兜底）。中性、不预设题材。 */
export const GENERIC_AI_FLAVOR_CRITERIA: readonly string[] = [
  "空泛形容词堆砌（如『美丽动人』『复杂的情绪』），缺具体可感细节",
  "套路化排比与升华总结句、强行拔高",
  "滥用『仿佛/似乎/不禁/那一刻/心中五味杂陈/如潮水般』等被用烂的过渡与抒情",
  "否定对比/弱转折壳句式：『不是…而是』『虽然…但是』『尽管…却』，以及『，带着…的…』万能状语",
  "情绪直接命名（『他很紧张/愤怒/悲伤』）而非用动作展示（show, don't tell）",
  "对话同质化：几乎每句都带『说道』、所有人语气一个样、纯台词无动作；比喻文学化套路（如寒冰般）",
  "有限视角里滑入全知视角，写出聚焦角色看不到的他人心理",
  "解释性总结句：替读者把情绪/含义说破，而非用场景呈现",
  "结尾强行升华/金句收束，而非用一个具体动作或感官细节自然结束",
  "句式单调、长度无变化，读起来像翻译腔/报告腔",
];

export function buildAiFlavorCheckMessages(
  draftText: string,
  antiRules: readonly string[],
  establishedElements: readonly string[] = [],
): { readonly role: "system" | "user"; readonly content: string }[] {
  const criteria = antiRules.length > 0 ? antiRules : GENERIC_AI_FLAVOR_CRITERIA;
  // 跨章已建立要素（往章登记的道具/资产 + 已确立硬事实）。喂给 LLM，避免它把前文铺垫过的东西
  // 误判成「道具天降/凭空出现/前文毫无铺垫」（Codex 组合复测 P2：第3章把第1、2章已建立的「黑色胶带」判天降）。
  // 体检只看当前章正文，看不到前文——这段就是它的跨章记忆。空则不注入，向后兼容。
  const establishedBlock = establishedElements.length > 0
    ? [
        "",
        "【前文已建立要素（往章已交代的人物/道具/设定与硬事实）】",
        ...establishedElements.map((e) => `- ${e}`),
        "注意：以上要素已在前文（往章）建立，本章再次出现属于正常承接，**不要**把它们判成「道具天降 / 凭空出现 / 前文毫无铺垫」。" +
          "只对真正本章首次出现、且前文从未交代的新人新物，才考虑「无铺垫」类问题。",
      ]
    : [];
  const system = [
    "你是中文小说的『去 AI 味』体检员。只读，不改稿。逐句读下面这章正文，挑出真正有『AI 腔』的句子。",
    "判据（按这些来判，不要无中生有）：",
    ...criteria.map((c, i) => `${i + 1}. ${c}`),
    ...establishedBlock,
    "",
    `只挑真有问题的，最多 ${MAX_VIOLATIONS} 条，按严重度从高到低排。读着像人写的就别硬凑。`,
    "每条：text=有 AI 腔的原句（**必须逐字照抄正文、一字不差、能在正文里唯一定位**，别改写别合并别加引号）；reason=为什么是 AI 腔（踩了上面哪条）；severity=high/medium/low；suggestedFix=一句话改写方向。",
    "只输出一个 JSON：{\"summary\":\"一句话总评（这章 AI 味整体重不重）\",\"violations\":[{\"text\":\"\",\"reason\":\"\",\"severity\":\"\",\"suggestedFix\":\"\"}]}。不要 Markdown、不要解释。",
  ].join("\n");
  return [{ role: "system", content: system }, { role: "user", content: `【本章正文】\n${draftText}` }];
}

/** 解析模型 JSON；过滤掉 text 不在草稿里的（保证能改写定位）；任何异常→ok:false 不编造，summary 是没成的原因。 */
export function parseAiFlavorReport(modelText: string, draftText: string, usedFallback: boolean): AiFlavorReport {
  try {
    const match = modelText.match(/\{[\s\S]*\}/u);
    if (!match) return { ok: false, summary: "模型没交回能读的结果", violations: [], usedFallback };
    const parsed = reportSchema.parse(JSON.parse(match[0]));
    const violations: AiFlavorViolation[] = [];
    parsed.violations.forEach((v, i) => {
      if (!draftText.includes(v.text)) return; // 原句不在草稿里→丢弃，避免改写时定位不到
      violations.push({
        id: `aiflavor-${i}`,
        text: v.text,
        reason: v.reason,
        severity: v.severity,
        ...(v.suggestedFix ? { suggestedFix: v.suggestedFix } : {}),
      });
    });
    return { ok: true, summary: parsed.summary || (violations.length ? "挑出几处机器腔，见下。" : "这章读着挺像人写的，没挑出明显的机器腔。"), violations: violations.slice(0, MAX_VIOLATIONS), usedFallback };
  } catch {
    return { ok: false, summary: "模型交回的结果读不了", violations: [], usedFallback };
  }
}

/**
 * 合并确定性闸 + LLM 复检：
 *   - 确定性命中(高精度)优先排前；LLM 命中里凡与确定性同句/互为子串的去掉，避免对同一处重复报。
 *   - ok = 确定性有命中 或 LLM 成功；两者都空且 LLM 没跑成 → ok:false 诚实回报（铁律④，不编造"没问题"）。
 *   - LLM 没跑成时 llm.summary 是原因，照实带给作者（别只说「失败」）。
 */
export function mergeAiFlavorReports(
  deterministic: readonly AiFlavorViolation[],
  llm: AiFlavorReport,
): AiFlavorReport {
  const merged: AiFlavorViolation[] = [...deterministic];
  for (const v of llm.violations) {
    if (merged.some((d) => d.text.includes(v.text) || v.text.includes(d.text))) continue;
    merged.push(v);
  }
  const sorted = merged
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
    .slice(0, MAX_VIOLATIONS);
  const ok = deterministic.length > 0 || llm.ok;
  let summary: string;
  if (llm.ok) {
    // LLM 跑成了：但它 summary 里自报的「N 处」是它合并前的自评，与最终 violations（确定性闸 + LLM 去重合并后）
    // 数对不上（Codex 1-5 章真机：嘴说 6 处、卡片 7 条）。处数一律由真值 sorted 派生，只保留 LLM 的定性评语。
    summary = composeAiFlavorSummary(sorted);
  } else {
    const said = llm.summary.trim() || "模型这遍没交出结果";
    const reason = said.endsWith("。") ? said.slice(0, -1) : said;
    // LLM 没跑成，但确定性闸有硬命中 → 兜底如实报（谎报-proof）。
    summary = sorted.length > 0
      ? `按规则挑出 ${sorted.length} 处机器腔，先看这些；模型那遍没跑成（${reason}）。`
      : `体检没跑成：${reason}。可以再试一次。`;
  }
  return { ok, summary, violations: sorted, usedFallback: false };
}

/**
 * summary 永远由真值 violations 派生。LLM 自己写的总评常带它合并前自报的「N 处」，和最终条数对不上；
 * 原来用正则剥掉那半句，重构 P7「不猜」后不再拆模型的话，总评整句不用。
 */
function composeAiFlavorSummary(violations: readonly AiFlavorViolation[]): string {
  if (violations.length === 0) {
    return "这章读着挺像人写的，没挑出明显的机器腔。";
  }
  const high = violations.filter((v) => v.severity === "high").length;
  const medium = violations.filter((v) => v.severity === "medium").length;
  const low = violations.filter((v) => v.severity === "low").length;
  const breakdown = [high && `${high}重`, medium && `${medium}中`, low && `${low}轻`].filter(Boolean).join("、");
  const countClause = `挑出 ${violations.length} 处机器腔${breakdown ? `（${breakdown}）` : ""}，逐条见下方卡片。`;
  return countClause;
}

export async function runAiFlavorCheck(input: {
  readonly draftText: string;
  readonly antiRules: readonly string[];
  readonly callModel: AiFlavorCallModel;
  readonly establishedElements?: readonly string[];
}): Promise<AiFlavorReport> {
  if (!input.draftText.trim()) {
    return { ok: false, summary: "本章还没正文，先出稿再体检 AI 味。", violations: [], usedFallback: false };
  }
  // 确定性闸先行（内置规则、零 LLM、永远能跑），再叫 LLM 补主观判断；LLM 挂了也有确定性兜底（谎报-proof）。
  const deterministic = detectAiFlavorRules(input.draftText);
  let llm: AiFlavorReport;
  try {
    const text = await input.callModel(buildAiFlavorCheckMessages(input.draftText, input.antiRules, input.establishedElements ?? []).map((m) => m.content).join("\n\n"));
    llm = parseAiFlavorReport(text, input.draftText, false);
  } catch (error) {
    rethrowIfStopped(error);
    llm = { ok: false, summary: error instanceof Error ? error.message : String(error), violations: [], usedFallback: false };
  }
  return mergeAiFlavorReports(deterministic, llm);
}
