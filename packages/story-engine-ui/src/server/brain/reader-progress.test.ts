// @vitest-environment node
// 等读标注 + 等读回执（R5.2 起；R6.1 收口）：readerWaitingHandlers 只落 reading/done/total，
// 「谁在等谁读完」改在进程内登记（waiting-registry），readReadersCatchUpStatus 读的时候合进去——
// 后台补读和当场补笔记都写 progress.json，waiting 不进文件，谁也抹不掉谁的标注；
// describeReaderWait 给回执那一句的人话。
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import {
  describeReaderWait,
  formatReaderWaitDuration,
  readReaderProgress,
  readerWaitingHandlers,
  writeReaderProgress,
} from "../editorial/reader-progress.js";
import { readReadersCatchUpStatus } from "./catch-up.js";
import { readerWaitingActions, registerReaderWaiting, unregisterReaderWaiting } from "../editorial/waiting-registry.js";

const readProgressJson = async (dir: string, roleId: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(join(dir, "agents", roleId, "progress.json"), "utf-8"));

describe("readerWaitingHandlers（等读进度落盘，R5.2 起；R6.1 不再落 waiting）", () => {
  it("开始 / 每章 / 结束各落一次 progress.json：reading / done / total 如实走，waiting 不进文件", async () => {
    const dir = await makeHomeTempDir("reader-progress-");
    const handlers = readerWaitingHandlers(dir, "checker", 8);
    await handlers.onCatchUpBegin(5);
    await expect(readProgressJson(dir, "checker")).resolves.toMatchObject({ role: "checker", reading: true, done: 5, total: 8 });
    await expect(readProgressJson(dir, "checker")).resolves.not.toHaveProperty("waiting");
    await handlers.onProgress(6);
    await expect(readProgressJson(dir, "checker")).resolves.toMatchObject({ reading: true, done: 6, total: 8 });
    await handlers.onCatchUpEnd(8);
    await expect(readProgressJson(dir, "checker")).resolves.toMatchObject({ role: "checker", reading: false, done: 8, total: 8 });
    await expect(readProgressJson(dir, "checker")).resolves.not.toHaveProperty("waiting");
  });

  it("中途失败也如实收尾：done 停在落下的那章、reading:false", async () => {
    const dir = await makeHomeTempDir("reader-progress-");
    const handlers = readerWaitingHandlers(dir, "planner", 10);
    await handlers.onCatchUpBegin(4);
    await handlers.onCatchUpEnd(6); // 补到第 6 章挂了
    await expect(readProgressJson(dir, "planner")).resolves.toMatchObject({ reading: false, done: 6, total: 10 });
  });

  it("进度文件坏了 / 带了脏 waiting（空串）→ 当没有，不给作者看脏值", async () => {
    const dir = await makeHomeTempDir("reader-progress-");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "agents", "checker"), { recursive: true });
    await writeFile(join(dir, "agents", "checker", "progress.json"), "{oops", "utf-8");
    await expect(readReaderProgress(dir, "checker")).resolves.toBeUndefined();
    await writeReaderProgress(dir, { role: "ledger", reading: true, done: 1, total: 2, updatedAt: "now", waiting: "" });
    await expect(readReaderProgress(dir, "ledger")).resolves.not.toHaveProperty("waiting");
  });
});

