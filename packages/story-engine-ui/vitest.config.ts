import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test-setup-localstorage.ts", "./src/test-setup.ts"],
    globalSetup: ["./src/test-global-setup.ts"],
    // 不少服务端测试真建书、真打 git 存档（磁盘 IO 重）：机器忙时（CI 跑手、本机满负载）默认 5 秒会偶发超时。
    // 放宽只拉长真卡住时的等待，通过的用例不受影响。
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
