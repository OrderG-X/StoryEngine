import { useMemo, useState } from "react";
import { WIZARD_SERVICE_PRESETS, type WizardServicePreset } from "../constants/wizardPresets.js";

export interface AiSetupWizardProps {
  readonly busy: boolean;
  readonly error: string | null;
  readonly onTestAndStart: (input: {
    readonly preset: WizardServicePreset;
    readonly apiKey: string;
    readonly baseUrl: string;
  }) => void;
}

type WizardStep = 1 | 2 | 3;

export function AiSetupWizard({ busy, error, onTestAndStart }: AiSetupWizardProps) {
  const [step, setStep] = useState<WizardStep>(1);
  const [presetId, setPresetId] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [showKeyHelp, setShowKeyHelp] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);

  const preset = useMemo(
    () => WIZARD_SERVICE_PRESETS.find((p) => p.id === presetId) ?? null,
    [presetId],
  );

  const canGoStep2 = Boolean(preset);
  const canGoStep3 = Boolean(
    preset
    && apiKey.trim()
    && (!preset.requiresBaseUrl || baseUrl.trim()),
  );

  const selectPreset = (next: WizardServicePreset) => {
    setPresetId(next.id);
    setBaseUrl(next.requiresBaseUrl ? "" : next.baseUrl);
    setShowKeyHelp(false);
  };

  return (
    <section className="ms-section ms-wizard" aria-label="AI 设置向导">
      <div className="ms-wizard-head">
        <h3 className="ms-section-title">开始使用 AI</h3>
        <p className="ms-wizard-lead">三步即可：选服务 → 填密钥 → 测试并开始。推荐配置会自动就绪。</p>
        <ol className="ms-wizard-steps" aria-label="向导进度">
          <li className={step === 1 ? "is-active" : step > 1 ? "is-done" : ""}>1. 选择服务</li>
          <li className={step === 2 ? "is-active" : step > 2 ? "is-done" : ""}>2. 填密钥</li>
          <li className={step === 3 ? "is-active" : ""}>3. 测试并开始</li>
        </ol>
      </div>

      {step === 1 && (
        <div className="ms-wizard-pane">
          <p className="ms-wizard-pane-title">选择 AI 服务</p>
          <div className="ms-wizard-preset-grid">
            {WIZARD_SERVICE_PRESETS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`ms-wizard-preset ${presetId === item.id ? "is-active" : ""}`}
                onClick={() => selectPreset(item)}
              >
                <span className="ms-wizard-preset-name">{item.label}</span>
                <span className="ms-wizard-preset-hint">
                  {item.requiresBaseUrl ? "需自填接口地址" : item.recommendedModel}
                </span>
              </button>
            ))}
          </div>
          <div className="ms-wizard-nav">
            <button
              type="button"
              className="ms-btn ms-btn-primary"
              disabled={!canGoStep2}
              onClick={() => setStep(2)}
            >
              下一步
            </button>
          </div>
        </div>
      )}

      {step === 2 && preset && (
        <div className="ms-wizard-pane">
          <p className="ms-wizard-pane-title">填写 {preset.label} 的 API 密钥</p>
          {preset.requiresBaseUrl && (
            <div className="ms-form-field">
              <label className="ms-form-label">接口地址 <span className="ms-required">*</span></label>
              <input
                className="ms-input"
                type="url"
                placeholder="https://api.example.com/v1"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                autoComplete="off"
              />
            </div>
          )}
          <div className="ms-form-field">
            <label className="ms-form-label">API 密钥 <span className="ms-required">*</span></label>
            <div className="ms-input-group">
              <input
                className="ms-input ms-input-key"
                type={showApiKey ? "text" : "password"}
                placeholder="sk-…"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                autoComplete="off"
              />
              <button
                type="button"
                className="ms-input-icon-btn"
                onClick={() => setShowApiKey((v) => !v)}
                aria-label={showApiKey ? "隐藏密钥" : "显示密钥"}
              >
                {showApiKey ? "隐" : "显"}
              </button>
            </div>
            <button
              type="button"
              className="ms-wizard-help-link"
              onClick={() => setShowKeyHelp((v) => !v)}
            >
              怎么拿密钥？
            </button>
            {showKeyHelp && <p className="ms-field-hint ms-wizard-key-help">{preset.keyHelp}</p>}
          </div>
          <div className="ms-wizard-nav">
            <button type="button" className="ms-btn ms-btn-ghost" onClick={() => setStep(1)}>上一步</button>
            <button
              type="button"
              className="ms-btn ms-btn-primary"
              disabled={!canGoStep3}
              onClick={() => setStep(3)}
            >
              下一步
            </button>
          </div>
        </div>
      )}

      {step === 3 && preset && (
        <div className="ms-wizard-pane">
          <p className="ms-wizard-pane-title">测试并开始使用</p>
          <dl className="ms-wizard-summary">
            <div>
              <dt>AI 服务</dt>
              <dd>{preset.label}</dd>
            </div>
            <div>
              <dt>接口地址</dt>
              <dd className="ms-wizard-summary-url">{(preset.requiresBaseUrl ? baseUrl : preset.baseUrl) || "—"}</dd>
            </div>
            {!preset.requiresBaseUrl && (
              <div>
                <dt>推荐模型</dt>
                <dd>{preset.recommendedModel}</dd>
              </div>
            )}
          </dl>
          <p className="ms-field-hint">
            将测试连通性；成功后自动写入推荐配置（各功能默认使用推荐模型与深度分析建议）。
          </p>
          {error && <div className="ms-error" role="alert">{error}</div>}
          <div className="ms-wizard-nav">
            <button type="button" className="ms-btn ms-btn-ghost" disabled={busy} onClick={() => setStep(2)}>
              上一步
            </button>
            <button
              type="button"
              className="ms-btn ms-btn-primary"
              disabled={busy || !canGoStep3}
              onClick={() => onTestAndStart({
                preset,
                apiKey: apiKey.trim(),
                baseUrl: (preset.requiresBaseUrl ? baseUrl : preset.baseUrl).trim(),
              })}
            >
              {busy ? (
                <><span className="ms-spinner" /> 测试中...</>
              ) : error ? "重试" : "测试并开始使用"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
