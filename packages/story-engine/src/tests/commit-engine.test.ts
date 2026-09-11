import { createHash } from "node:crypto";
import { access, chmod, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  commitFastDraft,
  recoverProjectCommitTransactions,
  setCommitIoTestHookForTests,
  withProjectCommitLock,
} from "../commit-engine.js";
import {
  createStoryProject,
  readCharacterState,
  readHookPool,
  readStoryCalendar,
  readTimelineEvents,
  readWorldState,
} from "../project-store.js";

describe("StoryEngine-NG CommitEngine", () => {
  it.skipIf(process.platform === "win32")("serializes the same project through a symlink alias under one canonical lock", async () => {
    const projectDir = await createFixtureProject();
    const aliasDir = `${projectDir}-alias`;
    await symlink(projectDir, aliasDir);
    const entered: string[] = [];
    const firstEntered = deferred<void>();
    const releaseFirst = deferred<void>();
    const first = withProjectCommitLock(projectDir, async () => {
      entered.push("first");
      firstEntered.resolve(undefined);
      await releaseFirst.promise;
    });
    await firstEntered.promise;
    const second = withProjectCommitLock(aliasDir, async () => {
      entered.push("second");
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(entered).toEqual(["first"]);
    releaseFirst.resolve(undefined);
    await Promise.all([first, second]);
    expect(entered).toEqual(["first", "second"]);

    await writeDraft(projectDir, 17, "# 第十七章\n\n别名路径只能共锁或安全拒绝。\n");
    const aliasedCommit = await commitFastDraft({ projectDir: aliasDir, chapter: 17, commitPlan: {} });
    expect(aliasedCommit.passed).toBe(false);
    expect(aliasedCommit.issues.join(" ")).toMatch(/project root|symbolic|unsafe/iu);
    await expect(access(join(projectDir, "chapters", "0017.md"))).rejects.toThrow();
  });

  it("commits a fast draft and applies only explicit structured updates", async () => {
    const projectDir = await createFixtureProject();
    await writeDraft(projectDir, 1, "# 开局\n\nGuo Xu 推开大门，第一次看见矿藏账册上的缺口。\n");

    const report = await commitFastDraft({
      projectDir,
      chapter: 1,
      commitPlan: {
        characterUpdates: [
          {
            characterId: "Guo Xu / 主角",
            emotion: "alert",
            goal: "查清矿藏账册缺口",
          },
        ],
        timelineEvents: [
          {
            summary: "林远发现矿藏账册缺口，决定追查。",
            participants: ["guo-xu"],
            effects: {
              "guo-xu": {
                emotion: "alert",
              },
            },
          },
          {
            summary: "组织外院管事提到旧账被人动过。",
            participants: ["guo-xu"],
          },
        ],
        worldUpdates: {
          currentPhase: "investigation",
          activeConflicts: ["矿藏账册缺口", "矿藏账册缺口"],
          activeHooks: ["h-ledger", "h-ledger"],
          knownSecrets: ["旧账被人动过", "旧账被人动过"],
        },
        hookUpdates: [
          {
            hookId: "h-ledger",
            status: "active",
          },
        ],
        calendar: {
          storyDay: 2,
          timeOfDay: "morning",
        },
      },
    });

    expect(report).toEqual({
      chapter: 1,
      passed: true,
      chapterPath: join(projectDir, "chapters", "0001.md"),
      updatedCharacters: ["guo-xu"],
      timelineEventIds: ["ch0001-001", "ch0001-002"],
      updatedHooks: ["h-ledger"],
      updatedWorld: true,
      updatedCalendar: true,
      issues: [],
    });
    await expect(readFile(join(projectDir, "chapters", "0001.md"), "utf-8")).resolves.toBe(
      "# 开局\n\nGuo Xu 推开大门，第一次看见矿藏账册上的缺口。\n",
    );

    await expect(readCharacterState(projectDir, "guo-xu")).resolves.toMatchObject({
      emotion: "alert",
      goal: "查清矿藏账册缺口",
      relationshipToUser: "本人",
      currentArc: "开篇",
      lastUpdatedChapter: 1,
    });
    await expect(readTimelineEvents(projectDir)).resolves.toEqual([
      {
        id: "ch0001-001",
        chapter: 1,
        summary: "林远发现矿藏账册缺口，决定追查。",
        participants: ["guo-xu"],
        effects: {
          "guo-xu": {
            emotion: "alert",
          },
        },
      },
      {
        id: "ch0001-002",
        chapter: 1,
        summary: "组织外院管事提到旧账被人动过。",
        participants: ["guo-xu"],
      },
    ]);
    await expect(readWorldState(projectDir)).resolves.toMatchObject({
      currentPhase: "investigation",
      activeConflicts: ["旧冲突", "矿藏账册缺口"],
      activeHooks: ["h-existing", "h-ledger"],
      knownSecrets: ["旧秘密", "旧账被人动过"],
      lastUpdatedChapter: 1,
    });
    await expect(readHookPool(projectDir)).resolves.toEqual({
      hooks: [
        {
          id: "h-ledger",
          title: "矿藏账册缺口",
          description: "组织账册里少了一批矿藏。",
          status: "active",
          relatedCharacters: ["guo-xu"],
        },
      ],
    });
    await expect(readStoryCalendar(projectDir)).resolves.toEqual({
      currentStoryDay: 2,
      currentTimeOfDay: "morning",
    });
    await expect(readTransactionStatus(projectDir, 1)).resolves.toBe("applied");
  });

  it("uses an explicit draftPath when provided", async () => {
    const projectDir = await createFixtureProject();
    const customDraftPath = join(projectDir, "drafts", "fast", "custom.md");
    await writeFile(customDraftPath, "# 自定义草稿\n\nGuo Xu 收起账册。\n", "utf-8");

    const report = await commitFastDraft({
      projectDir,
      chapter: 2,
      draftPath: customDraftPath,
      commitPlan: {},
    });

    expect(report.passed).toBe(true);
    await expect(readFile(join(projectDir, "chapters", "0002.md"), "utf-8")).resolves.toBe(
      "# 自定义草稿\n\nGuo Xu 收起账册。\n",
    );
  });

  it("replaces same-chapter timeline events when a commit is replayed", async () => {
    const projectDir = await createFixtureProject();
    await writeDraft(projectDir, 2, "# 第二章\n\nGuo Xu 第一次提交。\n");
    await commitFastDraft({
      projectDir,
      chapter: 2,
      commitPlan: {
        timelineEvents: [
          { summary: "第一次摘要", participants: ["guo-xu"] },
          { summary: "旧的第二条摘要", participants: ["guo-xu"] },
        ],
      },
    });
    await writeDraft(projectDir, 3, "# 第三章\n\nGuo Xu 保留另一章事件。\n");
    await commitFastDraft({
      projectDir,
      chapter: 3,
      commitPlan: {
        timelineEvents: [{ summary: "第三章摘要", participants: ["guo-xu"] }],
      },
    });
    await writeDraft(projectDir, 2, "# 第二章\n\nGuo Xu 修正后重新提交。\n");

    const report = await commitFastDraft({
      projectDir,
      chapter: 2,
      commitPlan: {
        timelineEvents: [{ summary: "修正后摘要", participants: ["guo-xu"] }],
      },
    });

    expect(report.passed).toBe(true);
    const events = await readTimelineEvents(projectDir);
    expect(events.map((event) => event.id)).toEqual(["ch0003-001", "ch0002-001"]);
    expect(events.find((event) => event.id === "ch0002-002")).toBeUndefined();
    expect(events.find((event) => event.id === "ch0002-001")).toMatchObject({
      chapter: 2,
      summary: "修正后摘要",
      participants: ["guo-xu"],
    });
    expect(events.find((event) => event.id === "ch0003-001")).toMatchObject({
      chapter: 3,
      summary: "第三章摘要",
      participants: ["guo-xu"],
    });
  });

  it("fails without writing anything when the draft is missing", async () => {
    const projectDir = await createFixtureProject();

    const report = await commitFastDraft({
      projectDir,
      chapter: 3,
      commitPlan: {
        worldUpdates: {
          currentPhase: "should-not-write",
        },
      },
    });

    expect(report.passed).toBe(false);
    expect(report.issues.length).toBeGreaterThan(0);
    await expect(access(join(projectDir, "chapters", "0003.md"))).rejects.toThrow();
    await expect(readWorldState(projectDir)).resolves.toMatchObject({
      currentPhase: "opening",
      lastUpdatedChapter: null,
    });
  });

  it("rejects unknown hooks before mutating project state", async () => {
    const projectDir = await createFixtureProject();
    await writeDraft(projectDir, 4, "# 错误提交\n\nGuo Xu 发现了不存在的伏笔。\n");

    const report = await commitFastDraft({
      projectDir,
      chapter: 4,
      commitPlan: {
        hookUpdates: [
          {
            hookId: "missing-hook",
            status: "active",
          },
        ],
        characterUpdates: [
          {
            characterId: "guo-xu",
            emotion: "changed",
          },
        ],
      },
    });

    expect(report.passed).toBe(false);
    expect(report.issues).toEqual(expect.arrayContaining(["Hook not found: missing-hook"]));
    await expect(access(join(projectDir, "chapters", "0004.md"))).rejects.toThrow();
    await expect(readCharacterState(projectDir, "guo-xu")).resolves.toMatchObject({
      emotion: "平静",
      lastUpdatedChapter: null,
    });
  });

  it("repairs missing characterId when applying a character state update", async () => {
    const projectDir = await createFixtureProject();
    await writeFile(
      join(projectDir, "characters", "guo-xu", "state.json"),
      `${JSON.stringify({
        characterId: null,
        emotion: "平静",
        goal: "待确认",
        lastUpdatedChapter: null,
      }, null, 2)}\n`,
      "utf-8",
    );
    await writeDraft(projectDir, 8, "# 修复角色状态\n\nGuo Xu 决定重新确认自己的目标。\n");

    const report = await commitFastDraft({
      projectDir,
      chapter: 8,
      commitPlan: {
        characterUpdates: [{
          characterId: "Guo Xu / 主角",
          goal: "重新确认自己的目标",
        }],
      },
    });

    expect(report.passed).toBe(true);
    await expect(readCharacterState(projectDir, "guo-xu")).resolves.toMatchObject({
      characterId: "guo-xu",
      goal: "重新确认自己的目标",
      lastUpdatedChapter: 8,
    });
  });

  it("does not publish the formal chapter when CharacterState apply fails", async () => {
    const projectDir = await createFixtureProject();
    await writeDraft(projectDir, 5, "# 状态失败\n\nGuo Xu 准备提交，但状态文件不可写。\n");
    const statePath = join(projectDir, "characters", "guo-xu", "state.json");
    const originalState = await readFile(statePath, "utf-8");
    await chmod(statePath, 0o444);

    try {
      const report = await commitFastDraft({
        projectDir,
        chapter: 5,
        commitPlan: {
          characterUpdates: [
            {
              characterId: "guo-xu",
              emotion: "should-not-commit",
            },
          ],
        },
      });

      expect(report.passed).toBe(false);
      expect(report.issues.length).toBeGreaterThan(0);
      await expect(access(join(projectDir, "chapters", "0005.md"))).rejects.toThrow();
      await expect(readFile(statePath, "utf-8")).resolves.toBe(originalState);
      await expect(readFile(join(projectDir, "drafts", "fast", "chapter-0005.md"), "utf-8")).resolves.toContain(
        "状态失败",
      );
    } finally {
      await chmod(statePath, 0o644);
    }
  });

  it("rolls back CharacterState when Timeline apply fails", async () => {
    const projectDir = await createFixtureProject();
    await writeDraft(projectDir, 6, "# 时间线失败\n\nGuo Xu 记录线索，但时间线文件不可写。\n");
    const timelinePath = join(projectDir, "timeline", "events.json");
    const originalState = await readFile(join(projectDir, "characters", "guo-xu", "state.json"), "utf-8");
    await chmod(timelinePath, 0o444);

    try {
      const report = await commitFastDraft({
        projectDir,
        chapter: 6,
        commitPlan: {
          characterUpdates: [
            {
              characterId: "guo-xu",
              emotion: "should-roll-back",
            },
          ],
          timelineEvents: [
            {
              summary: "This should not persist.",
              participants: ["guo-xu"],
            },
          ],
        },
      });

      expect(report.passed).toBe(false);
      expect(report.issues.length).toBeGreaterThan(0);
      await expect(access(join(projectDir, "chapters", "0006.md"))).rejects.toThrow();
      await expect(readFile(join(projectDir, "characters", "guo-xu", "state.json"), "utf-8")).resolves.toBe(originalState);
      await expect(readTimelineEvents(projectDir)).resolves.toEqual([]);
      await expect(readFile(join(projectDir, "drafts", "fast", "chapter-0006.md"), "utf-8")).resolves.toContain(
        "时间线失败",
      );
    } finally {
      await chmod(timelinePath, 0o644);
    }
  });

  it("does not publish the formal chapter when WorldState apply fails", async () => {
    const projectDir = await createFixtureProject();
    await writeDraft(projectDir, 7, "# 世界状态失败\n\nGuo Xu 看见世界状态无法写入。\n");
    const worldStatePath = join(projectDir, "world", "state.json");
    await chmod(worldStatePath, 0o444);

    try {
      const report = await commitFastDraft({
        projectDir,
        chapter: 7,
        commitPlan: {
          timelineEvents: [
            {
              summary: "This timeline event should roll back.",
              participants: ["guo-xu"],
            },
          ],
          worldUpdates: {
            currentPhase: "should-not-commit",
          },
        },
      });

      expect(report.passed).toBe(false);
      expect(report.issues.length).toBeGreaterThan(0);
      await expect(access(join(projectDir, "chapters", "0007.md"))).rejects.toThrow();
      await expect(readTimelineEvents(projectDir)).resolves.toEqual([]);
      await expect(readWorldState(projectDir)).resolves.toMatchObject({
        currentPhase: "opening",
        lastUpdatedChapter: null,
      });
      await expect(readFile(join(projectDir, "drafts", "fast", "chapter-0007.md"), "utf-8")).resolves.toContain(
        "世界状态失败",
      );
    } finally {
      await chmod(worldStatePath, 0o644);
    }
  });

  it("keeps a successful commit truthful when diagnostics persistence fails", async () => {
    const projectDir = await createFixtureProject();
    await writeDraft(projectDir, 9, "# 诊断失败不翻盘\n\nGuo Xu 完成了真正的章节定稿。\n");
    const diagnosticsPath = join(projectDir, "diagnostics");
    await rm(diagnosticsPath, { recursive: true, force: true });
    await writeFile(diagnosticsPath, "this path intentionally blocks a diagnostics directory", "utf-8");

    const report = await commitFastDraft({
      projectDir,
      chapter: 9,
      commitPlan: {},
    });

    expect(report.passed).toBe(true);
    await expect(readFile(join(projectDir, "chapters", "0009.md"), "utf-8")).resolves.toContain("真正的章节定稿");
    expect((report as typeof report & { readonly diagnosticsWarning?: string }).diagnosticsWarning).toContain("diagnostics");
    expect(JSON.parse(JSON.stringify(report))).not.toHaveProperty("diagnosticsWarning");
  });

  it("restores safe backups but refuses a staged transaction that would require path deletion", async () => {
    const projectDir = await createFixtureProject();
    const stateRelativePath = join("characters", "guo-xu", "state.json");
    const statePath = join(projectDir, stateRelativePath);
    const originalState = await readFile(statePath, "utf-8");
    const txDir = join(projectDir, ".story-engine-tx", "commit-chapter-0009");
    const stateBackupRelativePath = join("backups", stateRelativePath);
    await mkdir(join(txDir, "backups", "characters", "guo-xu"), { recursive: true });
    await writeFile(join(txDir, stateBackupRelativePath), originalState, "utf-8");
    await writeFile(
      join(txDir, "manifest.json"),
      `${JSON.stringify({
        version: 2,
        chapter: 9,
        createdAt: "2026-07-13T00:00:00.000Z",
        files: [stateRelativePath, join("chapters", "0009.md")],
        backups: [
          {
            relativePath: stateRelativePath,
            existed: true,
            backupPath: stateBackupRelativePath,
            sha256: createHash("sha256").update(originalState, "utf-8").digest("hex"),
          },
          { relativePath: join("chapters", "0009.md"), existed: false },
        ],
        status: "staged",
      }, null, 2)}\n`,
      "utf-8",
    );
    await writeFile(statePath, "{\"characterId\":\"guo-xu\",\"emotion\":\"partial-crash-corruption\"}\n", "utf-8");
    await writeFile(join(projectDir, "chapters", "0009.md"), "partial chapter write", "utf-8");
    await writeDraft(projectDir, 9, "# 崩溃恢复后的新提交\n\nGuo Xu 确认旧事务已恢复，再提交这一版。\n");

    const report = await commitFastDraft({
      projectDir,
      chapter: 9,
      commitPlan: {},
    });

    expect(report.passed).toBe(false);
    expect(report.issues.join(" ")).toMatch(/snapshot|manual|delete|refus/iu);
    await expect(readFile(statePath, "utf-8")).resolves.toBe(originalState);
    await expect(readFile(join(projectDir, "chapters", "0009.md"), "utf-8")).resolves.toBe("partial chapter write");
    await expect(readTransactionStatus(projectDir, 9)).resolves.toBe("staged");
  });

  it("serializes same-chapter commits in invocation order so transaction staging cannot race", async () => {
    const projectDir = await createFixtureProject();
    const firstDraftPath = join(projectDir, "drafts", "fast", "chapter-0010-first.md");
    const secondDraftPath = join(projectDir, "drafts", "fast", "chapter-0010-second.md");
    // The first invocation is intentionally expensive to read. A lock acquired
    // only at stage time (or no lock) lets the second request overtake it and
    // both transactions then share the same txDir.
    await writeFile(firstDraftPath, `# 第十章第一版\n\n${"第一版较长正文。".repeat(1_000_000)}\n`, "utf-8");
    await writeFile(secondDraftPath, "# 第十章第二版\n\n第二版应在串行队列中最后落盘。\n", "utf-8");

    const [first, second] = await Promise.all([
      commitFastDraft({
        projectDir,
        chapter: 10,
        draftPath: firstDraftPath,
        commitPlan: { worldUpdates: { currentPhase: "first-invocation" } },
      }),
      commitFastDraft({
        projectDir,
        chapter: 10,
        draftPath: secondDraftPath,
        commitPlan: { worldUpdates: { currentPhase: "second-invocation" } },
      }),
    ]);

    expect(first.passed).toBe(true);
    expect(second.passed).toBe(true);
    await expect(readWorldState(projectDir)).resolves.toMatchObject({ currentPhase: "second-invocation" });
    await expect(readFile(join(projectDir, "chapters", "0010.md"), "utf-8")).resolves.toContain("第二版应在串行队列中最后落盘");
    await expect(readTransactionStatus(projectDir, 10)).resolves.toBe("applied");
  });

  it("serializes different chapters project-wide so shared timeline updates are not lost", async () => {
    const projectDir = await createFixtureProject();
    const firstDraftPath = join(projectDir, "drafts", "fast", "chapter-0011-first.md");
    const secondDraftPath = join(projectDir, "drafts", "fast", "chapter-0012-second.md");
    await writeFile(firstDraftPath, `# 第十一章\n\n${"第一章并发长正文。".repeat(800_000)}\n`, "utf-8");
    await writeFile(secondDraftPath, "# 第十二章\n\n第二个并发章节。\n", "utf-8");

    const [first, second] = await Promise.all([
      commitFastDraft({
        projectDir,
        chapter: 11,
        draftPath: firstDraftPath,
        commitPlan: { timelineEvents: [{ summary: "第十一章共享事件", participants: ["guo-xu"] }] },
      }),
      commitFastDraft({
        projectDir,
        chapter: 12,
        draftPath: secondDraftPath,
        commitPlan: { timelineEvents: [{ summary: "第十二章共享事件", participants: ["guo-xu"] }] },
      }),
    ]);

    expect(first.passed).toBe(true);
    expect(second.passed).toBe(true);
    await expect(readTimelineEvents(projectDir)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ chapter: 11, summary: "第十一章共享事件" }),
      expect.objectContaining({ chapter: 12, summary: "第十二章共享事件" }),
    ]));
  });

  it("recovers another chapter residue before reading shared formal state", async () => {
    const projectDir = await createFixtureProject();
    const timelineRelativePath = join("timeline", "events.json");
    const timelinePath = join(projectDir, timelineRelativePath);
    const originalTimeline = await readFile(timelinePath, "utf-8");
    const txDir = join(projectDir, ".story-engine-tx", "commit-chapter-0001");
    const backupRelativePath = join("backups", timelineRelativePath);
    await mkdir(join(txDir, "backups", "timeline"), { recursive: true });
    await writeFile(join(txDir, backupRelativePath), originalTimeline, "utf-8");
    await writeFile(join(txDir, "manifest.json"), `${JSON.stringify({
      version: 2,
      chapter: 1,
      createdAt: "2026-07-13T00:00:00.000Z",
      files: [timelineRelativePath],
      backups: [{
        relativePath: timelineRelativePath,
        existed: true,
        backupPath: backupRelativePath,
        sha256: createHash("sha256").update(originalTimeline, "utf-8").digest("hex"),
      }],
      status: "staged",
    }, null, 2)}\n`, "utf-8");
    await writeFile(timelinePath, `${JSON.stringify([{
      id: "contaminated-partial-event",
      chapter: 999,
      summary: "崩溃留下的污染事件",
      participants: [],
    }], null, 2)}\n`, "utf-8");
    await writeDraft(projectDir, 2, "# 第二章\n\nGuo Xu 写下恢复后的真实事件。\n");

    const report = await commitFastDraft({
      projectDir,
      chapter: 2,
      commitPlan: { timelineEvents: [{ summary: "恢复后第二章事件", participants: ["guo-xu"] }] },
    });

    expect(report.passed).toBe(true);
    const events = await readTimelineEvents(projectDir);
    expect(events).toEqual([expect.objectContaining({ chapter: 2, summary: "恢复后第二章事件" })]);
    expect(events.some((event) => event.id === "contaminated-partial-event")).toBe(false);
    await expect(readTransactionStatus(projectDir, 1)).resolves.toBe("recovered");
  });

  it("drops a zero-file transaction shell left by snapshot undo instead of refusing forever", async () => {
    const projectDir = await createFixtureProject();
    // Undo unlinks every staged file but not the directories (git tracks files
    // only): a nested empty shell with no manifest remains.
    const txDir = join(projectDir, ".story-engine-tx", "commit-chapter-0003");
    await mkdir(join(txDir, "snapshot", "chapters"), { recursive: true });
    await mkdir(join(txDir, "chapters"), { recursive: true });

    await recoverProjectCommitTransactions(projectDir);

    await expect(access(txDir)).rejects.toThrow(); // shell removed
    await expect(access(join(projectDir, ".story-engine-tx"))).resolves.toBeUndefined(); // root stays
    // The project is not bricked: a fresh commit for that chapter works.
    await writeDraft(projectDir, 3, "# 第三章\n\nGuo Xu 在空壳清理后正常入库。\n");
    const report = await commitFastDraft({ projectDir, chapter: 3, commitPlan: {} });
    expect(report.passed).toBe(true);
    await expect(readTransactionStatus(projectDir, 3)).resolves.toBe("applied");
  });

  it("still refuses a manifest-less transaction directory that contains any file", async () => {
    const projectDir = await createFixtureProject();
    const txDir = join(projectDir, ".story-engine-tx", "commit-chapter-0004");
    await mkdir(join(txDir, "snapshot"), { recursive: true });
    await writeFile(join(txDir, "snapshot", "stray.txt"), "unidentified residue", "utf-8");

    await expect(recoverProjectCommitTransactions(projectDir)).rejects.toThrow(/Unreadable commit transaction residue/iu);
    // Fail closed means untouched: the unidentified file must survive.
    await expect(readFile(join(txDir, "snapshot", "stray.txt"), "utf-8")).resolves.toBe("unidentified residue");
  });

  it.skipIf(process.platform === "win32")("refuses a formal target symlink without touching its outside target", async () => {
    const projectDir = await createFixtureProject();
    const outsideDir = await mkdtemp(join(tmpdir(), "story-engine-outside-target-"));
    const outsidePath = join(outsideDir, "outside.md");
    await writeFile(outsidePath, "outside sentinel", "utf-8");
    await symlink(outsidePath, join(projectDir, "chapters", "0013.md"));
    await writeDraft(projectDir, 13, "# 第十三章\n\nGuo Xu 绝不能写到项目外。\n");

    const report = await commitFastDraft({ projectDir, chapter: 13, commitPlan: {} });

    expect(report.passed).toBe(false);
    expect(report.issues.join(" ")).toMatch(/symlink|unsafe|symbolic/iu);
    await expect(readFile(outsidePath, "utf-8")).resolves.toBe("outside sentinel");
  });

  it.skipIf(process.platform === "win32")("refuses a symlinked transaction root without writing outside the project", async () => {
    const projectDir = await createFixtureProject();
    const outsideTxRoot = await mkdtemp(join(tmpdir(), "story-engine-outside-tx-"));
    await symlink(outsideTxRoot, join(projectDir, ".story-engine-tx"));
    await writeDraft(projectDir, 14, "# 第十四章\n\nGuo Xu 不允许事务目录逃逸。\n");

    const report = await commitFastDraft({ projectDir, chapter: 14, commitPlan: {} });

    expect(report.passed).toBe(false);
    expect(report.issues.join(" ")).toMatch(/transaction|symlink|unsafe|symbolic/iu);
    await expect(readdir(outsideTxRoot)).resolves.toEqual([]);
    await expect(access(join(projectDir, "chapters", "0014.md"))).rejects.toThrow();
  });

  it.each([
    ["truncated", "{not-json"],
    ["chapter mismatch", JSON.stringify(validSnapshotOnlyManifest(2))],
    ["unsafe changed path", JSON.stringify({
      ...validSnapshotOnlyManifest(1),
      appliedChangedFiles: ["chapters/0002.md"],
    })],
  ])("fails closed on %s snapshot-only commit residue", async (_label, manifestText) => {
    const projectDir = await createFixtureProject();
    const txDir = join(projectDir, ".story-engine-tx", "commit-chapter-0001");
    await mkdir(txDir, { recursive: true });
    await writeFile(join(txDir, "snapshot-manifest.json"), manifestText, "utf-8");

    await expect(recoverProjectCommitTransactions(projectDir)).rejects.toThrow(/snapshot|residue|manifest|unsafe/iu);
    await expect(access(txDir)).resolves.toBeUndefined();
  });

  it("accepts a strictly valid finalized snapshot-only audit residue", async () => {
    const projectDir = await createFixtureProject();
    const txDir = join(projectDir, ".story-engine-tx", "commit-chapter-0001");
    await mkdir(txDir, { recursive: true });
    await writeFile(
      join(txDir, "snapshot-manifest.json"),
      `${JSON.stringify(validSnapshotOnlyManifest(1), null, 2)}\n`,
      "utf-8",
    );

    await expect(recoverProjectCommitTransactions(projectDir)).resolves.toBeUndefined();
    await expect(access(txDir)).resolves.toBeUndefined();
  });

  it("fails closed instead of path-deleting a target that did not exist before the transaction", async () => {
    const projectDir = await createFixtureProject();
    const relativePath = "chapters/0016.md";
    const targetPath = join(projectDir, relativePath);
    const txDir = join(projectDir, ".story-engine-tx", "commit-chapter-0016");
    await mkdir(join(projectDir, "chapters"), { recursive: true });
    await mkdir(txDir, { recursive: true });
    await writeFile(targetPath, "partial newly-created target must remain for manual recovery", "utf-8");
    await writeFile(join(txDir, "manifest.json"), `${JSON.stringify({
      version: 2,
      chapter: 16,
      createdAt: "2026-07-13T00:00:00.000Z",
      files: [relativePath],
      backups: [{ relativePath, existed: false }],
      status: "staged",
    }, null, 2)}\n`, "utf-8");

    await expect(recoverProjectCommitTransactions(projectDir)).rejects.toThrow(/manual|snapshot|delete|refus/iu);
    await expect(readFile(targetPath, "utf-8"))
      .resolves.toBe("partial newly-created target must remain for manual recovery");
    await expect(access(txDir)).resolves.toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("does not truncate an outside sentinel when a target parent is swapped before open", async () => {
    const projectDir = await createFixtureProject();
    const outsideDir = await mkdtemp(join(tmpdir(), "story-engine-parent-swap-outside-"));
    const outsideSentinel = join(outsideDir, "0015.md");
    await writeFile(outsideSentinel, "outside sentinel must survive", "utf-8");
    await writeDraft(projectDir, 15, "# 第十五章\n\nGuo Xu 不能覆盖项目外的同名章节。\n");
    let swapped = false;
    setCommitIoTestHookForTests(async (phase, targetPath) => {
      if (swapped || phase !== "after-precheck-before-open" || targetPath !== join(projectDir, "chapters", "0015.md")) return;
      swapped = true;
      await rename(join(projectDir, "chapters"), join(projectDir, "chapters-original"));
      await symlink(outsideDir, join(projectDir, "chapters"));
    });
    try {
      const report = await commitFastDraft({ projectDir, chapter: 15, commitPlan: {} });
      expect(report.passed).toBe(false);
      expect(report.issues.join(" ")).toMatch(/parent|containment|unsafe|symbolic/iu);
      await expect(readFile(outsideSentinel, "utf-8")).resolves.toBe("outside sentinel must survive");
    } finally {
      setCommitIoTestHookForTests(undefined);
    }
  });
});

