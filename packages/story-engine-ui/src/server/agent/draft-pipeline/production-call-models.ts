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

async function callSlot(
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

export const callConfiguredContinueModel: ContinueCallModel = (messages) => callSlot("fastDraft", messages, false);
export const callConfiguredContinuityCheckModel: CheckCallModel = (messages) => callSlot("qualityCheck", messages, true);
export const callConfiguredContinuityRepairModel: CheckCallModel = (messages) => callSlot("repair", messages, true);
