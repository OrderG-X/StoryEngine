import { useThemeStore } from "../../../stores/themeStore.js";
import { IconMoon, IconSun } from "./icons.js";

/** 深色 / 纸面主题切换（顶栏与书架共用）。图标表示「点了会切到哪个」：深色时显示太阳，纸面时显示月亮。 */
export function ThemeToggleButton({ className = "se-icon-btn" }: { readonly className?: string }) {
  const mode = useThemeStore((s) => s.mode);
  const toggle = useThemeStore((s) => s.toggle);
  const label = mode === "dark" ? "切换到纸面主题" : "切换到深色主题";
  return (
    <button className={className} type="button" aria-label={label} title={label} onClick={toggle}>
      {mode === "dark" ? <IconSun /> : <IconMoon />}
    </button>
  );
}
