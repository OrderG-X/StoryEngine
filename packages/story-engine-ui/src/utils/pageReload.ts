/**
 * 整页重载的可注入缝（jsdom 下 window.location.reload 不可 spy，单测需要替身）。
 * 生产恒为 window.location.reload；单测用 __setPageReloaderForTest 换成记录函数。
 */
let reloader: () => void = () => {
  window.location.reload();
};

export function reloadPage(): void {
  reloader();
}

/** 仅供单测：替换/还原重载实现（传 null 还原默认）。 */
export function __setPageReloaderForTest(fn: (() => void) | null): void {
  reloader = fn ?? (() => {
    window.location.reload();
  });
}
