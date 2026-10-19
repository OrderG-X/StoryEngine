import { useState } from "react";
import { runModelCheckup, type CheckupView } from "../../../api/modelSettingsClient.js";
import { PROVIDER_PRESETS } from "../../../constants/providerPresets.js";
import { TASK_LABELS, type SavedProvider } from "../../ModelSettingsDialogTypes.js";

interface InUseRow {
  readonly key: string;
  readonly providerLabel: string;
  readonly model: string;
  readonly tasks: readonly string[];
  readonly ok?: boolean;
  readonly ms?: number;
  readonly error?: string;
}

function taskNames(keys: readonly string[]): string {
  return keys.map((key) => TASK_LABELS[key] ?? key).join("、");
}

function formatMs(ms: number | undefined): string {
  if (ms === undefined) return "";
  return ms < 1000 ? `${ms} 毫秒` : `${(ms / 1000).toFixed(1)} 秒`;
}

/** 按「服务商|模型」把功能分到一起（界面上已分配的；体检后以服务端解析为准）。 */
export function rowsFromAssignments(tasks: Readonly<Record<string, string>>, savedProviders: readonly SavedProvider[]): InUseRow[] {
  const rows = new Map<string, { providerLabel: string; model: string; tasks: string[] }>();
  for (const key of Object.keys(TASK_LABELS)) {
    const value = tasks[key];
    if (!value) continue;
    const [providerId = "", model = ""] = value.split("|");
    if (!model) continue;
    const providerLabel = savedProviders.find((p) => p.id === providerId)?.label ?? PROVIDER_PRESETS.find((p) => p.id === providerId)?.label ?? providerId;
    const row = rows.get(value) ?? { providerLabel, model, tasks: [] };
    row.tasks.push(key);
    rows.set(value, row);
  }
  return [...rows.entries()].map(([key, row]) => ({ key, ...row }));
}

/**
 * 设置顶上的「在用」卡（P10）：6 个功能实际在用的模型（去重），每个一盏灯；「体检」真发一句极短对话，回耗时或原因。
 */
export function ModelsInUseCard({ tasks, savedProviders, api = { runModelCheckup } }: {
  readonly tasks: Readonly<Record<string, string>>;
  readonly savedProviders: readonly SavedProvider[];
  readonly api?: { readonly runModelCheckup: typeof runModelCheckup };
}) {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<CheckupView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows: readonly InUseRow[] = result ? result.models : rowsFromAssignments(tasks, savedProviders);
  const unassigned = Object.keys(TASK_LABELS).filter((key) => !tasks[key]);

  const checkup = async () => {
    setChecking(true);
    setError(null);
    try {
      setResult(await api.runModelCheckup());
    } catch (caught) {
      setError(`体检没做成：${caught instanceof Error ? caught.message : String(caught)}`);
    } finally {
      setChecking(false);
    }
  };

  const allOk = result !== null && result.models.length > 0 && result.models.every((model) => model.ok) && result.unresolved.length === 0;

  return (
    <section className="ms-section asm-inuse" aria-label="在用的模型">
      <div className="ms-section-header">
        <div className="ms-section-title-row">
          <h3 className="ms-section-title">在用的模型</h3>
          <button type="button" className="ms-btn ms-btn-xs" disabled={checking || (rows.length === 0 && !result)} onClick={() => void checkup()}>
            {checking ? "体检中…" : "体检"}
          </button>
        </div>
        <span className="ms-section-hint">
          {result ? (allOk ? "都通。" : "有没通的，看下面的原因。") : "体检会给每个模型真发一句很短的话，看通不通、多快。"}
        </span>
      </div>
      {rows.length === 0 && !result ? <p className="asm-inuse-empty">还没给功能选模型。接好服务商后在下面「各功能使用的 AI」里选。</p> : null}
      <ul className="asm-inuse-list">
        {rows.map((row) => (
          <li key={row.key}>
            <span className={`asm-dot ${row.ok === true ? "ok" : row.ok === false ? "bad" : ""}`} aria-label={row.ok === true ? "通" : row.ok === false ? "不通" : "没体检"} />
            <div className="asm-inuse-main">
              <span className="asm-inuse-name">{row.providerLabel} · {row.model}</span>
              <span className="asm-inuse-tasks">{taskNames(row.tasks)}</span>
              {row.ok === false && row.error ? <span className="asm-inuse-error" role="alert">{row.error}</span> : null}
            </div>
            {row.ok === true ? <span className="asm-inuse-ms">{formatMs(row.ms)}</span> : null}
          </li>
        ))}
      </ul>
      {result && result.unresolved.length > 0 ? (
        <ul className="asm-inuse-list">
          {result.unresolved.map((item) => (
            <li key={item.task}>
              <span className="asm-dot bad" aria-label="不通" />
              <div className="asm-inuse-main">
                <span className="asm-inuse-name">{TASK_LABELS[item.task] ?? item.task}</span>
                <span className="asm-inuse-error" role="alert">{item.error}</span>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {!result && unassigned.length > 0 && rows.length > 0 ? <p className="asm-inuse-empty">{taskNames(unassigned)}没单独选，用默认模型。</p> : null}
      {error ? <div className="ms-error" role="alert">{error}</div> : null}
    </section>
  );
}
