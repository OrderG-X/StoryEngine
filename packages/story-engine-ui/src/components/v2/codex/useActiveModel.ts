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

/** AI 栏头部的模型小标签：挂载时读一次，refreshKey 变了（比如关掉设置弹窗）再读。读失败就不显示，不打扰。 */
export function useActiveModel(refreshKey: unknown): ActiveModelInfo | null {
  const [info, setInfo] = useState<ActiveModelInfo | null>(null);
  useEffect(() => {
    // 用标记位而不是 abort：fetchJson 被中止时会抛出未被链上 catch 接住的 AbortError（StrictMode 双挂载必现）。
    let cancelled = false;
    fetchModelSettings()
      .then((res) => { if (!cancelled) setInfo(activeModelFromSummary(res.result.summary)); })
      .catch(() => { /* 读不到模型设置时不显示标签 */ });
    return () => { cancelled = true; };
  }, [refreshKey]);
  return info;
}
