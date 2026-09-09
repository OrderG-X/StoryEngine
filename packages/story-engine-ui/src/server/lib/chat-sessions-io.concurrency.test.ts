/**
 * 会话 IO 并发安全回归测试（fuzz 测出的 BUG-1/2/3）。
 *
 * 根因：chat-sessions-io 对 index.json / 会话文件做「读→改→写」时无互斥锁、
 * 写盘非原子。并发请求（自动起名 + autosave + 点「清理」+ 多标签页/双击）会：
 *   BUG-1 并发建会话 → index.json 后写覆盖先写 → 会话从索引丢失 / 抛「会话不存在」
 *   BUG-2 并发归档 + 保存 → 字段互相覆盖 → archivedCount > messages.length（活跃窗口变空，丢历史）
 *   BUG-3 并发尺寸分化写 → writeFile O_TRUNC 撕裂 JSON → readChatSession 返回 null（会话消失）
 *
 * 修法：原子写（temp + rename）+ 项目级写锁串行化。修复前这些测试会红，修复后全绿。
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readChatSessionIndex, readChatSession, createChatSession,
  saveChatSessionMessages, archiveOldMessages,
} from "./chat-sessions-io.js";
import type { StoredChatSession } from "./chat-sessions-io.js";

// 原子写带 fsync（d18c6e8）后每 trial 多次落盘变慢，25 轮在并行全量跑时撞默认 5s 超时；
// 降到 10 轮仍够复现并发交错，慢测试另给显式超时（CLAUDE.md：磁盘 IO 重的测试给显式超时）。
const TRIALS = 10;

async function tmpProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "chat-race-"));
}
function msgs(n: number, len: number, tag: string) {
  return Array.from({ length: n }, (_, i) => ({
    id: `${tag}-${i}`, role: i % 2 === 0 ? "user" : "assistant", content: "字".repeat(len),
  }));
}
const jitter = () => new Promise((r) => setTimeout(r, Math.random() * 6));

describe("chat-sessions-io 并发安全", () => {
  it("BUG-1: 并发 createChatSession 不丢会话、不抛错", { timeout: 30_000 }, async () => {
    for (let t = 0; t < TRIALS; t++) {
      const dir = await tmpProject();
      await readChatSessionIndex(dir); // 初始化 index（1 条空会话）
      const settled = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) => jitter().then(() => createChatSession(dir, `s-${i}`))),
      );
      const okIds = settled
        .filter((r): r is PromiseFulfilledResult<StoredChatSession> => r.status === "fulfilled")
        .map((r) => r.value.id);
      const rejected = settled.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      expect(rejected.map((r) => String(r.reason?.message ?? r.reason)).join(" ; "),
        `trial ${t}: 并发创建抛错`).toBe("");
      const indexIds = new Set((await readChatSessionIndex(dir)).sessions.map((s) => s.id));
      for (const id of okIds) {
        expect(indexIds.has(id), `trial ${t}: 会话 ${id} 创建成功却从 index 丢失`).toBe(true);
      }
    }
  });

  it("BUG-2: 并发 archive + save 不产生 archivedCount > messages.length", async () => {
    for (let t = 0; t < TRIALS; t++) {
      const dir = await tmpProject();
      const id = (await readChatSessionIndex(dir)).activeSessionId;
      await saveChatSessionMessages(dir, id, msgs(25, 200, "big"));
      await Promise.allSettled([
        archiveOldMessages(dir, id, 800),
        saveChatSessionMessages(dir, id, msgs(5, 4, "small")),
      ]);
      const s = await readChatSession(dir, id);
      expect(s, `trial ${t}: 会话读成 null`).not.toBeNull();
      expect(s!.archivedCount <= s!.messages.length,
        `trial ${t}: archivedCount=${s!.archivedCount} > len=${s!.messages.length}`).toBe(true);
    }
  });

  it("BUG-3: 并发尺寸分化写不撕裂 JSON（会话不变 null）", { timeout: 30_000 }, async () => {
    for (let t = 0; t < TRIALS; t++) {
      const dir = await tmpProject();
      const id = (await readChatSessionIndex(dir)).activeSessionId;
      await saveChatSessionMessages(dir, id, msgs(50, 50, "old"));
      await Promise.allSettled(
        Array.from({ length: 10 }, (_, i) => jitter().then(() => saveChatSessionMessages(dir, id, msgs(i + 1, 100, `w${i}`)))),
      );
      const s = await readChatSession(dir, id);
      expect(s, `trial ${t}: 并发写后会话读成 null（撕裂）`).not.toBeNull();
    }
  });
});
