// @vitest-environment node
// 稿纸只经 draftSync 换（openPaper / replacePaperNow / clearPaperNow）：换之前把没存的字存完，存不上不换。
// 别处直接调 store 的 loadPaper / reset 会绕过这道门，等待期间打的字就丢了（第 5 轮复核 S1/S6/S7）。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const SRC = dirname(dirname(fileURLToPath(import.meta.url)));
const ALLOWED = new Set(["drafts/draftSync.ts", "stores/draftStore.ts"]);

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "server" || name === "node_modules") continue;
      files.push(...sourceFiles(path));
    } else if (/\.(ts|tsx)$/u.test(name) && !/\.test\.(ts|tsx)$/u.test(name)) {
      files.push(path);
    }
  }
  return files;
}

it("前端只有 draftSync 换稿纸", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const rel = relative(SRC, file).split("\\").join("/");
    if (ALLOWED.has(rel)) continue;
    const text = readFileSync(file, "utf8");
    if (/\.loadPaper\(|useDraftStore\.getState\(\)\.reset\(|\.receivePaper\(/u.test(text)) offenders.push(rel);
  }
  expect(offenders).toEqual([]);
});
