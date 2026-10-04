import type { SavedProvider } from "./ModelSettingsDialogTypes.js";

export interface AiSimpleViewProps {
  readonly provider: SavedProvider;
  /** 实际解析出的模型名（长跑 #2：卡片显示 effective provider/model；解析不到传空串不显示）。 */
  readonly modelLabel?: string;
  readonly testing: boolean;
  readonly testError: string | null;
  readonly testNotice: string | null;
  readonly onChangeKey: () => void;
  readonly onRetest: () => void;
  readonly onOpenAdvanced: () => void;
}

function statusLabel(status: SavedProvider["apiKeyStatus"]): string {
  if (status === "present") return "密钥已配置";
  if (status === "not_required") return "无需密钥";
  return "尚未配置密钥";
}

export function AiSimpleView({
  provider,
  modelLabel,
  testing,
  testError,
  testNotice,
  onChangeKey,
  onRetest,
  onOpenAdvanced,
}: AiSimpleViewProps) {
  const ok = provider.apiKeyStatus === "present" || provider.apiKeyStatus === "not_required";

  return (
    <section className="ms-section ms-simple" aria-label="当前 AI 服务">
      <div className="ms-section-header">
        <div className="ms-section-title-row">
          <h3 className="ms-section-title">当前 AI 服务</h3>
        </div>
      </div>

      <div className="ms-simple-card">
        <div className="ms-simple-main">
          <span className={`ms-provider-dot ${ok ? "ok" : "warn"}`} />
          <div className="ms-simple-info">
            <div className="ms-simple-name">
              {provider.label}
              {modelLabel ? <span className="ms-simple-model"> · {modelLabel}</span> : null}
            </div>
            <div className="ms-simple-status">{statusLabel(provider.apiKeyStatus)}</div>
          </div>
        </div>
        <div className="ms-simple-actions">
          <button type="button" className="ms-btn ms-btn-xs" onClick={onChangeKey}>
            换密钥
          </button>
          <button type="button" className="ms-btn ms-btn-xs ms-btn-accent" disabled={testing} onClick={onRetest}>
            {testing ? (
              <><span className="ms-spinner ms-spinner-sm" /> 测试中</>
            ) : "重新测试"}
          </button>
        </div>
      </div>

      {testError && <div className="ms-error" role="alert">{testError}</div>}
      {testNotice && <div className="ms-notice">{testNotice}</div>}

      <button type="button" className="ms-advanced-entry" onClick={onOpenAdvanced}>
        高级设置
        <span className="ms-advanced-entry-hint">任务分配 · 深度分析 · 接口地址 · 记忆上限</span>
      </button>
    </section>
  );
}
