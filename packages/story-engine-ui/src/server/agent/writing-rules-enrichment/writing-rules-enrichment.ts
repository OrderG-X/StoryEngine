/**
 * 写作规则做厚（enrichment）——给项目「已有的写作规则 / 叙事契约」补两类 UI 展示层厚字段：
 *   ① 风格特征指纹（fingerprints：本书风格可识别度量化条，如「奢靡物质铺陈 88」）
 *   ② 反 AI 写作规则（antiRules：审稿检查项——禁用 / 风险 / 鼓励，带严重度）
 *
 * 设计动机 & 与 worldbuilding 的关键差异（2026-06-17）：worldbuilding 从「种子」凭空生成；
 * enrichment 必须从「项目现有规则」出发——把本书题材 / 现有 writingRules 清单（叙事视角 / 文风 / 节奏 /
 * 禁止内容 / 反 AI 倾向）注入提示词，让模型据真实规则量化出风格指纹、提炼出可执行的反 AI 规则，
 * 不许脱离本书既定风格凭空发挥。
 *
 * 与 asset-enrichment 的 keying 差异：本类是**书级**字段，没有按实体索引的键——两个产物都是数组
 * （fingerprints / antiRules），不是 Record。
 *
 * 落盘分两路：完整结构（fingerprints + antiRules）落 .story-engine-ui/writing-rules-enrichment.json 供面板展示；
 * 同时反 AI 规则按 type 并入 story/writing-rules.json 的 forbiddenContent/doNotDo/readerExperienceRules，
 * 进正文 prompt——下一章 AI 会真遵守（fingerprints 仅展示层，不入引擎）。
 *
 * 提示词与数据结构均为本项目原创（借鉴通用提示工程技法，不复制任何第三方文案/代码）。
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

import { semanticDedupRules } from "../enrichment-dedup.js";
import type { MergeResult } from "../enrichment-merge-result.js";
import { sanitizeBookStyleRuleLines } from "../../../shared/sparse-panel-honesty.js";
import { writeFileAtomic } from "../../lib/project-io.js";

const nonEmpty = z.string().trim().min(1);

export const writingRulesEnrichmentSchema = z.object({
  /** 风格特征指纹：本书风格可识别度量化条（label 维度名，value 0–100 强度）。 */
  fingerprints: z.array(z.object({
    label: nonEmpty,
    value: z.number().min(0).max(100),
  }).strict()).default([]),
  /** 反 AI 写作规则（审稿检查项）。 */
  antiRules: z.array(z.object({
    name: nonEmpty,
    desc: z.string().trim().default(""),
    type: z.enum(["forbidden", "risk", "encourage"]),
    severity: z.enum(["high", "medium", "low"]),
  }).strict()).default([]),
}).strict();

export type WritingRulesEnrichment = z.infer<typeof writingRulesEnrichmentSchema>;

/** 喂给提示词的「本书现有写作规则」上下文——题材 + 现有规则各维度，让模型据真实规则做厚。 */
export interface WritingRulesContextInput {
  readonly genre?: string;
  readonly narrativePerspective?: string;
  readonly proseStyle?: readonly string[];
  readonly pacing?: string;
  readonly revealPolicy?: string;
  readonly genreRequirements?: readonly string[];
  readonly forbiddenContent?: readonly string[];
  readonly doNotDo?: readonly string[];
  readonly readerExperienceRules?: readonly string[];
  readonly antiAiPatterns?: readonly string[];
}

export type ChatMessage = { readonly role: "system" | "user"; readonly content: string };
/** 注入式模型调用：传入消息，返回模型文本（应是一个 JSON 对象）。便于单测 mock。 */
export type CallModel = (messages: readonly ChatMessage[]) => Promise<string>;

/** 本书是否有任何可做厚的写作规则上下文（全空 → 没东西可厚）。 */
export function hasWritingRulesContext(ctx: WritingRulesContextInput): boolean {
  const lists = [
    ctx.proseStyle,
    ctx.genreRequirements,
    ctx.forbiddenContent,
    ctx.doNotDo,
    ctx.readerExperienceRules,
    ctx.antiAiPatterns,
  ];
  const strings = [ctx.genre, ctx.narrativePerspective, ctx.pacing, ctx.revealPolicy];
  return (
    strings.some((s) => Boolean(s && s.trim())) ||
    lists.some((l) => Boolean(l && l.some((x) => x && x.trim())))
  );
}

/**
 * 构造写作规则做厚生成消息（本项目原创提示词）。核心技法：只输出 JSON + 据本书既定风格量化 +
 * 禁脱离风格凭空发挥 + 指纹值 0–100 + 反 AI 规则要可执行 + type/severity 取固定枚举。
 */
