import "@testing-library/jest-dom/vitest";

// 机器忙（CI 跑手、本机同时开着模拟器之类）时界面渲染慢：findBy / waitFor 默认只等 1 秒，会偶发超时。
// 放宽到 5 秒——只拉长失败时的等待，通过的用例照样一满足就返回。只在 jsdom 环境配（node 环境的服务端测试用不上）。
if (typeof document !== "undefined") {
  const { configure } = await import("@testing-library/react");
  configure({ asyncUtilTimeout: 5_000 });
}
