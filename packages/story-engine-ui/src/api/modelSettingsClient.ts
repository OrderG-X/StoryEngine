import { fetchJson } from "./fetchJson.js";
import type {
  ModelSettingsApiResponse,
  ModelSettingsLoadResult,
  ModelTestConnectionApiResponse,
  ModelTestConnectionRequest,
  ModelTestConnectionResult,
  SaveModelSettingsRequest,
  TaskAssignmentView,
} from "./types.js";

export interface ModelSettingsClientResult {
  readonly result: ModelSettingsLoadResult;
  readonly rawText: string;
  readonly taskAssignments?: TaskAssignmentView;
  readonly warnings?: readonly string[];
}

export async function fetchModelSettings(signal?: AbortSignal): Promise<ModelSettingsClientResult> {
  const payload = await fetchJson<ModelSettingsApiResponse>(
    "/api/model-settings",
    {},
    signal,
  );
  if (!payload.ok) {
    throw new Error(payload.error);
  }
  // GET 响应从不带 warnings（那是 PUT 还原打码头失败的专属回执），不透传死字段。
  return {
    result: payload.result,
    rawText: payload.rawText,
    taskAssignments: payload.taskAssignments,
  };
}

export async function saveModelSettings(
  rawText: string,
  providerApiKeys?: Readonly<Record<string, string>>,
  taskAssignments?: TaskAssignmentView,
  signal?: AbortSignal,
): Promise<ModelSettingsClientResult> {
  const body: SaveModelSettingsRequest = {
    rawText,
    ...(providerApiKeys && Object.keys(providerApiKeys).length > 0 ? { providerApiKeys } : {}),
    ...(taskAssignments && Object.keys(taskAssignments).length > 0 ? { taskAssignments } : {}),
  };
  const payload = await fetchJson<ModelSettingsApiResponse>(
    "/api/model-settings",
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    signal,
  );
  if (!payload.ok) {
    throw new Error(payload.error);
  }
  return {
    result: payload.result,
    rawText: payload.rawText,
    taskAssignments: payload.taskAssignments,
    warnings: payload.warnings,
  };
}

export async function testModelConnection(input: ModelTestConnectionRequest, signal?: AbortSignal): Promise<ModelTestConnectionResult> {
  const payload = await fetchJson<ModelTestConnectionApiResponse>(
    "/api/model-settings/test",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
    signal,
  );
  if (!payload.ok) {
    throw new Error(payload.error);
  }
  return payload.result;
}