export function buildWritingRulesEnrichmentMessages(ctx: WritingRulesContextInput): ChatMessage[] {
  const system = [
    "你是为长篇小说服务的『风格合同』助手。下面会给你这本书**已经定下**的写作规则与题材。",
    "你的任务：据这本书的既定风格做两件事——① 把它的风格可识别度量化成『风格指纹』强度条；② 提炼一组**本书个性化**的短规则（审稿检查项），不要重复产品内置的通用反 AI 条款。",
    "只输出一个合法 JSON 对象，不要 Markdown、不要解释、不要代码块。所有文字用简体中文。",
    "",
    "JSON 字段固定（不要增删字段名）：",
    "fingerprints[{label 风格维度名, value 0-100 的强度数值}]（数组，量化这本书最可识别的若干风格维度；value 越高代表本书在该维度越突出）",
    "antiRules[{name 规则名, desc 规则描述, type, severity}]（数组，本书个性化写作规则）",
    "  type 只能取三选一：forbidden（禁用）/ risk（风险）/ encourage（鼓励）",
    "  severity 只能取三选一：high / medium / low",
    "",
    "硬规则：",
    "1. 量化要贴合本书：fingerprints 必须从下方给定的本书风格 / 题材 / 文风关键词出发，不要套用与本书无关的通用维度；value 是 0 到 100 的整数。",
    "2. 个性化短规则：name/desc 写本书题材与资料里能落地的具体偏好，每条 desc ≤40 字；禁止输出『反AI·』前缀，禁止灌通用反 AI 长文墙（产品内置层已覆盖）。",
    "3. 别脱离本书风格凭空发挥：所有指纹与规则都要能在下方给定的规则 / 题材里找到依据。",
    "4. 数量适度：fingerprints 给 4–8 条；antiRules 给若干条真正有用的，质量优先于数量。",
    "5. 没有把握宁可少写也不要硬凑。",
  ].join("\n");

  const list = (label: string, values?: readonly string[]): string | null => {
    const clean = (values ?? []).map((v) => (v ?? "").trim()).filter(Boolean);
    return clean.length > 0 ? `${label}：${clean.join("、")}` : null;
  };
  const line = (label: string, value?: string): string | null => {
    const v = (value ?? "").trim();
    return v ? `${label}：${v}` : null;
  };

  const ctxLines = [
    line("本书题材", ctx.genre),
    line("叙事视角", ctx.narrativePerspective),
    list("文风关键词", ctx.proseStyle),
    line("整体节奏", ctx.pacing),
    line("信息揭示策略", ctx.revealPolicy),
    list("题材硬要求", ctx.genreRequirements),
    list("禁止内容", ctx.forbiddenContent),
    list("不要做（反模式）", ctx.doNotDo),
    list("读者体验规则", ctx.readerExperienceRules),
    list("已标注的反 AI 倾向", ctx.antiAiPatterns),
  ].filter((l): l is string => Boolean(l));

  const user = [
    "本书已经定下的写作规则与题材（只能据此做厚，所有指纹与反 AI 规则都要能在这里找到依据）：",
    ...(ctxLines.length > 0 ? ctxLines.map((l, i) => `${i + 1}. ${l}`) : ["（这本书还没填写作规则，请据题材给出最保守、最通用的量化与反 AI 规则）"]),
    "",
    "请据此输出写作规则做厚 JSON（fingerprints 量化本书风格，antiRules 给可执行的反 AI 规则）。",
  ].join("\n");

  return [{ role: "system", content: system }, { role: "user", content: user }];
}

/** 从模型文本里抠出 JSON 并校验。失败抛错（绝不静默放过半成品）。 */
export function parseWritingRulesEnrichment(text: string): WritingRulesEnrichment {
  const match = text.match(/\{[\s\S]*\}/u);
  if (!match) throw new Error("写作规则做厚结果不是 JSON。");
  const parsed = JSON.parse(match[0]) as unknown;
  return writingRulesEnrichmentSchema.parse(parsed);
}

/**
 * 把写作规则做厚结果的完整结构落到 UI 侧文件（.story-engine-ui/writing-rules-enrichment.json）供面板展示。
 * 注：反 AI 规则另由 mergeWritingRulesEnrichmentIntoEngine 并入 story/writing-rules.json、进正文 prompt（见下）。
 */
export async function persistWritingRulesEnrichment(
  projectDir: string,
  data: WritingRulesEnrichment,
): Promise<{ readonly artifactPath: string }> {
  const artifactPath = join(projectDir, ".story-engine-ui", "writing-rules-enrichment.json");
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFileAtomic(artifactPath, JSON.stringify(data, null, 2));
  return { artifactPath };
}

const TYPE_TO_FIELD: Record<"forbidden" | "risk" | "encourage", "forbiddenContent" | "doNotDo" | "readerExperienceRules"> = {
  forbidden: "forbiddenContent", risk: "doNotDo", encourage: "readerExperienceRules",
};

