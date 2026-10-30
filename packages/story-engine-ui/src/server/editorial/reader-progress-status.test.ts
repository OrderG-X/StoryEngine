// @vitest-environment node
// 等读标注 + 等读回执（R5.2 起；R6.1 收口；写作版本 P2a 起不落盘）：readerWaitingHandlers 只在内存记当场补笔记读到哪，
// 「谁在等谁读完」在进程内登记（waiting-registry），readReadersCatchUpStatus 读的时候合进去；
// describeReaderWait 给回执那一句的人话。
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { describeReaderWait, readerWaitingHandlers, readInPlaceProgress } from "./reader-progress.js";
import { readReadersCatchUpStatus } from "./catch-up.js";
import { readerWaitingActions, registerReaderWaiting, unregisterReaderWaiting } from "./waiting-registry.js";

describe("readerWaitingHandlers（当场补笔记的进度，只在内存）", () => {
  it("开始 / 每章各记一次读到哪，结束（含中途失败）就撤；不往书里写任何文件", async () => {
    const dir = await makeHomeTempDir("reader-progress-");
    const handlers = readerWaitingHandlers(dir, "checker", 8);
    await handlers.onCatchUpBegin(5);
    expect(readInPlaceProgress(dir, "checker")).toEqual({ done: 5, total: 8 });
    expect((await readReadersCatchUpStatus(dir)).roles.find((role) => role.role === "checker")).toEqual({ role: "checker", reading: true, done: 5, total: 8 });
    await handlers.onProgress(6);
    expect(readInPlaceProgress(dir, "checker")).toEqual({ done: 6, total: 8 });
    await handlers.onCatchUpEnd(6);
    expect(readInPlaceProgress(dir, "checker")).toBeUndefined();
    expect((await readReadersCatchUpStatus(dir)).reading).toBe(false);
    expect(existsSync(join(dir, "agents"))).toBe(false);
  });
});

describe("等读登记表（R6.1）：readReadersCatchUpStatus 合并 waiting", () => {
  it("登记着「核账在等」＋在读 → 带 waiting；不在读 / 没登记 / 注销后 → 不带", async () => {
    const dir = await makeHomeTempDir("reader-progress-");
    const handlers = readerWaitingHandlers(dir, "checker", 58);
    await handlers.onCatchUpBegin(50);
    // 还没人在等：谁都别带 waiting。
    expect((await readReadersCatchUpStatus(dir)).roles.find((role) => role.role === "checker")).not.toHaveProperty("waiting");
    registerReaderWaiting(dir, "checker", "核账");
    registerReaderWaiting(dir, "ledger", "记账");
    expect(readerWaitingActions(dir, "checker")).toEqual(["核账"]);
    // 那个角色在读才带（进度行那截是「等它读完」，没在读就没有等它一说）。
    expect((await readReadersCatchUpStatus(dir)).roles.find((role) => role.role === "checker")).toMatchObject({ reading: true, done: 50, total: 58, waiting: "核账" });
    expect((await readReadersCatchUpStatus(dir)).roles.find((role) => role.role === "ledger")).not.toHaveProperty("waiting");
    // 注销了就不带。
    unregisterReaderWaiting(dir, "checker", "核账");
    unregisterReaderWaiting(dir, "ledger", "记账");
    expect(readerWaitingActions(dir, "checker")).toEqual([]);
    expect((await readReadersCatchUpStatus(dir)).roles.find((role) => role.role === "checker")).not.toHaveProperty("waiting");
    expect((await readReadersCatchUpStatus(dir)).reading).toBe(true);
    await handlers.onCatchUpEnd(58);
  });

  it("同一个角色被两个动作等：并到一句（核账、拟纲在等它读完）", async () => {
    const dir = await makeHomeTempDir("reader-progress-");
    const handlers = readerWaitingHandlers(dir, "checker", 10);
    await handlers.onCatchUpBegin(1);
    registerReaderWaiting(dir, "checker", "核账");
    registerReaderWaiting(dir, "checker", "拟纲");
    registerReaderWaiting(dir, "checker", "核账"); // 同一个动作等两次只记一份
    expect((await readReadersCatchUpStatus(dir)).roles.find((role) => role.role === "checker")).toMatchObject({ waiting: "核账、拟纲" });
    unregisterReaderWaiting(dir, "checker", "核账"); // 只撤一个，另一个还在
    expect((await readReadersCatchUpStatus(dir)).roles.find((role) => role.role === "checker")).toMatchObject({ waiting: "拟纲" });
    unregisterReaderWaiting(dir, "checker", "拟纲");
    expect((await readReadersCatchUpStatus(dir)).roles.find((role) => role.role === "checker")).not.toHaveProperty("waiting");
    await handlers.onCatchUpEnd(10);
  });

  it("盘上残留的旧 progress.json（P2a 之前落的）一概不认：重启后没人在读就不显示在读", async () => {
    const dir = await makeHomeTempDir("reader-progress-");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(dir, "agents", "checker"), { recursive: true });
    await writeFile(join(dir, "agents", "checker", "progress.json"), JSON.stringify({ role: "checker", reading: true, done: 3, total: 10, waiting: "核账" }), "utf-8");
    const status = await readReadersCatchUpStatus(dir);
    expect(status.reading).toBe(false);
    expect(status.roles[0]).toEqual({ role: "checker", reading: false, done: 0, total: 0 });
  });
});

describe("describeReaderWait（等读回执那一句，R5.2 必做 2）", () => {
  it("多章：这次先等核账员读完第 51～58 章再核（不报用时）", () => {
    expect(describeReaderWait("checker", { from: 51, to: 58, ms: 91_000 }, "核"))
      .toBe("这次先等核账员读完第 51～58 章再核");
  });

  it("单章不带波浪号", () => {
    expect(describeReaderWait("ledger", { from: 4, to: 4, ms: 8_400 }, "记账"))
      .toBe("这次先等记账员读完第 4 章再记账");
    expect(describeReaderWait("planner", { from: 1, to: 2, ms: 120_000 }, "拟纲"))
      .toBe("这次先等章纲员读完第 1～2 章再拟纲");
  });

});
