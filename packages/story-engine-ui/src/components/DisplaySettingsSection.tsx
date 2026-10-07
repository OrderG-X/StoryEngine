import {
  useDisplaySettingsStore,
  ZOOM_MIN,
  ZOOM_MAX,
  ZOOM_STEP,
  DESK_FONT_MIN,
  DESK_FONT_MAX,
  DESK_FONT_STEP,
  type DisplaySettingKey,
} from "../stores/displaySettingsStore.js";
import { useThemeStore } from "../stores/themeStore.js";

/**
 * DisplaySettingsSection — 设置面板顶部「显示 · 字号」区。
 *
 * 三处字号（聊天 / 界面 / 正文）统一在这里调，读写 displaySettingsStore（自动落盘 localStorage）。
 * 每行：左标签+说明，右侧 A− / 当前值 / A+ / 重置。zoom 显示百分比，正文显示 px。
 */

type Row = {
  readonly key: DisplaySettingKey;
  readonly label: string;
  readonly hint: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** 把存储值格式化成展示文案（zoom→百分比，正文→px）。 */
  readonly format: (value: number) => string;
};

const ROWS: readonly Row[] = [
  {
    key: "chatZoom",
    label: "聊天字号",
    hint: "右侧 AI 对话",
    min: ZOOM_MIN,
    max: ZOOM_MAX,
    step: ZOOM_STEP,
    format: (v) => `${Math.round(v * 100)}%`,
  },
  {
    key: "uiZoom",
    label: "界面字号",
    hint: "章节列表 + 设定本",
    min: ZOOM_MIN,
    max: ZOOM_MAX,
    step: ZOOM_STEP,
    format: (v) => `${Math.round(v * 100)}%`,
  },
  {
    key: "deskFontSize",
    label: "正文字号",
    hint: "写作台稿纸",
    min: DESK_FONT_MIN,
    max: DESK_FONT_MAX,
    step: DESK_FONT_STEP,
    format: (v) => `${Math.round(v)}px`,
  },
];

export function DisplaySettingsSection() {
  // 逐项订阅（避免对象字面量 selector 触发 zustand 的 snapshot 警告）。
  const chatZoom = useDisplaySettingsStore((s) => s.chatZoom);
  const uiZoom = useDisplaySettingsStore((s) => s.uiZoom);
  const deskFontSize = useDisplaySettingsStore((s) => s.deskFontSize);
  const rewriteZoom = useDisplaySettingsStore((s) => s.rewriteZoom);
  const adjust = useDisplaySettingsStore((s) => s.adjustDisplaySetting);
  const resetOne = useDisplaySettingsStore((s) => s.resetDisplaySetting);
  // rewriteZoom 不在本面板列出（它在选区改写预览框头部就地调），仅为类型完整带上。
  const values: Record<DisplaySettingKey, number> = { chatZoom, uiZoom, deskFontSize, rewriteZoom };
  const themeMode = useThemeStore((s) => s.mode);
  const setThemeMode = useThemeStore((s) => s.setMode);

  return (
    <section className="ms-section ms-display-section">
      <div className="ms-section-header">
        <div className="ms-section-title-row">
          <h3 className="ms-section-title">显示</h3>
        </div>
        <span className="ms-section-hint">调整后立即生效，刷新仍在</span>
      </div>

      <div className="ms-display-list">
        <div className="ms-display-row">
          <div className="ms-display-label-col">
            <span className="ms-display-name">主题</span>
            <span className="ms-display-hint">纸面主题适合白天长时间写作</span>
          </div>
          <div className="ms-display-control ms-theme-seg" role="group" aria-label="主题">
            <button type="button" className={`ms-display-btn${themeMode === "dark" ? " is-on" : ""}`} aria-pressed={themeMode === "dark"} onClick={() => setThemeMode("dark")}>深色</button>
            <button type="button" className={`ms-display-btn${themeMode === "light" ? " is-on" : ""}`} aria-pressed={themeMode === "light"} onClick={() => setThemeMode("light")}>纸面</button>
          </div>
        </div>
        {ROWS.map((row) => {
          const value = values[row.key];
          return (
            <div className="ms-display-row" key={row.key}>
              <div className="ms-display-label-col">
                <span className="ms-display-name">{row.label}</span>
                <span className="ms-display-hint">{row.hint}</span>
              </div>
              <div className="ms-display-control">
                <button
                  type="button"
                  className="ms-display-btn"
                  disabled={value <= row.min}
                  onClick={() => adjust(row.key, -row.step)}
                  aria-label={`${row.label}减小`}
                >
                  A−
                </button>
                <span className="ms-display-value">{row.format(value)}</span>
                <button
                  type="button"
                  className="ms-display-btn ms-display-btn-plus"
                  disabled={value >= row.max}
                  onClick={() => adjust(row.key, row.step)}
                  aria-label={`${row.label}增大`}
                >
                  A+
                </button>
                <button
                  type="button"
                  className="ms-display-reset"
                  onClick={() => resetOne(row.key)}
                  aria-label={`${row.label}恢复默认`}
                  title="恢复默认"
                >
                  重置
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
