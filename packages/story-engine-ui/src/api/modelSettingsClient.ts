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
  /** 备用模型档案（P10）；没设是 null / 不带。 */
  readonly fallbackProfileId?: string | null;
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
    fallbackProfileId: payload.fallbackProfileId ?? null,
  };
}

export async function saveModelSettings(
  rawText: string,
  providerApiKeys?: Readonly<Record<string, string>>,
  taskAssignments?: TaskAssignmentView,
  signal?: AbortSignal,
  /** 备用模型（P10）：字符串 = 设成它，null = 不用备用，不传 = 不动。 */
  fallbackProfileId?: string | null,
): Promise<ModelSettingsClientResult> {
  const body: SaveModelSettingsRequest = {
    rawText,
    ...(providerApiKeys && Object.keys(providerApiKeys).length > 0 ? { providerApiKeys } : {}),
    ...(taskAssignments && Object.keys(taskAssignments).length > 0 ? { taskAssignments } : {}),
    ...(fallbackProfileId !== undefined ? { fallbackProfileId } : {}),
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
    fallbackProfileId: payload.fallbackProfileId ?? null,
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

export interface CheckupModelView {
  readonly key: string;
  readonly providerLabel: string;
  readonly model: string;
  readonly tasks: readonly string[];
  readonly ok: boolean;
  readonly ms?: number;
  readonly error?: string;
}

export interface CheckupView {
  readonly models: readonly CheckupModelView[];
  readonly unresolved: readonly { readonly task: string; readonly error: string }[];
}

/** 体检（P10）：在用的模型各真发一句极短对话。 */
export async function runModelCheckup(signal?: AbortSignal): Promise<CheckupView> {
  const payload = await fetchJson<({ ok: true } & CheckupView) | { ok: false; error: string }>(
    "/api/model-settings/checkup",
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    signal,
  );
  if (!payload.ok) throw new Error(payload.error);
  return { models: payload.models, unresolved: payload.unresolved };
}
