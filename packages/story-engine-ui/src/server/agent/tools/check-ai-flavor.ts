/**
 * check_ai_flavor — 只读工具：对某章草稿做『去 AI 味』体检，挑出有 AI 腔的句子 + 原因 + 改写方向，不改稿。
 *
 * 编排：读草稿（defaultDraftPath + stripLeadingMarkdownChapterHeading）+ 从 story/writing-rules.json
 * 抽反 AI 判据（readAntiRules，合并去重；读不到→空数组，纯逻辑用通用判据兜底）
 *   → runAiFlavorCheck（注入 callModel = resolveConfiguredChatModel("draftReview") + callOpenAICompatibleChatModel）。
 *
 * 只读：不写盘、不建快照、不带 snapshotId / refreshScope。
 * 绝不静默失败：模型/网络挂了如实回报 ok:false，不编造违规。
 */
import { readFile } from "node:fs/promises";
import { buildWritingContextPack } from "@actalk/story-engine";
import { createTool, type ToolExecutionContext } from "@mastra/core/tools";
import { z } from "zod";
import { coerceNumber } from "./lenient-args.js";

import { resolveConfiguredChatModel, streamChatModelToText } from "../../lib/llm-client.js";
import { defaultDraftPath, stripLeadingMarkdownChapterHeading } from "../../lib/project-io.js";
import { readProjectDirFromContext, resolveChapterFromInputOrContext } from "../request-context.js";
import { runAiFlavorCheck, type AiFlavorReport } from "../ai-flavor/ai-flavor-check.js";

const inputSchema = z.object({
  chapter: coerceNumber(z.number().int().positive().optional().describe("要体检 AI 味的章号。")),
});
const outputSchema = z.object({
  ok: z.boolean(),
  summary: z.string(),
  violations: z.array(z.object({
    id: z.string(), text: z.string(), reason: z.string(),
    severity: z.enum(["high", "medium", "low"]),
    suggestedFix: z.string().optional(),
  })),
  usedFallback: z.boolean(),
});

/** 读 story/writing-rules.json 原文；读不到（缺文件/坏 JSON）→ undefined（调用方各自兜底，绝不报错）。 */
async function readWritingRulesRaw(projectDir: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(`${projectDir}/story/writing-rules.json`, "utf-8")) as Record<string, unknown>;
  } catch { return undefined; }
}

function pickStringArray(raw: Record<string, unknown>, key: string): string[] {
  return (Array.isArray(raw[key]) ? (raw[key] as unknown[]) : []).filter((x): x is string => typeof x === "string");
}

/** 从 story/writing-rules.json 抽出反 AI 判据（合并去重）。读不到→空数组（纯逻辑用通用判据兜底）。 */
export async function readAntiRules(projectDir: string): Promise<string[]> {
  const raw = await readWritingRulesRaw(projectDir);
  if (!raw) return [];
  return Array.from(new Set([...pickStringArray(raw, "forbiddenContent"), ...pickStringArray(raw, "doNotDo"), ...pickStringArray(raw, "readerExperienceRules"), ...pickStringArray(raw, "antiAiPatterns")].map((s) => s.trim()).filter(Boolean)));
}

/**
 * 只抽 antiAiPatterns 一个字段（用户自定义反 AI 词表），供 generate_draft 出稿后确定性回检
 * 转成字面量 pattern 规则（见 ai-flavor-rules.ts buildUserAntiAiPatternRules）。读不到→空数组，不崩。
 */
export async function readAntiAiPatterns(projectDir: string): Promise<string[]> {
  const raw = await readWritingRulesRaw(projectDir);
  if (!raw) return [];
  return Array.from(new Set(pickStringArray(raw, "antiAiPatterns").map((s) => s.trim()).filter(Boolean)));
}

