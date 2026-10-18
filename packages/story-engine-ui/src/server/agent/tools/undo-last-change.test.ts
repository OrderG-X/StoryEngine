// @vitest-environment node
//
// undo_last_change 工具回执（R4.2·验收 3.2）：真撤销 + 回执写清实际退回了什么、去哪找回。
// 旧回执「只撤了这一步」给了模型编「第 5 章草稿没受影响」的空间——回执必须列清单。
// 用临时项目 + 真实 git 快照验（不打网络；overview 构建失败按工具实现降级为 undefined）。
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { createSnapshot, runWithSnapshot } from "../../lib/snapshot.js";
import { buildProjectRequestContext } from "../request-context.js";
import { undoLastChangeTool } from "./undo-last-change.js";

type Exec = (input: Record<string, never>, context: unknown) => Promise<{ ok: boolean; undone: boolean; summary: string }>;
const execute = undoLastChangeTool.execute as unknown as Exec;

async function makeProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "se-undo-tool-test-"));
  await mkdir(join(dir, "story"), { recursive: true });
  await mkdir(join(dir, "characters", "char-protag"), { recursive: true });
  await writeFile(join(dir, "project.json"), JSON.stringify({ title: "撤销回执测试书" }), "utf-8");
  await writeFile(join(dir, "story", "threads.json"), JSON.stringify({ threads: [] }), "utf-8");
  await writeFile(join(dir, "characters", "char-protag", "core.json"), JSON.stringify({ id: "char-protag", name: "主角" }), "utf-8");
  return dir;
}

async function undo(projectDir: string, lastTurnUndoHint?: { snapshotId: string; changes: number }) {
  return execute({}, {
    requestContext: buildProjectRequestContext(projectDir, undefined, undefined, undefined, lastTurnUndoHint),
  });
}

describe("undo_last_change 回执写清退回了什么（R4.2）", () => {
  it("首稿后撤销：回执点名第 5 章工作稿 + 找回办法，不说「只撤了这一步」", async () => {
    const projectDir = await makeProject();
    await runWithSnapshot(projectDir, "agent:foundation_write:改名 主角→陆沉", async () => {
      await writeFile(join(projectDir, "characters", "char-protag", "core.json"), JSON.stringify({ id: "char-protag", name: "陆沉" }), "utf-8");
    });
    await createSnapshot(projectDir, "出稿：第5章");
    await mkdir(join(projectDir, "drafts", "fast"), { recursive: true });
    await writeFile(join(projectDir, "drafts", "fast", "chapter-0005.md"), "# 第 5 章\n\n阿禾拆了信。", "utf-8");

    const out = await undo(projectDir);
    expect(out.ok).toBe(true);
    expect(out.undone).toBe(true);
    expect(out.summary).toContain("已撤销上一步（出稿：第5章）");
    expect(out.summary).toContain("第 5 章工作稿");
    expect(out.summary).toContain("要找回，去「历史」页点「恢复前的自动存档」");
    expect(out.summary).not.toContain("只撤了这一步");
    expect(out.summary).not.toContain("也一并退回"); // 只撤这一步，没有连带
    await expect(access(join(projectDir, "drafts", "fast", "chapter-0005.md"))).rejects.toThrow();
    expect(JSON.parse(await readFile(join(projectDir, "characters", "char-protag", "core.json"), "utf-8")).name).toBe("陆沉");
  }, 30_000);

  it("再撤一次撤的是改名，回执换成角色卡（认不出 id 用中性说法，不吐 char-）", async () => {
    const projectDir = await makeProject();
    await runWithSnapshot(projectDir, "agent:foundation_write:改名 主角→陆沉", async () => {
      await writeFile(join(projectDir, "characters", "char-protag", "core.json"), JSON.stringify({ id: "char-protag", name: "陆沉" }), "utf-8");
    });
    await createSnapshot(projectDir, "出稿：第5章");
    await mkdir(join(projectDir, "drafts", "fast"), { recursive: true });
    await writeFile(join(projectDir, "drafts", "fast", "chapter-0005.md"), "# 第 5 章\n\n阿禾拆了信。", "utf-8");
    await undo(projectDir); // 撤首稿

    const second = await undo(projectDir); // 撤改名
    expect(second.undone).toBe(true);
    expect(second.summary).toContain("改设定本：改名 主角→陆沉");
    expect(second.summary).toContain("角色卡资料"); // 该临时项目没有角色名册可解析 → 中性说法
    expect(second.summary).not.toMatch(/char-protag/u); // 铁律④：绝不吐裸 id
    expect(JSON.parse(await readFile(join(projectDir, "characters", "char-protag", "core.json"), "utf-8")).name).toBe("主角");
  }, 30_000);

  it("没有可撤销的改动 → undone:false 如实说", async () => {
    const projectDir = await makeProject();
    await createSnapshot(projectDir, "agent:foundation_write");
    const out = await undo(projectDir);
    expect(out.ok).toBe(true);
    expect(out.undone).toBe(false);
    expect(out.summary).toContain("没有可撤销的改动");
  }, 30_000);
});

