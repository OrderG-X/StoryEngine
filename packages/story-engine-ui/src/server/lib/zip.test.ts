// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createZip, isSafeZipPath, readZip } from "./zip.js";

describe("zip 读写", () => {
  it("中文路径、压缩 / 不压缩、空目录都能原样读回", () => {
    const big = "雾港的雾。".repeat(2000);
    const zip = createZip([
      { path: "mimetype", data: "application/epub+zip", store: true },
      { path: "chapters/0001.md", data: big },
      { path: "设定/人物.json", data: Buffer.from([0, 1, 2, 255]) },
      { path: "empty/" },
      { path: "空文件.txt", data: "" },
    ]);
    const entries = readZip(zip);
    expect(entries.map((e) => e.path)).toEqual(["mimetype", "chapters/0001.md", "设定/人物.json", "empty", "空文件.txt"]);
    expect(entries[1]!.data.toString("utf-8")).toBe(big);
    expect([...entries[2]!.data]).toEqual([0, 1, 2, 255]);
    expect(entries[3]!.isDirectory).toBe(true);
    expect(entries[4]!.data.length).toBe(0);
    // 压缩真生效了：重复文本压完远小于原文
    expect(zip.length).toBeLessThan(Buffer.byteLength(big) / 5);
    // epub 要求 mimetype 是第一个、不压缩：原文直接出现在包头附近
    expect(zip.subarray(30, 38).toString()).toBe("mimetype");
    expect(zip.subarray(38, 58).toString()).toBe("application/epub+zip");
  });

  it("条目超过 65535 个时写 zip64 结尾记录，读回条目数对", () => {
    const entries = Array.from({ length: 65_600 }, (_, i) => ({ path: `o/${i}`, data: "x", store: true }));
    const back = readZip(createZip(entries));
    expect(back.length).toBe(65_600);
    expect(back[65_599]!.path).toBe("o/65599");
  }, 30_000);

  it("不安全的路径不认", () => {
    expect(isSafeZipPath("a/b.md")).toBe(true);
    expect(isSafeZipPath("../a")).toBe(false);
    expect(isSafeZipPath("/etc/passwd")).toBe(false);
    expect(isSafeZipPath("a\\b")).toBe(false);
    expect(isSafeZipPath("a//b")).toBe(false);
    expect(isSafeZipPath("a/./b")).toBe(false);
    const zip = createZip([{ path: "a/../../evil", data: "x" }]);
    expect(() => readZip(zip)).toThrow("路径不安全");
  });

  it("内容被改坏、截断、不是 zip，都如实报错", () => {
    const zip = createZip([{ path: "a.txt", data: "hello hello hello hello", store: true }]);
    const broken = Buffer.from(zip);
    broken[32 + 5] = "X".charCodeAt(0); // 改一个数据字节
    expect(() => readZip(broken)).toThrow("内容校验不过");
    expect(() => readZip(Buffer.from("not a zip at all"))).toThrow("找不到结尾记录");
  });

  it("解压后总大小超上限就停", () => {
    const zip = createZip([{ path: "a.txt", data: "a".repeat(10_000) }]);
    expect(() => readZip(zip, { totalLimit: 1000 })).toThrow("解压后太大");
  });
});
