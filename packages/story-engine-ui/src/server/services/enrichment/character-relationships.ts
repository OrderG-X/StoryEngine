/**
 * 人物关系生成器 lib（模块 A-1）
 *
 * 纯函数 lib，无副作用（不写盘不调网）。
 * 功能：zod schema + 提示词构造 + 解析，把 GLM 输出的人物关系 JSON 校验出来。
 *
 * 设计原则：
 * - 题材中立，不预设任何关系/世界观
 * - 只整理给定事实里真实出现的具名人物，排除路人/无名人物
 * - 关系必须有事实支撑，禁止编造
 *
 * 提示词与数据结构均为本项目原创（借鉴通用提示工程技法，不复制任何第三方文案/代码）。
 */
import { z } from "zod";

export type ChatMessage = { readonly role: "system" | "user"; readonly content: string };
/** 注入式模型调用：传入消息，返回模型文本（应是一个 JSON 对象）。便于单测 mock。 */
export type CallModel = (messages: readonly ChatMessage[]) => Promise<string>;

export const characterRelationshipsSchema = z.object({
  characters: z.array(z.object({ name: z.string().min(1), role: z.string().min(1) })).default([]),
  relationships: z.array(z.object({
    from: z.string().min(1), to: z.string().min(1), relationType: z.string().min(1),
    trust: z.enum(["low", "medium", "high"]),
  })).default([]),
}).strict();

export type CharacterRelationships = z.infer<typeof characterRelationshipsSchema>;

export function buildCharacterRelationshipsMessages(facts: readonly string[], existingNames: readonly string[]) {
  const system = "你是小说资料整理助手。只输出一个合法 JSON 对象，不要 Markdown、不要代码块、不要解释。" +
    "简体中文。字段固定为 characters[].{name,role} 与 relationships[].{from,to,relationType,trust}。" +
    "trust 只能是 low/medium/high。只整理给定事实里真实出现的【具名人物】（有名字的），" +
    "明确排除『前工友/路人/某陌生人/某人』这类无名次要提及。人物不超过 20 个。关系必须有事实支撑，禁止编造，宁缺勿凑。";
  const factLines = facts.map((f, i) => `${i + 1}. ${f}`).join("\n");
  const user = `已知人物（可补充）：${existingNames.join("、") || "（无）"}\n\n事实清单：\n${factLines}\n\n` +
    "请据此输出人物与关系。trust 由事实判断（如出现『别信/欺骗/敌对』→ low，『信任/亲密/血亲』→ high）。";
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

export function parseCharacterRelationships(text: string): CharacterRelationships {
  const match = text.match(/\{[\s\S]*\}/u);
  if (!match) throw new Error("character-relationships: 模型输出未含 JSON 对象");
  return characterRelationshipsSchema.parse(JSON.parse(match[0]));
}
