// @vitest-environment node
/**
 * local-path-scrubber（铁律④·本地绝对路径绝不进用户可见文案）：
 * 前半钉消毒口径（errno/git 报错内嵌路径的真实形态）；后半防复发——静态断言该正则
 * 全仓唯一来源（历史上同一正则曾在 commit-apply/prune-snapshots/commit-service 复制三份，
 * 口径漂移与漏改都由此而来），第四份复制直接红灯。
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { scrubLocalAbsolutePaths } from "./local-path-scrubber.js";

describe("local-path-scrubber 消毒口径", () => {
  it("errno 原文内嵌的绝对路径（含引号包裹）洗成占位", () => {
    expect(scrubLocalAbsolutePaths("EACCES: permission denied, open '/Users/guo/book/chapters/0001.md'"))
      .toBe("EACCES: permission denied, open (本地路径)");
  });

  it("常见根各就各位：/Users /home /var /tmp /private，无引号裸路径也洗", () => {
    expect(scrubLocalAbsolutePaths("写入 /Users/guo/book/a.md 失败")).toBe("写入 (本地路径) 失败");
    expect(scrubLocalAbsolutePaths("写入 /home/guo/book/a.md 失败")).toBe("写入 (本地路径) 失败");
    expect(scrubLocalAbsolutePaths("写入 /var/folders/xx/T/b.md 失败")).toBe("写入 (本地路径) 失败");
    expect(scrubLocalAbsolutePaths("写入 /tmp/story-engine-test/c.md 失败")).toBe("写入 (本地路径) 失败");
    expect(scrubLocalAbsolutePaths("写入 /private/tmp/d.md 失败")).toBe("写入 (本地路径) 失败");
  });

  it("git 子进程报错形态（-C 仓库路径）与同句多路径都洗净", () => {
    const text = "fatal: cannot chdir to '/Users/guo/book'；回滚备份见 /var/backups/snapshot.bundle，原稿在 '/Users/guo/book/chapters/0001.md'";
    const out = scrubLocalAbsolutePaths(text);
    // 口径钉死：引号包裹路径止步于闭引号；裸路径的 [^'"\s]* 会顺带吃掉紧随的全角逗号（既有行为，照实钉住）。
    expect(out).toBe("fatal: cannot chdir to (本地路径)；回滚备份见 (本地路径) (本地路径)");
    expect(out).not.toContain("/Users/");
    expect(out).not.toContain("/var/");
  });

  it("普通中文文案、相对路径、无斜杠根名不误伤", () => {
    expect(scrubLocalAbsolutePaths("第 3 章入库计划缺少时间线锚点")).toBe("第 3 章入库计划缺少时间线锚点");
    expect(scrubLocalAbsolutePaths("回执文件 .story-engine-ui/commit-idempotency/r.json 是唯一证据"))
      .toBe("回执文件 .story-engine-ui/commit-idempotency/r.json 是唯一证据");
    expect(scrubLocalAbsolutePaths("tmp 目录空间不足")).toBe("tmp 目录空间不足");
  });
});

describe("local-path-scrubber 防复发（正则全仓唯一来源）", () => {
  const SRC_ROOT = fileURLToPath(new URL("../..", import.meta.url)); // packages/story-engine-ui/src
  const PATTERN_NEEDLE = "(?:Users|home|var|tmp|private)";

  async function collectSourceFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...await collectSourceFiles(path));
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        files.push(path);
      }
    }
    return files;
  }

  it("src 下非测试源码不得再出现第四份路径消毒正则复制", async () => {
    const offenders: string[] = [];
    for (const file of await collectSourceFiles(SRC_ROOT)) {
      if (file.endsWith("local-path-scrubber.ts")) continue; // 唯一合法来源
      if ((await readFile(file, "utf-8")).includes(PATTERN_NEEDLE)) {
        offenders.push(relative(SRC_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
