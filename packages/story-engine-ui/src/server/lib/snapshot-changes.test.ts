import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { attachSnapshotChanges, buildRestoreReceipt, describeRevertedPaths, describeSnapshotChanges } from "./snapshot-changes.js";
import { readCommitFileChanges } from "./snapshot.js";

const run = promisify(execFile);
const names = new Map([["char-ffe5af", "周屿"], ["char-c6008d", "阿琴"]]);
const m = (path: string) => ({ status: "M", path });
const a = (path: string) => ({ status: "A", path });
const d = (path: string) => ({ status: "D", path });

describe("操作历史「查看改动」：文件 → 人话", () => {
  it("定稿：正文写入 + 角色/线索/时间线等资料，内部文件不列", () => {
    const lines = describeSnapshotChanges([
      a(".story-engine-tx/commit-chapter-0058/chapters/0058.md"),
      a("chapters/0058.md"),
      m("characters/char-ffe5af/state.json"),
      a("diagnostics/commit-chapter-0058.json"),
      m("story/threads.json"),
      m("timeline/events.json"),
      m("story/fact-ledger.json"),
      m(".story-engine-ui/chapter-workspaces/chapter-0058.json"),
    ], names);
    expect(lines).toEqual([
      "正文：第 58 章写入定稿",
      "角色：周屿 的资料有更新",
      "伏笔与线索有更新",
      "时间线有更新",
      "硬事实账本有更新",
    ]);
  });

  it("新建角色报名字、不重复报角色册；认不出的角色不吐 id", () => {
    expect(describeSnapshotChanges([
      a("characters/char-c6008d/core.json"),
      a("characters/char-c6008d/profile.json"),
      m("story/character-bible.json"),
    ], names)).toEqual(["新增角色：阿琴"]);
    const unknown = describeSnapshotChanges([m("characters/char-999999/state.json")], names);
    expect(unknown).toEqual(["角色资料有更新"]);
    expect(unknown.join("")).not.toMatch(/char-/u);
  });

  it("工作稿多章合并成一行；只有内部文件时没有改动可列", () => {
    expect(describeSnapshotChanges([m("drafts/fast/chapter-0057.md"), m("drafts/fast/chapter-0056.md")], names))
      .toEqual(["工作稿：第 56、57 章有改动"]);
    expect(describeSnapshotChanges([m(".story-engine-ui/chapter-workspaces/chapter-0056.json")], names)).toEqual([]);
  });

  it("配给存档点的是它之后那个提交的改动；恢复结果用自己的；没有改动的不带 changes", () => {
    const entries = [
      { id: "s2", timestamp: 4, label: "落盘收尾：agent:commit_apply" },
      { id: "c2", timestamp: 3, label: "agent:commit_apply" },
      { id: "r1", timestamp: 2, label: "恢复到：agent:commit_apply" },
      { id: "p1", timestamp: 1, label: "恢复前自动快照" },
    ];
    const files = new Map([
      ["s2", [a("chapters/0058.md")]],
      ["c2", [m("drafts/fast/chapter-0058.md")]],
      ["r1", [m("story/threads.json")]],
      ["p1", [m("drafts/fast/chapter-0057.md")]],
    ]);
    const out = attachSnapshotChanges(entries, files, names);
    expect(out.find((e) => e.id === "c2")?.changes).toEqual(["正文：第 58 章写入定稿"]);
    expect(out.find((e) => e.id === "r1")?.changes).toEqual(["伏笔与线索有更新"]);
    expect(out.find((e) => e.id === "p1")?.changes).toBeUndefined();
  });

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
    expect(humanizeHistoryLabel("第57章自动去AI味前快照")).toBe("自动去 AI 味：第57章");
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

describe("撤销/恢复回执：路径 → 人话（R4.2·验收 3.2）", () => {
  it("chapters/、drafts/fast/、characters/、story/*.json 四类都翻成短语，认不出的角色不吐 id", () => {
    expect(describeRevertedPaths([
      a("chapters/0004.md"),
      a("drafts/fast/chapter-0005.md"),
      m("characters/char-ffe5af/core.json"),
      m("characters/char-ffe5af/state.json"),
      m("story/fact-ledger.json"),
      m("story/threads.json"),
    ], names)).toEqual(["第 4 章定稿", "第 5 章工作稿", "角色卡：周屿", "线索", "账本"]);
    // 认不出 id 的角色：中性短语，绝不把 char- 吐给作者（铁律④）。
    const unknown = describeRevertedPaths([m("characters/char-999999/state.json")], names);
    expect(unknown).toEqual(["角色卡资料"]);
    expect(unknown.join("")).not.toMatch(/char-/u);
  });

  it("角色多于 3 张合并；同章多文件去重；D 状态（恢复找回来的）加标注", () => {
    const many = describeRevertedPaths([
      a("characters/char-ffe5af/core.json"),
      a("characters/char-c6008d/core.json"),
      m("story/character-bible.json"),
    ], names);
    expect(many).toEqual(["角色卡：周屿、阿琴"]);
    const dedup = describeRevertedPaths([
      m("drafts/fast/chapter-0007.md"),
      a("drafts/fast/chapter-0007.md"),
      d("chapters/0003.md"),
    ], names);
    expect(dedup).toEqual(["第 3 章定稿（重新找回）", "第 7 章工作稿"]);
  });

  it("资料区其余路径各有短语；认不出的折成「其他文件 N 个」；超 8 项折成「等 N 项」", () => {
    expect(describeRevertedPaths([
      m("story/character-matrix.json"),
      m("timeline/events.json"),
      m("story/arc-goals.json"),
      m("world/state.json"),
      m("story/location-bible.json"),
      m("story/assets.json"),
      m("story/writing-rules.json"),
      m("time/calendar.json"),
    ], names)).toEqual([
      "角色关系", "时间线", "主线目标", "世界状态", "地点设定", "道具与资源", "写作规则", "故事日历",
    ]);
    expect(describeRevertedPaths([m("diagnostics/whatever.json")], names)).toEqual(["其他文件 1 个"]);
    const overflow = describeRevertedPaths(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => m(`drafts/fast/chapter-${String(n).padStart(4, "0")}.md`)),
      names,
    );
    expect(overflow.at(-1)).toBe("等 10 项");
    expect(overflow.length).toBe(8);
  });
});

describe("撤销/恢复回执全文：buildRestoreReceipt", () => {
  const empty: never[] = [];

  it("只撤这一步：列出退回清单 + 找回办法，不说「只撤了这一步」这种空话", () => {
    const text = buildRestoreReceipt({
      title: "已撤销上一步（出稿：第5章）。",
      reverted: [a("drafts/fast/chapter-0005.md")],
      revertedLater: empty,
      nameById: names,
    });
    expect(text).toBe("已撤销上一步（出稿：第5章）。这次退回：第 5 章工作稿。要找回，去「历史」页点「恢复前的自动存档」。");
  });

  it("连带退回「这步之后写的」单独一句说清；主清单只列这一步本身的", () => {
    const text = buildRestoreReceipt({
      title: "已恢复到「更新故事资料：改名 主角→陆沉」之前。",
      reverted: [
        m("characters/char-ffe5af/core.json"),
        a("drafts/fast/chapter-0005.md"),
      ],
      revertedLater: [a("drafts/fast/chapter-0005.md")],
      nameById: names,
    });
    expect(text).toBe(
      "已恢复到「更新故事资料：改名 主角→陆沉」之前。这次退回：角色卡：周屿。" +
      "这步之后写的第 5 章工作稿也一并退回了。要找回，去「历史」页点「恢复前的自动存档」。",
    );
  });

  it("没有文件差异时如实说没有文件被退回，仍指明找回入口", () => {
    const text = buildRestoreReceipt({ title: "已撤销上一步（出稿：第5章）。", reverted: empty, revertedLater: empty, nameById: names });
    expect(text).toBe("已撤销上一步（出稿：第5章）。这次没有文件被退回。要找回，去「历史」页点「恢复前的自动存档」。");
  });
});
