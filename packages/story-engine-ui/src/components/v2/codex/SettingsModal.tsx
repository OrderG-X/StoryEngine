/**
 * 设置弹窗（重构 P6 第 6 步：设置只留一套）。书架和写作台都开这一个。
 *
 *  - 模型：在用的模型和体检、服务商、任务分配、深度思考、对话记忆（AiSettingsPage）。
 *  - 用量：今天、本月、近 30 天，按书 / 功能 / 模型；按模型填单价算钱（P10）。
 *  - 备份：定稿后自动备份的开关和文件夹（P10）。
 *  - 显示：主题、字号。
 *  - 高级：直接改设置文件原文（排障 / 写回表单里没有的字段，比如自定义请求头）。
 */
import { useEffect } from "react";
import { AiSettingsPage } from "./AiSettingsPage.js";
import { BackupSettingsSection } from "./BackupSettingsSection.js";
import { DisplaySettingsEmbedded } from "./DisplaySettingsEmbedded.js";
import { RawSettingsSection } from "./RawSettingsSection.js";
import { UsageSection } from "./UsageSection.js";
import { IconClose } from "./icons.js";

export type SettingsTab = "model" | "usage" | "backup" | "display" | "raw";

const TABS: readonly { readonly id: SettingsTab; readonly label: string }[] = [
  { id: "model", label: "模型" },
  { id: "usage", label: "用量" },
  { id: "backup", label: "备份" },
  { id: "display", label: "显示" },
  { id: "raw", label: "高级" },
];

export function SettingsModal({ tab, onTab, onClose }: {
  readonly tab: SettingsTab;
  readonly onTab: (tab: SettingsTab) => void;
  readonly onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div className="se-scrim" aria-hidden="true" onClick={onClose} />
      <div className="se-modal" role="dialog" aria-modal="true" aria-label="设置">
        <nav className="se-modal-nav" aria-label="设置分类">
          <span className="se-modal-title">设置</span>
          {TABS.map((item) => (
            <button key={item.id} className={tab === item.id ? "on" : ""} type="button" onClick={() => onTab(item.id)}>{item.label}</button>
          ))}
        </nav>
        <div className="se-modal-body">
          <button className="se-icon-btn se-modal-close" type="button" aria-label="关闭设置" onClick={onClose}>
            <IconClose />
          </button>
          {tab === "model" ? <AiSettingsPage onBack={onClose} />
            : tab === "usage" ? <UsageSection />
            : tab === "backup" ? <BackupSettingsSection />
            : tab === "display" ? <DisplaySettingsEmbedded onBack={onClose} />
            : <RawSettingsSection />}
        </div>
      </div>
    </>
  );
}
