/**
 * 改版图标集：统一 24 网格、1.6 线宽的描边图标（Lucide 风格，内联 SVG，不引依赖）。
 * 颜色走 currentColor，尺寸默认 18；纯装饰，一律 aria-hidden，语义由外层按钮的 aria-label 承担。
 */
import type { ReactNode } from "react";

interface IconProps {
  readonly size?: number;
  readonly strokeWidth?: number;
  readonly className?: string;
}

function Icon({ size = 18, strokeWidth = 1.6, className, children }: IconProps & { readonly children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {children}
    </svg>
  );
}

export function IconPanelLeft(props: IconProps) {
  return <Icon {...props}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></Icon>;
}

export function IconPanelRight(props: IconProps) {
  return <Icon {...props}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></Icon>;
}

export function IconChevronLeft(props: IconProps) {
  return <Icon {...props}><path d="M15 18l-6-6 6-6" /></Icon>;
}

export function IconFocus(props: IconProps) {
  return <Icon {...props}><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></Icon>;
}

export function IconSettings(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </Icon>
  );
}

export function IconClose(props: IconProps) {
  return <Icon {...props}><path d="M6 6l12 12M18 6L6 18" /></Icon>;
}

export function IconSearch(props: IconProps) {
  return <Icon {...props}><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></Icon>;
}

export function IconCheck(props: IconProps) {
  return <Icon {...props}><path d="M5 12.5l4.5 4.5L19 7.5" /></Icon>;
}

export function IconSparkle(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
      <path d="M19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7z" />
    </Icon>
  );
}

export function IconSun(props: IconProps) {
  return <Icon {...props}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></Icon>;
}

export function IconMoon(props: IconProps) {
  return <Icon {...props}><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" /></Icon>;
}

export function IconArrowRight(props: IconProps) {
  return <Icon {...props}><path d="M5 12h14M13 6l6 6-6 6" /></Icon>;
}

export function IconFile(props: IconProps) {
  return <Icon {...props}><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6M8 13h8M8 17h5" /></Icon>;
}

export function IconUser(props: IconProps) {
  return <Icon {...props}><circle cx="12" cy="8" r="4" /><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" /></Icon>;
}

export function IconBook(props: IconProps) {
  return <Icon {...props}><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z" /><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5" /></Icon>;
}

export function IconCopy(props: IconProps) {
  return <Icon {...props}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" /></Icon>;
}

export function IconPlus(props: IconProps) {
  return <Icon {...props}><path d="M12 5v14M5 12h14" /></Icon>;
}
