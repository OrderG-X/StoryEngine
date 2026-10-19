/**
 * 作者在写作规则里写的反 AI 判据（重构 P9 改读设定卡的写作规则）：出稿后确定性回检、去 AI 味体检、
 * 一键去 AI 味都读这一份。读不到不拦（只剩内置规则），但给作者看的体检、去味要如实带上 failure。
 */
import { readCardsOrLegacy, type WritingRules } from "@actalk/story-core";

/** 设定卡读不出来时给作者看的一句（体检、去味的结论后面带上）。 */
export const ANTI_RULES_UNREADABLE = "设定卡读不出来，这次没按你写的写作规则查";

async function readRules(projectDir: string): Promise<WritingRules | undefined> {
  return (await readCardsOrLegacy(projectDir).catch(() => undefined))?.rules;
}

const texts = (items: readonly { readonly text: string }[]): string[] => items.map((item) => item.text.trim()).filter(Boolean);

/** 「一定不要写」「一定要做到」「别用的说法」合并去重，交给体检 / 去味的模型当判据。读不出来：空判据 + failure。 */
export async function readAntiRules(projectDir: string): Promise<{ readonly items: string[]; readonly failure?: string }> {
  const rules = await readRules(projectDir);
  if (!rules) return { items: [], failure: ANTI_RULES_UNREADABLE };
  return { items: Array.from(new Set([...texts(rules.bans), ...texts(rules.musts), ...texts(rules.avoid)])) };
}

/** 结论后面带上「没按你写的规则查」（读得出来就原样）。 */
export function withAntiRulesNote(summary: string, failure: string | undefined): string {
  return failure ? `${summary.replace(/[\u3002.]+$/u, "")}。（${failure}。）` : summary;
}

/** 只要「别用的说法」（作者自己的 AI 腔词表），出稿后确定性回检转成字面量规则（buildUserAntiAiPatternRules）。 */
export async function readAntiAiPatterns(projectDir: string): Promise<string[]> {
  const rules = await readRules(projectDir);
  return rules ? Array.from(new Set(texts(rules.avoid))) : [];
}
