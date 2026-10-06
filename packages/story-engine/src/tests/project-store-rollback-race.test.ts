import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";

// 建书回滚竞态：首个 mkdir 失败时，兄弟 mkdir 若还在飞，回滚的 rm 必须等它们落定，
// 否则慢一拍的 mkdir 会在 rm 之后把半截项目目录重新建出来（全量并发跑时 rollback 用例偶发红）。
// 这里把 world 目录的 mkdir 人为拖慢，让竞态确定性出现。
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      if (String(args[0]).endsWith(`${sep}world`)) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return actual.mkdir(...args);
    },
  };
});

const { createStoryProject } = await import("../project-store.js");

describe("createStoryProject 回滚", () => {
  it("首个 mkdir 失败时等兄弟 mkdir 落定再回滚，不留半截目录", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "story-engine-ng-rollback-race-"));
    await expect(createStoryProject({
      rootDir,
      title: "rollback race",
      genre: "urban",
      premise: "主角目录名超长，mkdir 必败。",
      mainCharacterName: "a".repeat(300),
    })).rejects.toThrow();

    // 等拖慢的 mkdir 落地：修复前它会在回滚 rm 之后重新建出目录。
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(access(join(rootDir, "story-engine", "rollback-race"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
