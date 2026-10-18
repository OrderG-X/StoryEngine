import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { attachCommitChapterDetails, humanizeUndoLabel, readCommitChapterHints, snapshotKindOf } from "./snapshot.js";

const run = promisify(execFile);

describe("操作历史：老的「定稿」条目补章号", () => {
  it("attachCommitChapterDetails：靠紧邻的落盘收尾提交认章；认不出就保持原样", () => {
    const entries = [
      { id: "s2", timestamp: 3, label: "落盘收尾：agent:commit_apply" },
      { id: "c2", timestamp: 2, label: "agent:commit_apply" },
      { id: "c1", timestamp: 1, label: "agent:commit_apply" },
    ];
    const out = attachCommitChapterDetails(entries, new Map([["s2", 58]]));
    expect(out.map((e) => e.label)).toEqual(["落盘收尾：agent:commit_apply", "agent:commit_apply:第58章", "agent:commit_apply"]);
    expect(humanizeUndoLabel(out[1]!.label)).toBe("定稿：第58章");
  });

  it("readCommitChapterHints：只认项目根下 chapters/NNNN.md，不认事务归档里的副本", async () => {
    const dir = await mkdtemp(join(tmpdir(), "snap-hints-"));
    const git = (...args: string[]) => run("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
    await git("init", "-q");
    await mkdir(join(dir, "chapters"), { recursive: true });
    await mkdir(join(dir, ".story-engine-tx", "commit-chapter-0057", "chapters"), { recursive: true });
    await writeFile(join(dir, ".story-engine-tx", "commit-chapter-0057", "chapters", "0057.md"), "x");
    await git("add", "-A");
    await git("commit", "-q", "-m", "归档");
    await writeFile(join(dir, "chapters", "0058.md"), "正文");
    await git("add", "-A");
    await git("commit", "-q", "-m", "落盘收尾：agent:commit_apply");
    const hints = await readCommitChapterHints(dir);
    expect([...hints.values()]).toEqual([58]);
  });
});

describe("snapshotKindOf：操作历史分类按写入方工具名定（重构 P7 不猜）", () => {
  it("工具名查表，细节里的字眼不影响", () => {
    expect(snapshotKindOf("agent:commit_apply:第58章")).toBe("commit");
    expect(snapshotKindOf("agent:foundation_write:建角色 定稿人")).toBe("bible");
    expect(snapshotKindOf("agent:manage_ledger")).toBe("bible");
    expect(snapshotKindOf("agent:revise_draft:改角色那段")).toBe("draft");
    expect(snapshotKindOf("恢复到：agent:commit_apply")).toBe("restore");
    expect(snapshotKindOf("恢复前自动快照")).toBe("restore");
    expect(snapshotKindOf("第55章修订前快照")).toBe("draft");
  });
});
