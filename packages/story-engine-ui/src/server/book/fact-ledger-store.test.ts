// @vitest-environment node
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readFactLedger } from "./project-store.js";

async function projectWithLedger(facts: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fact-ledger-store-"));
  await mkdir(join(dir, "story"), { recursive: true });
  await writeFile(join(dir, "story", "fact-ledger.json"), JSON.stringify({ version: "v0", facts }, null, 2), "utf-8");
  return dir;
}

describe("readFactLedger", () => {
  it("读出账本（纯 JSON，不剥字段）", async () => {
    const dir = await projectWithLedger([{ id: "fact-7-0", chapter: 7, text: "放映收3块、私下", source: "auto" }]);
    const ledger = await readFactLedger(dir);
    expect(ledger?.facts[0]).toMatchObject({ chapter: 7, text: "放映收3块、私下", source: "auto" });
  });
  it("缺文件 → null（不抛）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "no-ledger-"));
    expect(await readFactLedger(dir)).toBeNull();
  });
});
