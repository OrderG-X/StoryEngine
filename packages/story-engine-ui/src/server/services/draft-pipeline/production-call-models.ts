/**
 * 出稿后质量环节的生产用模型调用（阶段 3）。走 streamChatModelToText：流式 + 空闲超时
 * （有字节就续命、无总时长上限），一律不传 max_tokens（铁律）。续写的思考开关随作者对写手的设置。
 * - 续写：fastDraft 槽（写手本身，文风一致）。
 * - 按核账改：repair 槽，和核账卡「改这处」、改稿工具同一个模型通道（createRevisionModelChannel）。
 * - 自动去味：repair 槽；判漏复核：triage 槽。
 * 前后核对 2026-10-10 起和「核账」同一套（编辑部核账员，brain 的 callConfiguredBrainModel），不在这里。
 */
import { canCallAgain, MODEL_CALL_MAX_SENDS, resolveConfiguredChatModel, streamChatModelToText } from "../../lib/llm-client.js";
import { createRevisionModelChannel, type RevisionModelCaller } from "../draft-change/revise-text.js";
import type { DeAiCallModel } from "../de-ai-flavor-batch.js";
import type { ContinueCallModel } from "./continue-draft.js";

type Messages = Parameters<ContinueCallModel>[0];

async function callSlotOnce(
  task: "fastDraft",
  messages: Messages,
  json: boolean,
): Promise<string> {
  const resolved = await resolveConfiguredChatModel(task);
  // 核对与改冲突段是按格式出 JSON 的机械步骤：强制关思考（同章节语义声明、抽事实）。
  // 实测同一章：开思考 327 秒（光思考 12 万字），关思考 10 秒，查出的问题相当——开着它，一章要多等 5 分钟。
  // 续写走写手自己的设置（fastDraft 默认就关）。
  const configured = json ? { ...resolved, thinking: false } : resolved;
  const { content } = await streamChatModelToText({
    configured,
    messages: messages.map((message) => ({ role: message.role, content: message.content })),
    ...(json ? { responseFormat: { type: "json_object" as const } } : {}),
  });
  return content;
}

/**
 * 失败了再试一次，只在 canCallAgain 放行时（写作版本 P2a 4.2）：产物不能用（空回、截断、坏帧）、请求没发出去。
 * 结果不明（静默超时、断连、5xx）、被拒、被停的不再发——可能已经在算、已经计费。不再发就原样抛，
 * 由各环节如实报「这次没跑成、原稿不动」。
 */
async function callSlot(
  task: "fastDraft",
  messages: Messages,
  json: boolean,
): Promise<string> {
  try {
    return await callSlotOnce(task, messages, json);
  } catch (error) {
    if (!canCallAgain(error)) throw error;
    console.warn(`[draft-pipeline] ${task} 调用失败，自动重试一次：${String((error as Error)?.message ?? error).slice(0, 160)}`);
    return callSlotOnce(task, messages, json);
  }
}

/** 补字数一次最多发几次：自己重试一次（只在 canCallAgain 时）× 每次（主 + 备用）。 */
export const CONTINUE_CALL_MAX_SENDS = 2 * MODEL_CALL_MAX_SENDS;

export const callConfiguredContinueModel: ContinueCallModel = (messages) => callSlot("fastDraft", messages, false);

/** 按核账改：用到时才解析 repair 槽（没核出要改的就不碰它，槽配置有问题也只让「这处没改成」，不拖垮出稿）。 */
export const callConfiguredFixModel: RevisionModelCaller = async (prompt) => (await createRevisionModelChannel()).call(prompt);

/**
 * 自动去味的改写（repair 槽：流式 + 空闲超时、不传 max_tokens、要 JSON）。用到时才解析槽：槽配置有问题只让「去味没跑成、原稿不动」。
 */
export const callConfiguredDeAiModel: DeAiCallModel = async (prompt, { maxContentChars }) => {
  const configured = await resolveConfiguredChatModel("repair");
  const { content } = await streamChatModelToText({
    configured,
    messages: [{ role: "user", content: prompt }],
    temperature: configured.profile.temperature ?? 0.4,
    responseFormat: { type: "json_object" },
    maxContentChars,
  });
  return content;
};

/**
 * 判漏要点的复核（triage 槽：低温判定、要 JSON）。只在真有判漏时调；解析、调用失败在 adjudicateMissingBeats 里接住
 * （维持确定性结论 + unavailable 如实标注）。
 */
export async function callConfiguredBeatAdjudicationModel(prompt: string): Promise<string> {
  const configured = await resolveConfiguredChatModel("triage");
  const { content } = await streamChatModelToText({
    configured,
    messages: [{ role: "user", content: prompt }],
    temperature: configured.profile.temperature ?? 0.2,
    responseFormat: { type: "json_object" },
  });
  return content;
}
