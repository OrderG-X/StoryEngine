// @vitest-environment node
// 改句记录 v2（写作版本 P2a 设计第三节）：老格式照读；按键发布一次、零条也记；只截改句不截键；清理时清键。
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFixLog, clearFixLogKeys, publishFixLogLocked, readFixLog } from "./fix-log.js";
import { makeHomeTempDir } from "./home-test-tmp.js";

let book: string;
beforeEach(async () => {
  book = await makeHomeTempDir("fix-log-");
});
afterEach(async () => {
  await rm(book, { recursive: true, force: true });
});

const file = () => join(book, ".story-engine-ui/continuity-checks/0003.fixes.json");
const raw = async () => JSON.parse(await readFile(file(), "utf-8"));

describe("改句记录", () => {
  it("老格式（数组）照读；之后写成 v2，老的改句留着", async () => {
    await mkdir(join(book, ".story-engine-ui/continuity-checks"), { recursive: true });
    await writeFile(file(), JSON.stringify([{ from: "甲", to: "乙" }, { from: "丙", to: "" }]));
    expect(await readFixLog(book, 3)).toEqual([{ from: "甲", to: "乙" }]);
    await appendFixLog(book, 3, [{ from: "丁", to: "戊" }]);
    expect(await raw()).toMatchObject({ schema: "fix-log/2", fixes: [{ from: "甲", to: "乙" }, { from: "丁", to: "戊" }], published: {} });
  });

  it("按键发布一次：零条也记键；同键再来不重记；只留最近 50 条改句，键不截；清理时只清这次操作的键", async () => {
    expect(await publishFixLogLocked(book, 3, "op-a:apply", [])).toBe(true);
    expect(await publishFixLogLocked(book, 3, "op-a:apply", [{ from: "甲", to: "乙" }])).toBe(false);
    expect(await readFixLog(book, 3)).toEqual([]);
    const many = Array.from({ length: 60 }, (_, i) => ({ from: `前${i}`, to: `后${i}` }));
    expect(await publishFixLogLocked(book, 3, "op-b:apply", many)).toBe(true);
    const log = await raw();
    expect(log.fixes).toHaveLength(50);
    expect(log.fixes[0]).toEqual({ from: "前10", to: "后10" });
    expect(Object.keys(log.published).sort()).toEqual(["op-a:apply", "op-b:apply"]);
    expect(log.published["op-a:apply"].count).toBe(0);
    await clearFixLogKeys(book, "op-a");
    expect(Object.keys((await raw()).published)).toEqual(["op-b:apply"]);
    expect((await raw()).fixes).toHaveLength(50);
  });
});
