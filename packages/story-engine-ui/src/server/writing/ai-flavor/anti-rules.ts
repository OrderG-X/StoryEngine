/**
 * 作者在写作规则里写的反 AI 判据（重构 P7 第 6 步从 agent/tools/check-ai-flavor 挪来）：
 * 出稿后确定性回检、去 AI 味体检、一键去 AI 味都读这一份。读不到一律空数组，不报错。
 */
import { readFile } from "node:fs/promises";

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
