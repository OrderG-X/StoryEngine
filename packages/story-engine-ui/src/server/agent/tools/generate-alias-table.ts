/**
 * generate_alias_table — 生成/合并角色别名表。
 *
 * 以保守规则为主（姓名去姓、唯一姓、通用职务称谓），**默认再调 GLM 提议代称**
 * （createConfiguredAliasProposer，PromptedOutput；经 validateLlmAlias 校验才入表；
 * LLM 不可用时自动降级为仅规则 + warning，绝不静默）。不扫正文、不改引擎。
 * 写入 .story-engine-ui/alias-tables.json，供后续相关角色检测读取。
 * 注：LLM 提议跑模型自身上限——streamChatModelToText 一律不传 max_tokens
 * （全局不限制——推理模型的思考也占 max_tokens 额度，设小会截空正文），故思考+正文都装得下、不会被截空。
 */
import { z } from "zod";

import {
  generateAndWriteAliasTable,
  type AliasProposalFn,
  type CharacterAliasInput,
} from "../alias-generator/alias-generator.js";
import { resolveConfiguredChatModel, streamChatModelToText } from "../../lib/llm-client.js";
import { writeTool } from "../withSnapshot.js";

const inputSchema = z.object({
  note: z.string().optional().describe("可选备注；工具自动从 character-bible 生成别名表，一般留空。"),
});

const outputSchema = z.object({
  snapshotId: z.string().describe("写前快照 id，可一键撤销本次生成。"),
  ok: z.boolean(),
  summary: z.string(),
  aliasTable: z.unknown(),
  conflicts: z.array(z.unknown()),
  mergeReport: z.unknown(),
  llmReport: z.unknown(),
  warnings: z.array(z.string()),
  refreshScope: z.literal("foundation"),
});

function buildAliasProposalMessages(character: CharacterAliasInput): readonly { readonly role: "system" | "user"; readonly content: string }[] {
  return [
    {
      role: "system",
      content:
        "你是中文小说角色代称提议器。只输出 JSON 字符串数组，如 [\"林总\",\"远哥\"]。" +
        "这是 PromptedOutput：不要 Markdown，不要解释，不要对象，不要默认结构化输出。宁缺勿滥。",
    },
    {
      role: "user",
      content: [
        `角色：${character.name}；身份：${character.identity ?? ""}；定位：${character.role ?? ""}。`,
        "列出中文小说里别人会怎么称呼/简称这一个角色的代称（如 姓+总/少/哥/姐/董、名+哥/姐、单字昵称）。",
        "铁律：只针对这一个角色；不编造新人物；不输出与该角色姓名无关的词；不预设题材专有称谓；宁缺勿滥、不确定就少给；最多 5 个。",
        "只输出 JSON 字符串数组。",
      ].join("\n"),
    },
  ];
}

function parsePromptedAliasOutput(text: string): readonly string[] {
  const match = text.match(/\[[\s\S]*\]/u);
  if (!match) throw new Error("别名提议不是 JSON 数组。");
  const parsed = JSON.parse(match[0]) as unknown;
  if (!Array.isArray(parsed)) throw new Error("别名提议不是数组。");
  return parsed.filter((item): item is string => typeof item === "string").slice(0, 5);
}

/**
 * 走 streamChatModelToText（2026-10-02 P2）：原非流式 60s 固定死表会把开了思考的推理模型（光思考就几十秒）误杀；
 * 流式 + 空闲超时只在上游彻底静默才判死、不设总时长上限。一律不传 max_tokens；思考开关仍随 enrichment 任务旁路。
 */
export async function createConfiguredAliasProposer(): Promise<AliasProposalFn> {
  const configured = await resolveConfiguredChatModel("enrichment");
  return async (character) => {
    const { content } = await streamChatModelToText({
      configured,
      messages: buildAliasProposalMessages(character),
      temperature: 0.2,
    });
    if (!content.trim()) throw new Error("别名提议模型返回了空内容。");
    return parsePromptedAliasOutput(content);
  };
}

export async function generateAliasTableLogic(input: {
  readonly projectDir: string;
  readonly proposeAliases?: AliasProposalFn;
  readonly createProposer?: () => Promise<AliasProposalFn>;
}): Promise<Omit<z.infer<typeof outputSchema>, "snapshotId">> {
  let proposeAliases = input.proposeAliases;
  if (!proposeAliases) {
    try {
      proposeAliases = await (input.createProposer ?? createConfiguredAliasProposer)();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      proposeAliases = async () => {
        throw new Error(message);
      };
    }
  }
  const result = await generateAndWriteAliasTable(input.projectDir, {
    proposeAliases,
  });
  return {
    ok: result.ok,
    summary: result.summary,
    aliasTable: result.table,
    conflicts: [...result.table.conflicts],
    mergeReport: result.mergeReport,
    llmReport: result.llmReport,
    warnings: [...result.warnings],
    refreshScope: "foundation" as const,
  };
}

export const generateAliasTableTool = writeTool({
  id: "generate_alias_table",
  description:
    "从现有 character-bible 自动生成/合并中文角色别名表，用于后续按本章相关性挑角色。" +
    "以保守规则为主（姓名去姓、唯一姓、通用称谓），默认再调 GLM 提议代称（经校验才入表，LLM 不可用自动降级为仅规则+warning）；不扫正文、不臆造。再生成会保留用户手改并如实回报冲突与 merge 结果。",
  inputSchema,
  outputSchema,
  run: async ({ projectDir }) => generateAliasTableLogic({ projectDir }),
});
