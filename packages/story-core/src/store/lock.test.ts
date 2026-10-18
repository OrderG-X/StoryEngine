import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withBookLock } from "./lock.js";

describe("书锁", () => {
  it("同一本书排队：后来的等前面的做完", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lock-"));
    const order: string[] = [];
    let open!: () => void;
    const gate = new Promise<void>((done) => { open = done; });
    const first = withBookLock(dir, async () => { order.push("a-in"); await gate; order.push("a-out"); });
    const second = withBookLock(dir, async () => { order.push("b"); });
    await new Promise((done) => setTimeout(done, 5));
    expect(order).toEqual(["a-in"]);
    open();
    await Promise.all([first, second]);
    expect(order).toEqual(["a-in", "a-out", "b"]);
  });

  it("可重入：拿着锁再要同一本书直接进，不卡死", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lock-"));
    const value = await withBookLock(dir, () => withBookLock(dir, () => withBookLock(dir, async () => 42)));
    expect(value).toBe(42);
  });

  it("锁放开后才跑的后续不算拿着锁，要重新排队", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lock-"));
    const order: string[] = [];
    let later!: Promise<void>;
    let open!: () => void;
    const gate = new Promise<void>((done) => { open = done; });
    await withBookLock(dir, async () => {
      later = gate.then(() => withBookLock(dir, async () => { order.push("later"); }));
    });
    let unblock!: () => void;
    const blocker = withBookLock(dir, () => new Promise<void>((done) => { unblock = () => { order.push("blocker"); done(); }; }));
    open();
    await new Promise((done) => setTimeout(done, 5));
    expect(order).toEqual([]);
    unblock();
    await Promise.all([blocker, later]);
    expect(order).toEqual(["blocker", "later"]);
  });
});
