/**
 * 出稿后质量环节的生产用模型调用（阶段 3）。都走 streamChatModelToText：流式 + 空闲超时
 * （有字节就续命、无总时长上限），一律不传 max_tokens（铁律）。续写的思考开关随作者对写手的设置；
 * 核对与改写是出 JSON 的机械步骤，强制关思考（见 callSlotOnce）。
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
