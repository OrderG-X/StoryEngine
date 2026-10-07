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
