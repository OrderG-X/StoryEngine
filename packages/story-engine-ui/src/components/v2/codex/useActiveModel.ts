import { useEffect, useState } from "react";
import { fetchModelSettings } from "../../../api/modelSettingsClient.js";
import type { ModelSettingsSummary } from "../../../api/types.js";

export interface ActiveModelInfo {
  readonly label: string;
  readonly ok: boolean;
}

/** 默认 profile → 给人看的模型名（label 优先，其次 model id）；没配或读不到返回 null。 */
export function activeModelFromSummary(summary: ModelSettingsSummary | undefined): ActiveModelInfo | null {
  if (!summary) return null;
  const profile = summary.profiles.find((p) => p.id === summary.defaultProfile) ?? summary.profiles[0];
  if (!profile) return null;
  const label = (profile.label || profile.model || "").trim();
  if (!label) return null;
  return { label, ok: summary.available };
}

/** 新用户还差哪一步（P11）：connect = 一家服务商都没接好（没接或没密钥）；pick-model = 服务商接好了、还没选模型。 */
export type ModelSetupStep = "connect" | "pick-model";

/** 一个模型都没接（没有设置文件，或一个档案都没有）：新用户第一次打开就是这样。还没读到 → null（不闪）。 */
export function modelSetupStep(summary: ModelSettingsSummary | undefined): ModelSetupStep | null {
  if (!summary) return null;
  if (summary.status !== "missing" && summary.profiles.length > 0) return null;
  const connected = summary.providers.some((provider) => provider.apiKeyStatus !== "missing");
  return connected ? "pick-model" : "connect";
}

export interface ActiveModelState {
  /** 头部小标签；没配或读不到为 null。 */
  readonly info: ActiveModelInfo | null;
  /** 读到了、且一个模型都没接 → 给引导，说清还差哪步。还在读、读失败都是 null（不闪）。 */
  readonly setupStep: ModelSetupStep | null;
}

/** AI 栏头部的模型小标签：挂载时读一次，refreshKey 变了（比如关掉设置弹窗）再读。读失败就不显示，不打扰。 */
export function useActiveModel(refreshKey: unknown): ActiveModelState {
  const [state, setState] = useState<ActiveModelState>({ info: null, setupStep: null });
  useEffect(() => {
    // 用标记位而不是 abort：fetchJson 被中止时会抛出未被链上 catch 接住的 AbortError（StrictMode 双挂载必现）。
    let cancelled = false;
    fetchModelSettings()
      .then((res) => {
        if (cancelled) return;
        const summary = res.result.summary;
        setState({ info: activeModelFromSummary(summary), setupStep: modelSetupStep(summary) });
      })
      .catch(() => { /* 读不到模型设置时不显示标签 */ });
    return () => { cancelled = true; };
  }, [refreshKey]);
  return state;
}
