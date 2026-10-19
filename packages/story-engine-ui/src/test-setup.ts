import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// 机器忙（CI 跑手、本机同时开着模拟器之类）时界面渲染慢：findBy / waitFor 默认只等 1 秒，会偶发超时。
// 放宽到 5 秒——只拉长失败时的等待，通过的用例照样一满足就返回。只在 jsdom 环境配（node 环境的服务端测试用不上）。
if (typeof document !== "undefined") {
  const { configure } = await import("@testing-library/react");
  configure({ asyncUtilTimeout: 5_000 });
}

// 定稿后的自动备份会往真书库旁的「备份/」和 ~/.story-engine 写文件：测试里一律换成空操作，
// 免得跑定稿链的用例把备份写进作者的真目录。要测它本身的（book-backup.test.ts）用 vi.importActual 拿真的。
vi.mock("./server/lib/book-backup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./server/lib/book-backup.js")>()),
  autoBackupAfterCommit: vi.fn(async () => null),
}));

// 每次调模型记一行用量会往 ~/.story-engine/usage 追加：测试里换成空操作，免得用例写进作者的真用量账。
// 要测它本身的（usage-ledger.test.ts）用 vi.importActual 拿真的。
vi.mock("./server/lib/usage-ledger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./server/lib/usage-ledger.js")>()),
  recordUsage: vi.fn(async () => undefined),
}));
