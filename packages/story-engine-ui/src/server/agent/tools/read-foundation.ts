/**
 * read_foundation — 只读工具：按需读取某一类资料片段（角色 / 资产 / 地点 / 资料完整度报告）。
 *
 * 读类行为：当用户问「某角色的设定是什么 / 现有哪些资产 /
 * 哪些地点 / 资料还缺什么」时，agent 调本工具拿真实片段，绝不凭空编造。
 *
 * 读类工具不建快照、不带 snapshotId；不动磁盘故 refreshScope 省略（前端无需刷新面板）。
 */
import { buildFoundationGapReport } from "../../book/foundation-gap-assistant.js";
import {
  readAssetLedger,
  readCharacterBible,
  readCharacterState,
  readLocationBible,
} from "../../book/project-store.js";
import { createTool } from "@mastra/core/tools";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { z } from "zod";

import { coerceEnum } from "../../lib/lenient-args.js";
import { readProjectDirFromContext } from "../request-context.js";
import { localizeFoundationForReading, readinessLevelLabel } from "../foundation-readable.js";

export const READ_FOUNDATION_KINDS = ["character", "asset", "location", "gap_report"] as const;

// 泛化称呼：agent 常用「主角」等指代主人公、而非传真实 id/name。解析到主角卡，避免 found:false 卡住弱模型。题材中立。
const PROTAGONIST_APPELLATIONS = new Set([
  "主角", "主人公", "主人翁", "男主", "女主", "男主角", "女主角", "主角色", "protagonist", "the protagonist", "main character",
]);
const PROTAGONIST_ID_PREFIXES = ["protagonist", "the protagonist", "main character", "主角", "主人公", "男主", "女主"];
function isProtagonistAppellation(ref: string): boolean {
  const normalized = ref.trim().toLowerCase();
  if (PROTAGONIST_APPELLATIONS.has(normalized)) return true;
  // 模型常瞎造「protagonist-<拼音>」/「主角-X」这类前缀 id 指代主角（真实 id 是 char-<hash>，绝不以此开头）。
  return PROTAGONIST_ID_PREFIXES.some((prefix) => normalized.length > prefix.length
    && normalized.startsWith(prefix)
    && "-_: ".includes(normalized.charAt(prefix.length)));
}
export type ReadFoundationKind = (typeof READ_FOUNDATION_KINDS)[number];

const inputSchema = z.object({
  // 模型无关：枚举大小写宽容（模型常传 "Character"）。
  kind: coerceEnum(z.enum(READ_FOUNDATION_KINDS).describe(
    "character=角色（给 id 还附运行时状态）；asset=资产；location=地点；gap_report=资料缺口与风险。",
  )),
  id: z.string().optional().describe(
    "可选：当 kind=character 时填角色 id，可额外读出该角色的运行时 state（情绪/目标/认知边界等）。其它 kind 忽略。",
  ),
});

const outputSchema = z.object({
  kind: z.enum(READ_FOUNDATION_KINDS),
  found: z.boolean().describe("是否读到了对应资料（gap_report 总是 true；character/asset/location 文件缺失时为 false）。"),
  data: z.unknown().describe("读到的资料片段（角色册 / 资产清单 / 地点册 / 完整度报告）。"),
  characterState: z.unknown().optional().describe("当 kind=character 且给了存在的 id 时，附该角色的运行时 state；否则省略。"),
  summary: z.string().describe("自然语言摘要，供回答用户。"),
});

/**
 * 纯逻辑：按 kind 读出资料片段。抽出为可直接单测的函数（不经 Mastra execute 包装）。
 * 题材中立：summary 措辞不注入任何题材假设。
 */
