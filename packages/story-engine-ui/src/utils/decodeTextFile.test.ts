import { describe, expect, it } from "vitest";
import { decodeTextBytes } from "./decodeTextFile.js";

describe("导入文件解码", () => {
  it("UTF-8（有没有 BOM 都行）", () => {
    const bytes = new TextEncoder().encode("第一章 雨夜");
    expect(decodeTextBytes(bytes)).toBe("第一章 雨夜");
    expect(decodeTextBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes]))).toBe("第一章 雨夜");
  });

  it("UTF-16 认 BOM", () => {
    const le = new Uint8Array([0xff, 0xfe, 0x2c, 0x7b, 0x00, 0x4e]); // 「第一」
    expect(decodeTextBytes(le)).toBe("第一");
  });

  it("UTF-8 解不通就按 GB18030（老平台导出的 GBK 文件）", () => {
    const gbk = new Uint8Array([0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2]); // GBK「第一章」
    expect(decodeTextBytes(gbk)).toBe("第一章");
  });
});
