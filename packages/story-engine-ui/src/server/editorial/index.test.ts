// @vitest-environment node
// 后台补读本身（冻结范围、一章一步、去重、追新、续跑）的测试在 services/operations/recipes/background-backfill.test.ts。
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { CHECKER_ROLE, LEDGER_ROLE, PLANNER_ROLE } from "./index.js";
import { READER_WINDOW_MAX_CHARS, ensureReaderWindow, type BrainCallModel } from "./reader-window.js";

async function makeBook(chapters: number): Promise<string> {
  const dir = await makeHomeTempDir("brain-index-");
  await mkdir(join(dir, "chapters"), { recursive: true });
  for (let chapter = 1; chapter <= chapters; chapter += 1) {
    await writeFile(join(dir, "chapters", `${String(chapter).padStart(4, "0")}.md`), `# 第${chapter}章\n\n正文${chapter}。\n`, "utf-8");
  }
  return dir;
}

describe("长书窗口封顶（P7 两百章验收）", () => {
  it("三个跟读角色读到两百章，窗口都不超过预算（靠卷笔记；笔记按真书实测的一千三百字）", async () => {
    const dir = await makeBook(200);
    const callModel: BrainCallModel = async (messages) => {
      const volume = (messages[messages.length - 1]?.content ?? "").includes("缩写成卷笔记");
      return (volume ? "卷" : "记").repeat(volume ? 1400 : 1300);
    };
    for (const role of [CHECKER_ROLE, PLANNER_ROLE, LEDGER_ROLE]) {
      const out = await ensureReaderWindow({ projectDir: dir, role, upTo: 200, callModel });
      const size = out.messages.reduce((sum, message) => sum + message.content.length, 0);
      expect(size, role.id).toBeLessThanOrEqual(READER_WINDOW_MAX_CHARS);
      expect(out.volumesBuilt, role.id).toBeGreaterThan(0);
    }
  }, 60_000);
});
