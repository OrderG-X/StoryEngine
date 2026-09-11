// @vitest-environment node
//
// snapshotBeforeDraftOverwrite（M6）：覆盖现有非空草稿前建快照、首次出稿不建。用临时项目 + 真实 git 快照验。
import { lstat, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createStoryProject } from "@actalk/story-engine";
import { describe, expect, it } from "vitest";

import { defaultDraftPath } from "../../lib/project-io.js";
import { listSnapshots } from "../../lib/snapshot.js";
import { snapshotBeforeDraftOverwrite } from "./snapshot-on-draft-overwrite.js";

async function makeProject(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "snapshot-draft-test-"));
  const { projectDir } = await createStoryProject({
    rootDir,
    title: "快照测试书",
    genre: "都市",
    premise: "主角进入权力中心。",
    mainCharacterName: "林远",
  });
  return projectDir;
}

async function writeDraft(projectDir: string, chapter: number, body: string): Promise<void> {
  const draftPath = defaultDraftPath(projectDir, chapter);
  await mkdir(dirname(draftPath), { recursive: true });
  await writeFile(draftPath, body, "utf-8");
}

describe("snapshotBeforeDraftOverwrite（M6 覆盖现有非空草稿前建快照）", () => {
  it("当前章无草稿 → 不建快照，返回 undefined（首次出稿无旧稿可丢）", async () => {
    const projectDir = await makeProject();
    const before = await listSnapshots(projectDir);
    const id = await snapshotBeforeDraftOverwrite(projectDir, 1, "第1章再次出稿前快照");
    expect(id).toBeUndefined();
    const after = await listSnapshots(projectDir);
    expect(after.length).toBe(before.length);
  });

  it("当前章有非空草稿 → 建快照，返回 40-hex snapshotId 且历史多一条", async () => {
    const projectDir = await makeProject();
    await writeDraft(projectDir, 2, "# 第二章\n\n这是已经写好的一版草稿正文。");
    const before = await listSnapshots(projectDir);
    const id = await snapshotBeforeDraftOverwrite(projectDir, 2, "第2章再次出稿前快照");
    expect(id).toMatch(/^[0-9a-f]{40}$/u);
    const after = await listSnapshots(projectDir);
    expect(after.length).toBe(before.length + 1);
    expect(after[0].label).toBe("第2章再次出稿前快照");
  });

  it("草稿只有 Markdown 章节标题、无正文 → 视为空，不建快照", async () => {
    const projectDir = await makeProject();
    await writeDraft(projectDir, 3, "# 第三章\n\n");
    const id = await snapshotBeforeDraftOverwrite(projectDir, 3, "第3章再次出稿前快照");
    expect(id).toBeUndefined();
  });

  // P2-5 fail-closed：旧稿存在但读不出绝不能当「无旧稿」跳过快照——否则紧接的覆盖写让旧稿从此无撤销点。
  it.skipIf(process.platform === "win32")("草稿存在但读失败（ELOOP 自指 symlink）→ 抛错中止，不建快照、不动旧稿", async () => {
    const projectDir = await makeProject();
    const draftPath = defaultDraftPath(projectDir, 4);
    await mkdir(dirname(draftPath), { recursive: true });
    await symlink(draftPath, draftPath); // 自指环：readFile 必 ELOOP，root 下也确定触发
    const before = await listSnapshots(projectDir);
    await expect(snapshotBeforeDraftOverwrite(projectDir, 4, "第4章再次出稿前快照"))
      .rejects.toThrow(/读取失败/u);
    expect((await listSnapshots(projectDir)).length).toBe(before.length); // 没建快照
    expect((await lstat(draftPath)).isSymbolicLink()).toBe(true); // 旧稿（ symlink 本体）分毫未动
  });
});