function validSnapshotOnlyManifest(chapter: number): Record<string, unknown> {
  const chapterPath = `chapters/${String(chapter).padStart(4, "0")}.md`;
  return {
    status: "finalized",
    chapter,
    createdAt: "2026-07-13T00:00:00.000Z",
    finalizedAt: "2026-07-13T00:01:00.000Z",
    files: [{ relativePath: chapterPath, snapshotPath: null, rollbackAction: "delete_if_created" }],
    noFormalStateWriteConfirmed: true,
    productionApplyImplemented: false,
    routeWired: true,
    formalApplyMode: "chapter_only_v0a",
    stateWritesEnabled: false,
    defaultFormalWritesEnabled: false,
    cleanupPerformed: false,
    appliedChangedFiles: [chapterPath],
  };
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

async function readTransactionStatus(projectDir: string, chapter: number): Promise<string> {
  const text = await readFile(
    join(projectDir, ".story-engine-tx", `commit-chapter-${String(chapter).padStart(4, "0")}`, "manifest.json"),
    "utf-8",
  );
  return (JSON.parse(text) as { status: string }).status;
}

async function createFixtureProject(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "story-engine-commit-"));
  const { projectDir } = await createStoryProject({
    rootDir,
    title: "我的修仙副本",
    genre: "xianxia",
    premise: "用户自己当主角，从杂役弟子开始逆袭。",
    mainCharacterName: "Guo Xu / 主角",
  });
  await writeFile(
    join(projectDir, "world", "state.json"),
    `${JSON.stringify({
      currentPhase: "opening",
      activeConflicts: ["旧冲突"],
      activeHooks: ["h-existing"],
      knownSecrets: ["旧秘密"],
      lastUpdatedChapter: null,
    }, null, 2)}\n`,
    "utf-8",
  );
  await writeFile(
    join(projectDir, "story", "hooks.json"),
    `${JSON.stringify({
      hooks: [
        {
          id: "h-ledger",
          title: "矿藏账册缺口",
          description: "组织账册里少了一批矿藏。",
          status: "seeded",
          relatedCharacters: ["guo-xu"],
        },
      ],
    }, null, 2)}\n`,
    "utf-8",
  );
  return projectDir;
}

async function writeDraft(projectDir: string, chapter: number, content: string): Promise<void> {
  await writeFile(join(projectDir, "drafts", "fast", `chapter-${String(chapter).padStart(4, "0")}.md`), content, "utf-8");
}
