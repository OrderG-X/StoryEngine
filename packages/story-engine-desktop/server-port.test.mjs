// node --test server-port.test.mjs（纯 node:test，无 electron）
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readStoredPort, writeFileAtomically, writeStoredPortAtomically } from "./server-port.mjs";

test("readStoredPort：合法整数端口读回；半截/非法 JSON → null（回退随机端口而不是崩）", () => {
  assert.equal(readStoredPort('{"port":5180}\n'), 5180);
  assert.equal(readStoredPort('{"por'), null);
  assert.equal(readStoredPort('{"port":80}'), null);
  assert.equal(readStoredPort('{"port":"5180"}'), null);
  assert.equal(readStoredPort(""), null);
});

test("writeStoredPortAtomically：tmp + rename 就位，目录里不残留临时文件，内容可被 readStoredPort 读回", async () => {
  const dir = await mkdtemp(join(tmpdir(), "se-desktop-port-"));
  try {
    const target = join(dir, "server-port.json");
    await writeFile(target, '{"port":5180}\n', "utf-8"); // 旧值在位
    await writeStoredPortAtomically(target, 5181);
    assert.equal(readStoredPort(await readFile(target, "utf-8")), 5181);
    assert.deepEqual(await readdir(dir), ["server-port.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeFileAtomically：目标目录不存在 → 抛错且不留临时文件（调用方负责 mkdir）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "se-desktop-port-"));
  try {
    const target = join(dir, "missing", "server-port.json");
    await assert.rejects(writeFileAtomically(target, "x"));
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
