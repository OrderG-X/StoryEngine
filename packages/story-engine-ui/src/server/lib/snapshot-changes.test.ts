import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { readCommitFileChanges } from "./snapshot.js";

const run = promisify(execFile);
const m = (path: string) => ({ status: "M", path });
const a = (path: string) => ({ status: "A", path });

describe("readCommitFileChanges", () => {
  it("readCommitFileChanges：按提交拿到新增/修改状态", async () => {
    const dir = await mkdtemp(join(tmpdir(), "snap-changes-"));
    const git = (...args: string[]) => run("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
    await git("init", "-q");
    await mkdir(join(dir, "story"), { recursive: true });
    await writeFile(join(dir, "story", "threads.json"), "[]");
    await git("add", "-A");
    await git("commit", "-q", "-m", "初始");
    await mkdir(join(dir, "chapters"), { recursive: true });
    await writeFile(join(dir, "chapters", "0001.md"), "正文");
    await writeFile(join(dir, "story", "threads.json"), "[1]");
    await git("add", "-A");
    await git("commit", "-q", "-m", "落盘收尾：agent:commit_apply");
    const changes = [...(await readCommitFileChanges(dir)).values()];
    expect(changes[0]).toEqual([a("chapters/0001.md"), m("story/threads.json")]);
    expect(changes[1]).toEqual([a("story/threads.json")]);
  });
});


describe("操作历史条目名", () => {
  it("「X前快照」改成操作名、章号放后；恢复条目说清回到哪一步之前", async () => {
    const { humanizeHistoryLabel } = await import("./snapshot-changes.js");
    expect(humanizeHistoryLabel("第57章自动去AI味前快照")).toBe("自动去机器腔：第57章");
    expect(humanizeHistoryLabel("第55章修订前快照")).toBe("修订：第55章");
    expect(humanizeHistoryLabel("定稿前快照：第12章")).toBe("定稿：第12章");
    expect(humanizeHistoryLabel("抽卡选用候选前快照：第3章")).toBe("选用候选稿：第3章");
    expect(humanizeHistoryLabel("写作规则修改前快照")).toBe("写作规则修改");
    expect(humanizeHistoryLabel("agent:commit_apply:第58章")).toBe("定稿：第58章");
    expect(humanizeHistoryLabel("恢复到：第55章再次出稿前快照")).toBe("恢复到「再次出稿：第55章」之前");
    expect(humanizeHistoryLabel("恢复到：agent:commit_apply")).toBe("恢复到「定稿」之前");
    expect(humanizeHistoryLabel("恢复前自动快照")).toBe("恢复前的自动存档");
    expect(humanizeHistoryLabel("初始快照")).toBe("建书时的初始状态");
  });
});
