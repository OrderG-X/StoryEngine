/**
 * Node 26 自带全局 localStorage 访问器（未传 --localstorage-file 时值恒为 undefined），
 * vitest jsdom 环境的 populateGlobal 过滤规则（`k in global` 且不在内置 KEYS 列表则跳过）
 * 不会用 jsdom window 的 localStorage 覆盖它，导致测试里 window.localStorage 是 undefined。
 * 这里在 jsdom 环境装好、测试模块加载前，把 globalThis.localStorage 委托到 jsdom window 的
 * localStorage 上，保证全局只有一套存储。
 *
 * 条件守卫：仅当当前 localStorage 访问结果为 undefined 或抛错时才接管；
 * Node 22 下 jsdom 的 localStorage 已正常挂上全局，本文件是完全 no-op。
 */
let unavailable = false;
try {
  unavailable = globalThis.localStorage == null;
} catch {
  unavailable = true;
}

if (unavailable) {
  const jsdomWindow = (globalThis as { jsdom?: { window?: Window } }).jsdom?.window;
  if (jsdomWindow?.localStorage) {
    let override: Storage | undefined;
    Object.defineProperty(globalThis, "localStorage", {
      get: () => override ?? jsdomWindow.localStorage,
      set: (v: Storage) => {
        override = v;
      },
      configurable: true,
    });
  }
}