// R7.2（十章验收 3.2）：作者说「撤销上一步」指上一回合的全部改动。前端带「上一回合首个快照」时
// 优先整回合回退（一回合改两处也全撤）；带不了/锚点失效时按原逻辑撤最后一个工具步，回执说清
// 「上一回合改了 N 处，这次只退回了最后 1 处」。
describe("undo_last_change 整回合撤销（R7.2）", () => {
  /** 一回合写两处：两个写盘工具（各自 runWithSnapshot 建存档点），返回首个存档点 id。 */
  async function writeTwoChangesInOneTurn(projectDir: string): Promise<string> {
    const first = await runWithSnapshot(projectDir, "agent:revise_draft:第3章一处", async () => {
      await mkdir(join(projectDir, "drafts", "fast"), { recursive: true });
      await writeFile(join(projectDir, "drafts", "fast", "chapter-0003.md"), "# 第 3 章\n\n第一处改动。", "utf-8");
    });
    await runWithSnapshot(projectDir, "agent:foundation_write:给主角加疤", async () => {
      await writeFile(
        join(projectDir, "characters", "char-protag", "core.json"),
        JSON.stringify({ id: "char-protag", name: "主角", scar: "左手背有一道疤" }),
        "utf-8",
      );
    });
    return first.snapshot.id;
  }

  it("带整回合锚点（changes=2）：两处都回到改前，回执说「上一回合全部改动」", async () => {
    const projectDir = await makeProject();
    const turnFirstSnapshotId = await writeTwoChangesInOneTurn(projectDir);

    const out = await undo(projectDir, { snapshotId: turnFirstSnapshotId, changes: 2 });
    expect(out.ok).toBe(true);
    expect(out.undone).toBe(true);
    expect(out.summary).toContain("已撤销上一步（上一回合全部改动）");
    // 两处都退回：草稿没了（改前不存在），角色卡回到没有疤的原版。
    await expect(access(join(projectDir, "drafts", "fast", "chapter-0003.md"))).rejects.toThrow();
    expect(JSON.parse(await readFile(join(projectDir, "characters", "char-protag", "core.json"), "utf-8")).scar).toBeUndefined();
    // 不再出现「只撤了最后 1 处」的补充说明（整回合撤成了）。
    expect(out.summary).not.toContain("只退回了最后 1 处");
  }, 30_000);

  it("锚点失效（快照不在回看窗口）→ 撤默认最后一步，回执明说「上一回合共改了 2 处，这次只退回了最后 1 处」", async () => {
    const projectDir = await makeProject();
    await writeTwoChangesInOneTurn(projectDir);
    const ghostId = "0".repeat(40); // 形状合法但不存在（等效被裁剪的陈旧锚点）

    const out = await undo(projectDir, { snapshotId: ghostId, changes: 2 });
    expect(out.undone).toBe(true);
    expect(out.summary).toContain("上一回合共改了 2 处，这次只退回了最后 1 处");
    // 只撤了最后一步（角色卡加疤），前一处（草稿）还在。
    expect(JSON.parse(await readFile(join(projectDir, "characters", "char-protag", "core.json"), "utf-8")).scar).toBeUndefined();
    await expect(access(join(projectDir, "drafts", "fast", "chapter-0003.md"))).resolves.toBeUndefined();
  }, 30_000);

  it("不带锚点（老客户端）：行为不变，回执不提「N 处」", async () => {
    const projectDir = await makeProject();
    await writeTwoChangesInOneTurn(projectDir);

    const out = await undo(projectDir);
    expect(out.undone).toBe(true);
    expect(out.summary).toContain("改设定本：给主角加疤");
    expect(out.summary).not.toContain("只退回了最后 1 处");
  }, 30_000);

  it("整回合撤成后再说一次撤销：锚点已与工作树一致 → 落回默认逐步回退，不 no-op 也不重复整回合撤", async () => {
    const projectDir = await makeProject();
    // 回合之前还有更早的一步真改动（连续撤销要有东西可接着退）。
    await runWithSnapshot(projectDir, "agent:commit_apply:第1章", async () => {
      await writeFile(join(projectDir, "story", "threads.json"), JSON.stringify({ threads: [{ id: "thread-1", title: "停钟" }] }), "utf-8");
    });
    const turnFirstSnapshotId = await writeTwoChangesInOneTurn(projectDir);

    const first = await undo(projectDir, { snapshotId: turnFirstSnapshotId, changes: 2 });
    expect(first.undone).toBe(true);
    expect(first.summary).toContain("上一回合全部改动");

    // 第二次撤销带同一锚点：工作树已在锚点状态（无差异）→ 不重复整回合恢复，按默认逐步回退
    // 撤到回合之前的那一步。绝不能卡死或把「没撤成」谎报成撤了。
    const second = await undo(projectDir, { snapshotId: turnFirstSnapshotId, changes: 2 });
    expect(second.undone).toBe(true);
    expect(second.summary).toContain("定稿");
    expect(second.summary).not.toContain("上一回合全部改动");
    // 逐步回退撤掉了回合前那步：threads.json 回到空表。
    expect(JSON.parse(await readFile(join(projectDir, "story", "threads.json"), "utf-8")).threads).toHaveLength(0);
  }, 30_000);
});