/**
 * 跨章「前文已建立要素」：往章登记的关键道具/资产 + 已确立硬事实（来自 writing-context-pack 的
 * assetContext + continuityFocus.establishedFacts，已按当前章相关性筛选、对长篇可扩展）。喂给体检 LLM，
 * 避免它把前文铺垫过的道具误判成「道具天降/凭空出现」（Codex 组合复测 P2：第3章把第1、2章已建立的黑色胶带判天降）。
 * 读不到（缺状态/异常）→ 空数组，体检退回只看当前章的旧行为，绝不因此报错。
 */
export async function gatherEstablishedElements(projectDir: string, chapter: number): Promise<string[]> {
  const pack = await buildWritingContextPack({ projectDir, chapter, userDirection: "", maxTimelineEvents: 3 }).catch(() => undefined);
  if (!pack) return [];
  const assetNames = [
    ...pack.assetContext.initialAssets,
    ...pack.assetContext.keyItems,
    ...pack.assetContext.carriedAssets,
    ...pack.assetContext.ownedAssets,
    ...pack.assetContext.plotCriticalAssets,
  ];
  // 资产名在前（短、信号强），已确立硬事实在后（句子含具体道具/编号）。去重 + 截断防 prompt 过长。
  return Array.from(new Set([...assetNames, ...pack.continuityFocus.establishedFacts].map((s) => s.trim()).filter(Boolean))).slice(0, 24);
}

export async function runCheckAiFlavorToolLogic(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly callModel: (prompt: string) => Promise<string>;
}): Promise<AiFlavorReport> {
  const raw = await readFile(defaultDraftPath(input.projectDir, input.chapter), "utf-8").catch(() => "");
  const draftText = stripLeadingMarkdownChapterHeading(raw).trim();
  const antiRules = await readAntiRules(input.projectDir);
  const establishedElements = await gatherEstablishedElements(input.projectDir, input.chapter);
  return runAiFlavorCheck({ draftText, antiRules, establishedElements, callModel: input.callModel });
}

export const checkAiFlavorTool = createTool({
  id: "check_ai_flavor",
  description:
    "对某章草稿做『去 AI 味』体检（只读，不改稿）：挑出有 AI 腔的句子+原因+改写方向。" +
    "当用户问『有没有 AI 味 / 体检一下 AI 腔 / 这章像不像 AI 写的 / 去 AI 味』时调用。模型不可用时如实回报，不编造。",
  inputSchema,
  outputSchema,
  execute: async (input: z.infer<typeof inputSchema>, context: ToolExecutionContext) => {
    const projectDir = readProjectDirFromContext(context);
    if (!projectDir) {
      throw new Error("check_ai_flavor 缺少 projectDir：请确认 RequestContext 注入了 projectDir。");
    }
    const resolvedChapter = resolveChapterFromInputOrContext(input.chapter, context);
    if (resolvedChapter === undefined) {
      throw new Error("check_ai_flavor 缺少章号：LLM 未给出章号，且前端未注入 currentChapter。请明确指定章号。");
    }
    const configured = await resolveConfiguredChatModel("draftReview");
    const callModel = async (prompt: string): Promise<string> => {
      // 超时铁律（与 ai_review 同口径）：流式 + 空闲超时，绝不设固定总上限——有任何字节（正文/思考 token）就续命，
      // 只有连接彻底静默才判死。旧实现用非流式 callOpenAICompatibleChatModel + 固定 250s：代理把整段 reasoning+JSON
      // 缓冲到最后一次性吐出，期间 SSE 全程静默 → UI 工具一直 running、120s+ 冻死（Codex 封测实测）。
      const { content } = await streamChatModelToText({
        configured,
        messages: [{ role: "user", content: prompt }],
        temperature: configured.profile.temperature ?? 0.3,
        responseFormat: { type: "json_object" },
      });
      if (!content) throw new Error("体检模型返回了空内容。");
      return content;
    };
    try {
      return await runCheckAiFlavorToolLogic({ projectDir, chapter: resolvedChapter, callModel });
    } catch (error) {
      // 绝不静默：模型/网络挂了如实回报，不编造违规。
      return { ok: false, summary: `体检没成：${error instanceof Error ? error.message : String(error)}，可重试。`, violations: [], usedFallback: true };
    }
  },
});
