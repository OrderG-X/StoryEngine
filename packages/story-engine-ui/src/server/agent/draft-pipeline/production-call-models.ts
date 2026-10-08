/**
 * 出稿后质量环节的生产用模型调用（阶段 3）。都走 streamChatModelToText：流式 + 空闲超时
 * （有字节就续命、无总时长上限），一律不传 max_tokens（铁律）；思考开关随作者对各任务的设置。
 * - 续写：fastDraft 槽（写手本身，文风一致）。
 * - 前后核对：qualityCheck 槽，要 JSON。
 * - 冲突段改写：repair 槽，要 JSON。
 */
import { resolveConfiguredChatModel, streamChatModelToText } from "../../lib/llm-client.js";
import type { ContinueCallModel } from "./continue-draft.js";
import type { CheckCallModel } from "./continuity-check.js";

type Messages = Parameters<ContinueCallModel>[0];

async function callSlotOnce(
  task: "fastDraft" | "qualityCheck" | "repair",
  messages: Messages,
  json: boolean,
): Promise<string> {
  const configured = await resolveConfiguredChatModel(task);
  const { content } = await streamChatModelToText({
    configured,
    messages: messages.map((message) => ({ role: message.role, content: message.content })),
    ...(json ? { responseFormat: { type: "json_object" as const } } : {}),
  });
  if (!content.trim()) throw new Error("模型返回了空内容");
  return content;
}

/**
 * 服务商临时故障（静默超时 / 断连 / 空回）自动再试一次（十章验收第三轮：服务商故障两小时，
 * 核对环节每次都直接「没核成」）。仍失败就抛，由各环节如实报「这次没跑成、原稿不动」。
 */
async function callSlot(
  task: "fastDraft" | "qualityCheck" | "repair",
  messages: Messages,
  json: boolean,
): Promise<string> {
  try {
    return await callSlotOnce(task, messages, json);
  } catch (error) {
    console.warn(`[draft-pipeline] ${task} 调用失败，自动重试一次：${String((error as Error)?.message ?? error).slice(0, 160)}`);
    return callSlotOnce(task, messages, json);
  }
}

export const callConfiguredContinueModel: ContinueCallModel = (messages) => callSlot("fastDraft", messages, false);
export const callConfiguredContinuityCheckModel: CheckCallModel = (messages) => callSlot("qualityCheck", messages, true);
export const callConfiguredContinuityRepairModel: CheckCallModel = (messages) => callSlot("repair", messages, true);