/**
 * 把反 AI 规则按 type **整组替换**进引擎 writing-rules.json 的对应字符串数组（已确认进正文 prompt）。
 * P0-4：做厚目标数组（forbiddenContent / doNotDo / readerExperienceRules）每次用本次生成结果整体替换，
 * 不再 append 叠加；写入前语义去重。customNotes 与其它字段不动。
 * 取舍：无法可靠区分「手写进这三数组的条目」与「上次做厚写入」时，采用粗粒度整组替换——
 * 手写全局规矩请放 customNotes（不受影响）。
 * 诚实三态返回 MergeResult：真写入→{merged:true}；写盘/解析异常→{merged:false, reason:"…失败…"}。
 */
export async function mergeWritingRulesEnrichmentIntoEngine(projectDir: string, data: WritingRulesEnrichment): Promise<MergeResult> {
  const path = join(projectDir, "story", "writing-rules.json");
  let wr: Record<string, unknown> = {};
  let rawWr: string | undefined;
  try {
    rawWr = await readFile(path, "utf-8");
  } catch (readErr) {
    // 不存在则建空；其它读错误不吞、不覆盖（修 P1·4）。
    if ((readErr as { code?: string })?.code !== "ENOENT") {
      return { merged: false, reason: `读 story/writing-rules.json 失败：${readErr instanceof Error ? readErr.message : String(readErr)}` };
    }
  }
  if (rawWr !== undefined) {
    try {
      wr = JSON.parse(rawWr) as Record<string, unknown>;
    } catch {
      return { merged: false, reason: "story/writing-rules.json 内容损坏（不是合法 JSON），未并入以免覆盖丢数据；请先修复或删除该文件。" };
    }
  }
  try {
    const replaceField = (field: string, lines: readonly string[]) => {
      wr[field] = semanticDedupRules(sanitizeBookStyleRuleLines(lines));
    };
    for (const t of ["forbidden", "risk", "encourage"] as const) {
      // 不再灌「反AI·名：长文」墙；清洗成 ≤40 字的本书风格短条（内置反 AI 层已覆盖通用条款）。
      const lines = data.antiRules
        .filter((r) => r.type === t)
        .map((r) => (r.desc?.trim() ? `${r.name}：${r.desc}` : r.name));
      replaceField(TYPE_TO_FIELD[t], lines);
    }
    wr.version = "v0";
    await mkdir(dirname(path), { recursive: true });
    await writeFileAtomic(path, JSON.stringify(wr, null, 2));
    return { merged: true };
  } catch (err) {
    return { merged: false, reason: `写 story/writing-rules.json 失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

export function summarizeWritingRulesEnrichment(data: WritingRulesEnrichment, merge: MergeResult): string {
  const fpCount = data.fingerprints.length;
  const antiCount = semanticDedupRules(
    data.antiRules.map((r) => (r.desc?.trim() ? `${r.name}：${r.desc}` : r.name)),
  ).length;
  const head = [
    "已补全本书的写作规则：",
    `整理出 ${fpCount} 条文风特点、`,
    `提炼了 ${antiCount} 条避免机器腔的写作提醒。`,
    "已替换旧的自动规则，不会重复叠加。",
  ].join("");
  const tail = merge.merged
    ? "已写入资料，并接进写正文的上下文（禁写内容/雷区/读者体验规则下一章 AI 就会遵守），可一键撤销；想改哪条直接跟我说。"
    : `已写入展示层资料，但未能接进正文（${merge.reason ?? "原因未知"}），下一章 AI 暂时用不上；可一键撤销，想改哪条直接跟我说。`;
  return head + tail;
}

export interface GenerateWritingRulesEnrichmentResult {
  readonly ok: boolean;
  readonly summary: string;
  readonly mergedIntoEngine: boolean;
  readonly enrichment?: WritingRulesEnrichment;
}

/** 编排：无任何写作规则上下文→ok:false 不调模型；否则 建消息 → 调模型 → 解析校验 → 落盘 → 摘要。callModel 注入，便于单测。 */
export async function generateWritingRulesEnrichment(input: {
  readonly projectDir: string;
  readonly context: WritingRulesContextInput;
  readonly callModel: CallModel;
}): Promise<GenerateWritingRulesEnrichmentResult> {
  if (!hasWritingRulesContext(input.context)) {
    return { ok: false, mergedIntoEngine: false, summary: "还没有可补全的写作规则——先去右边对 AI 说『帮我定下这本书的写法』，把视角、文风和节奏理出来，再来整理文风特点与避免机器腔的提醒。" };
  }
  const text = await input.callModel(buildWritingRulesEnrichmentMessages(input.context));
  const enrichment = parseWritingRulesEnrichment(text);
  await persistWritingRulesEnrichment(input.projectDir, enrichment);
  const merge = await mergeWritingRulesEnrichmentIntoEngine(input.projectDir, enrichment);
  return { ok: true, mergedIntoEngine: merge.merged, summary: summarizeWritingRulesEnrichment(enrichment, merge), enrichment };
}