export async function readFoundationFragment(input: {
  readonly projectDir: string;
  readonly kind: ReadFoundationKind;
  readonly id?: string;
}): Promise<z.infer<typeof outputSchema>> {
  const { projectDir, kind, id } = input;
  if (kind === "gap_report") {
    // gap_report 是诊断结构（深嵌套 + action 枚举），极少被逐条复述；data 保持原样，
    // 只把 summary 里漏的英文枚举（就绪等级 ready/warning/high_risk）换成中文。
    const report = await buildFoundationGapReport(projectDir);
    return {
      kind,
      found: true,
      data: report,
      summary:
        `资料完整度：${report.passed ? "已达标" : "未达标"}（就绪等级 ${readinessLevelLabel(report.readinessLevel)}）；` +
        `缺失 ${report.missingItems.length} 项、风险 ${report.riskyItems.length} 项、冲突 ${report.conflictItems.length} 项。`,
    };
  }
  if (kind === "asset") {
    const ledger = await readAssetLedger(projectDir);
    return {
      kind,
      found: true,
      data: localizeFoundationForReading(ledger), // 喂模型前把英文键/枚举换中文，免复述出英文
      summary: `共 ${ledger.assets.length} 件资产${ledger.containers.length > 0 ? `、${ledger.containers.length} 个容器` : ""}。`,
    };
  }
  if (kind === "location") {
    const bible = await readLocationBible(projectDir);
    if (!bible) {
      return { kind, found: false, data: null, summary: "尚未建立地点资料。" };
    }
    return {
      kind,
      found: true,
      data: localizeFoundationForReading(bible), // 喂模型前把英文键/枚举换中文
      summary: `共 ${bible.locations.length} 个地点${
        bible.locations.length > 0 ? `：${bible.locations.slice(0, 8).map((loc) => loc.name).join("、")}` : ""
      }。`,
    };
  }
  // kind === "character"
  const bible = await readCharacterBible(projectDir);
  if (!bible) {
    return { kind, found: false, data: null, summary: "尚未建立角色资料。" };
  }
  const trimmedId = id?.trim();
  if (trimmedId) {
    // 修 P3·1：agent 常把中文名当 id 传（如 id:"〈角色名〉"）。先按 id 精确匹配，再按名兜底——命中即 found:true，
    // 接口语义干净（不再「found:false 却塞整份 bible 让模型自己找」）。
    const entry = bible.characters.find((character) => character.id === trimmedId)
      ?? bible.characters.find((character) => character.name === trimmedId)
      // 泛化称呼（「主角」等）→ 主角卡：isMainCharacter 优先，再按 role 含「主角」兜底。
      ?? (isProtagonistAppellation(trimmedId)
        ? bible.characters.find((character) => (character as { readonly isMainCharacter?: unknown }).isMainCharacter === true)
          ?? bible.characters.find((character) => typeof character.role === "string" && character.role.includes("主角"))
        : undefined);
    if (!entry) {
      return {
        kind,
        found: false,
        data: localizeFoundationForReading(bible),
        summary: `没有找到 id/名为「${trimmedId}」的角色；当前共有 ${bible.characters.length} 个角色卡。`,
      };
    }
    // 用解析到的 entry.id 读 state（不是 trimmedId——泛化称呼/按名命中时 trimmedId 不是真 id，否则读错路径/读空）。
    const characterState = await readCharacterState(projectDir, entry.id).catch(() => undefined);
    return {
      kind,
      found: true,
      data: localizeFoundationForReading(entry), // 喂模型前把英文键/枚举换中文，免复述出英文
      ...(characterState ? { characterState: localizeFoundationForReading(characterState) } : {}),
      summary: `角色「${entry.name}」资料已读取${characterState ? "（含当前状态）" : ""}。`,
    };
  }
  return {
    kind,
    found: true,
    data: localizeFoundationForReading(bible), // 喂模型前把英文键/枚举换中文
    summary: `共 ${bible.characters.length} 个角色卡${
      bible.characters.length > 0 ? `：${bible.characters.slice(0, 8).map((c) => c.name).join("、")}` : ""
    }。`,
  };
}

export const readFoundationTool = createTool({
  id: "read_foundation",
  description:
    "按需读取某一类资料的真实片段：角色（character，可带 id 读单个角色及其 state）、" +
    "资产（asset）、地点（location）、资料完整度报告（gap_report）。" +
    "当用户问某类资料的现状、或你判断还要补哪些资料时调用，绝不凭空编造。",
  inputSchema,
  outputSchema,
  execute: async (input: z.infer<typeof inputSchema>, context: ToolExecutionContext) => {
    const projectDir = readProjectDirFromContext(context);
    if (!projectDir) {
      throw new Error(
        "read_foundation 缺少 projectDir：请确认调用 agent 时通过 RequestContext 注入了 projectDir。",
      );
    }
    return readFoundationFragment({
      projectDir,
      kind: input.kind,
      ...(input.id !== undefined ? { id: input.id } : {}),
    });
  },
});
