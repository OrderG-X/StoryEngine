// @vitest-environment node
// R5.2 等读标注 + 等读回执：readerWaitingHandlers 把「谁在等谁读完」写进 progress.json（进度行走 R4.3 的轮询链路），
// 读完清掉；readReadersCatchUpStatus 透传 waiting；describeReaderWait 给回执那一句的人话。
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
} from "./reader-progress.js";
import { readReadersCatchUpStatus } from "./catch-up.js";

const readProgressJson = async (dir: string, roleId: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(join(dir, "agents", roleId, "progress.json"), "utf-8"));

describe("readerWaitingHandlers（等读标注，R5.2 必做 1）", () => {
  it("开始 / 每章 / 结束各落一次 progress.json：waiting 标「核账」，读完翻回 reading:false 并清掉 waiting", async () => {
    const dir = await makeHomeTempDir("reader-progress-");
    const handlers = readerWaitingHandlers(dir, "checker", 8, "核账");
    await handlers.onCatchUpBegin(5);
    await expect(readProgressJson(dir, "checker")).resolves.toMatchObject({ role: "checker", reading: true, done: 5, total: 8, waiting: "核账" });
    await handlers.onProgress(6);
    await expect(readProgressJson(dir, "checker")).resolves.toMatchObject({ reading: true, done: 6, total: 8, waiting: "核账" });
    await handlers.onCatchUpEnd(8);
    await expect(readProgressJson(dir, "checker")).resolves.toMatchObject({ role: "checker", reading: false, done: 8, total: 8 });
    await expect(readProgressJson(dir, "checker")).resolves.not.toHaveProperty("waiting");
  });

  it("中途失败也如实收尾：done 停在落下的那章、reading:false", async () => {
    const dir = await makeHomeTempDir("reader-progress-");
    const handlers = readerWaitingHandlers(dir, "planner", 10, "拟纲");
    await handlers.onCatchUpBegin(4);
    await handlers.onCatchUpEnd(6); // 补到第 6 章挂了
    await expect(readProgressJson(dir, "planner")).resolves.toMatchObject({ reading: false, done: 6, total: 10 });
  });

  it("readReadersCatchUpStatus 透传 waiting（轮询接口拿的就是这份形状）", async () => {
    const dir = await makeHomeTempDir("reader-progress-");
    await writeReaderProgress(dir, { role: "checker", reading: true, done: 50, total: 58, updatedAt: "now", waiting: "核账" });
    await writeReaderProgress(dir, { role: "ledger", reading: false, done: 58, total: 58, updatedAt: "now" });
    const status = await readReadersCatchUpStatus(dir);
    expect(status.reading).toBe(true);
    expect(status.roles.find((role) => role.role === "checker")).toMatchObject({ reading: true, done: 50, total: 58, waiting: "核账" });
    expect(status.roles.find((role) => role.role === "ledger")).not.toHaveProperty("waiting");
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
