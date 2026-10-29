// @vitest-environment node
// 界面服务端取真相依据只走 book/truth-basis.ts（第 7 轮复核 U3）：挂到产物上的依据，取的时候镜像必须正是这一版的。
// 别处直接调核心的 readTruthBasis / readWithStableBasis 会绕过镜像核对，照旧镜像读的材料挂上新依据。
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { cardWrite, chapterCommit, readHead, runCommand } from "@actalk/story-core";
import { createStoryProject } from "./project-store.js";
import { MIRROR_MARKER, readMirrorVersion, syncLegacyMirror } from "./mirror/sync.js";
import { readTruthBasisForWork, readWithStableBasisForWork } from "./truth-basis.js";

const SERVER = dirname(dirname(fileURLToPath(import.meta.url)));

async function sourceFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (/\.ts$/u.test(entry.name) && !/\.test\.ts$/u.test(entry.name)) files.push(path);
  }
  return files;
}

it("界面服务端只有 truth-basis.ts 直接调核心读依据", async () => {
  const offenders: string[] = [];
  for (const file of await sourceFiles(SERVER)) {
    const rel = relative(SERVER, file).split("\\").join("/");
    if (rel === "book/truth-basis.ts") continue;
    if (/\b(readTruthBasis|readWithStableBasis)\s*[(,}]/u.test(await readFile(file, "utf8"))) offenders.push(rel);
  }
  expect(offenders).toEqual([]);
});

let root: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function makeBook(): Promise<string> {
  root = await mkdtemp(join(process.env.STORY_ENGINE_TEST_RUN_ROOT!, "truth-basis-"));
  vi.stubEnv("SE_BOOKS_DIR", join(root, "books"));
  vi.stubEnv("SE_DATA_DIR", join(root, "data"));
  return (await createStoryProject({ rootDir: join(root, "books"), title: "依据", genre: "都市", protagonistName: "林远" })).projectDir;
}

const commit = async (book: string, text: string, key: string): Promise<void> => {
  expect(await runCommand(book, chapterCommit, { chapter: 1, text: `# 第一章\n\n${text}`, entries: [] }, { caller: "author", idempotencyKey: key })).toMatchObject({ ok: true });
};

it("新书还没有账单：不生成镜像（同开书），照常给依据", async () => {
  const book = await makeBook();
  expect((await readHead(book)).version).toBeGreaterThan(0);
  await readTruthBasisForWork(book);
  expect((await readWithStableBasisForWork(book, async () => 1)).basis).toBeDefined();
  await expect(stat(join(book, MIRROR_MARKER))).rejects.toMatchObject({ code: "ENOENT" });
});

it("改了设定卡（只涨版本号、不同步镜像）：开工时补上镜像再给依据", async () => {
  const book = await makeBook();
  await commit(book, "林远推门走了出去。", "c1");
  expect((await syncLegacyMirror(book)).ok).toBe(true);
  expect(await runCommand(book, cardWrite, { ops: [{ op: "story.set", label: "地点", value: "河岸" }] }, { caller: "author", idempotencyKey: "card" })).toMatchObject({ ok: true });
  const head = (await readHead(book)).version;
  expect(await readMirrorVersion(book)).not.toBe(head);
  await readTruthBasisForWork(book);
  expect(await readMirrorVersion(book)).toBe(head);
});