describe("等读登记表（R6.1）：readReadersCatchUpStatus 合并 waiting，progress.json 不再记它", () => {
  it("登记着「核账在等」＋在读 → 带 waiting；不在读 / 没登记 / 注销后 → 不带", async () => {
    const dir = await makeHomeTempDir("reader-progress-");
    await writeReaderProgress(dir, { role: "checker", reading: true, done: 50, total: 58, updatedAt: "now" });
    await writeReaderProgress(dir, { role: "ledger", reading: false, done: 58, total: 58, updatedAt: "now" });
    // 还没人在等：谁都别带 waiting。
    expect((await readReadersCatchUpStatus(dir)).roles.find((role) => role.role === "checker")).not.toHaveProperty("waiting");
    registerReaderWaiting(dir, "checker", "核账");
    expect(readerWaitingActions(dir, "checker")).toEqual(["核账"]);
    // 那个角色在读才带（进度行那截是「等它读完」，没在读就没有等它一说）。
    expect((await readReadersCatchUpStatus(dir)).roles.find((role) => role.role === "checker")).toMatchObject({ reading: true, done: 50, total: 58, waiting: "核账" });
    expect((await readReadersCatchUpStatus(dir)).roles.find((role) => role.role === "ledger")).not.toHaveProperty("waiting");
    // 注销了就不带。
    unregisterReaderWaiting(dir, "checker", "核账");
    expect(readerWaitingActions(dir, "checker")).toEqual([]);
    expect((await readReadersCatchUpStatus(dir)).roles.find((role) => role.role === "checker")).not.toHaveProperty("waiting");
    expect((await readReadersCatchUpStatus(dir)).reading).toBe(true);
  });

  it("同一个角色被两个动作等：并到一句（核账、拟纲在等它读完）", async () => {
    const dir = await makeHomeTempDir("reader-progress-");
    await writeReaderProgress(dir, { role: "checker", reading: true, done: 1, total: 10, updatedAt: "now" });
    registerReaderWaiting(dir, "checker", "核账");
    registerReaderWaiting(dir, "checker", "拟纲");
    registerReaderWaiting(dir, "checker", "核账"); // 同一个动作等两次只记一份
    expect((await readReadersCatchUpStatus(dir)).roles.find((role) => role.role === "checker")).toMatchObject({ waiting: "核账、拟纲" });
    unregisterReaderWaiting(dir, "checker", "核账"); // 只撤一个，另一个还在
    expect((await readReadersCatchUpStatus(dir)).roles.find((role) => role.role === "checker")).toMatchObject({ waiting: "拟纲" });
    unregisterReaderWaiting(dir, "checker", "拟纲");
    expect((await readReadersCatchUpStatus(dir)).roles.find((role) => role.role === "checker")).not.toHaveProperty("waiting");
  });

  it("盘上残留的 waiting（R5.2 落过的旧文件）展示不再认：重启后登记表是空的，不显示幽灵标注", async () => {
    const dir = await makeHomeTempDir("reader-progress-");
    await writeReaderProgress(dir, { role: "checker", reading: true, done: 3, total: 10, updatedAt: "now", waiting: "核账" });
    expect(readerWaitingActions(dir, "checker")).toEqual([]);
    expect((await readReadersCatchUpStatus(dir)).roles.find((role) => role.role === "checker")).not.toHaveProperty("waiting");
  });
});

describe("describeReaderWait（等读回执那一句，R5.2 必做 2）", () => {
  it("多章：这次先等核账员读完第 51～58 章（用时 1 分 31 秒）再核", () => {
    expect(describeReaderWait("checker", { from: 51, to: 58, ms: 91_000 }, "核"))
      .toBe("这次先等核账员读完第 51～58 章（用时 1 分 31 秒）再核");
  });

  it("单章不带波浪号；不足一分钟只报秒", () => {
    expect(describeReaderWait("ledger", { from: 4, to: 4, ms: 8_400 }, "记账"))
      .toBe("这次先等记账员读完第 4 章（用时 8 秒）再记账");
    expect(describeReaderWait("planner", { from: 1, to: 2, ms: 120_000 }, "拟纲"))
      .toBe("这次先等章纲员读完第 1～2 章（用时 2 分钟）再拟纲");
  });

  it("用时的人话：秒取整、分钟整除不带秒", () => {
    expect(formatReaderWaitDuration(0)).toBe("1 秒");
    expect(formatReaderWaitDuration(59_400)).toBe("59 秒");
    expect(formatReaderWaitDuration(60_000)).toBe("1 分钟");
    expect(formatReaderWaitDuration(91_000)).toBe("1 分 31 秒");
  });
});
