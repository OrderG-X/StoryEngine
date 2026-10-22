import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * 退场动画：open 变 false 时先别卸载，挂 data-closing 让 CSS 播退场，播完再卸。
 *
 * 用法：`const p = usePresence(open)`；`p.mounted` 决定渲不渲，根元素挂 `ref={p.ref}` 和
 * `data-closing={p.closing || undefined}`。退场多长由 CSS 定（`[data-closing]{animation:…}`），
 * 这里只等那个元素自己的 animationend；元素上没有动画（测试环境、减少动效、样式没写）就立刻卸。
 * 兜底计时器防 animationend 丢了（元素被挪走、动画被别的规则覆盖）。
 */
export function usePresence<T extends HTMLElement = HTMLElement>(open: boolean): {
  readonly mounted: boolean;
  readonly closing: boolean;
  readonly ref: (el: T | null) => void;
} {
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const elRef = useRef<T | null>(null);

  // 打开：立刻挂上（打断进行中的退场）。关上：只在挂着时进入退场。
  useLayoutEffect(() => {
    if (open) {
      setMounted(true);
      setClosing(false);
    } else if (mounted) {
      setClosing(true);
    }
    // mounted 只用来判断要不要进退场，不该触发重跑。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!closing) return;
    const el = elRef.current;
    const finish = () => {
      setClosing(false);
      setMounted(false);
    };
    const ms = el ? animationMs(el) : 0;
    if (!el || ms <= 0) {
      finish();
      return;
    }
    const onEnd = (e: AnimationEvent) => {
      if (e.target === el) finish();
    };
    el.addEventListener("animationend", onEnd);
    const timer = window.setTimeout(finish, ms + 80);
    return () => {
      el.removeEventListener("animationend", onEnd);
      window.clearTimeout(timer);
    };
  }, [closing]);

  const ref = useCallback((el: T | null) => {
    elRef.current = el;
  }, []);

  return { mounted, closing, ref };
}

/** 元素当前动画最长要多久（ms）；没动画 = 0。 */
function animationMs(el: HTMLElement): number {
  const cs = window.getComputedStyle(el);
  if (!cs.animationName || cs.animationName === "none") return 0;
  const durs = parseTimes(cs.animationDuration);
  const delays = parseTimes(cs.animationDelay);
  let max = 0;
  durs.forEach((d, i) => {
    max = Math.max(max, d + (delays[i] ?? 0));
  });
  return max;
}

function parseTimes(v: string): number[] {
  if (!v) return [];
  return v.split(",").map((t) => {
    const s = t.trim();
    const n = parseFloat(s);
    if (!Number.isFinite(n)) return 0;
    return s.endsWith("ms") ? n : n * 1000;
  });
}

/** 交给子组件的退场句柄：根元素挂 ref 和 data-closing。 */
export type PresenceHandle = {
  readonly closing: boolean;
  readonly ref: (el: HTMLElement | null) => void;
};
