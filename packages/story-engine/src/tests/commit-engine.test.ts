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
import { buildStateOverview } from "../state-overview.js";
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

  it("auto-recovers a staged residue: restores safe backups, keeps unverifiable new files, unblocks the next commit", async () => {
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

    // P1-6：残留事务不再永久锁死项目。recover 把能安全回滚的备份还原（state.json），
    // 无法自证为事务写入内容的新建文件原地保留（不误删用户数据），标记 recovered 放行，
    // 随后的新提交自然把残留的半截章节覆盖成正式定稿。
    expect(report.passed).toBe(true);
    expect(report.issues).toHaveLength(0);
    await expect(readFile(statePath, "utf-8")).resolves.toBe(originalState);
    await expect(readFile(join(projectDir, "chapters", "0009.md"), "utf-8"))
      .resolves.toContain("崩溃恢复后的新提交");
    await expect(readTransactionStatus(projectDir, 9)).resolves.not.toBe("staged");
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

  it("never path-deletes a new target it cannot verify, but marks the residue recovered instead of locking the project", async () => {
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

    // P1-6：recover 无法自证磁盘内容就是事务写入的内容（可能含用户未保存的编辑），
    // 所以绝不路径删除；但也不再永久抛错把项目锁死——标记 recovered 放行，文件原地保留。
    await expect(recoverProjectCommitTransactions(projectDir)).resolves.toBeUndefined();
    await expect(readFile(targetPath, "utf-8"))
      .resolves.toBe("partial newly-created target must remain for manual recovery");
    await expect(access(txDir)).resolves.toBeUndefined();
    await expect(readFile(join(txDir, "manifest.json"), "utf-8"))
      .resolves.toMatch(/"status":\s*"recovered"/u);
    await expect(readFile(join(txDir, "manifest.json"), "utf-8"))
      .resolves.toMatch(/"recoveryIssues"/u);
    // 已 recovered 的残留不再重复处理，也不会再阻塞。
    await expect(recoverProjectCommitTransactions(projectDir)).resolves.toBeUndefined();
  });

  // A3（2026-09-15 复审）：P1-6 放行残留的 recoveryIssues 此前只写 manifest、全仓零读点——
  // 盘上「章文件已留、资料已回滚」的分歧态用户/agent 无从知晓。回归：残留必须上浮进
  // CommitReport.issues 与 overview 的 warnings 通道，且文案中性、不带绝对路径。
  it("A3 残留上浮：recovered-with-issues 进 report.issues 与 overview warnings，无绝对路径", async () => {
    const projectDir = await createFixtureProject();
    const relativePath = "chapters/0003.md";
    const txDir = join(projectDir, ".story-engine-tx", "commit-chapter-0003");
    await mkdir(txDir, { recursive: true });
    // 事务前不存在的新建文件被留在盘上——recover 无法自证内容，只能标 recovered+recoveryIssues 放行
    await writeFile(join(projectDir, relativePath), "half-applied chapter kept on disk", "utf-8");
    await writeFile(join(txDir, "manifest.json"), `${JSON.stringify({
      version: 2,
      chapter: 3,
      createdAt: "2026-07-13T00:00:00.000Z",
      files: [relativePath],
      backups: [{ relativePath, existed: false }],
      status: "staged",
    }, null, 2)}\n`, "utf-8");

    // 另一章正常提交：recover 放行残留后完成本事务，report.issues 必须带上浮通知
    await writeDraft(projectDir, 4, "# 第四章\n\nGuo Xu 继续推进主线。\n");
    const report = await commitFastDraft({ projectDir, chapter: 4, commitPlan: {} });
    expect(report.passed).toBe(true);
    expect(report.issues.join(" ")).toContain("transaction_recovered_partial");
    expect(report.issues.join(" ")).toContain("第 3 章");
    // 路径泄漏纪律：用户可见文案绝不带本地绝对路径
    expect(report.issues.join(" ")).not.toMatch(/\/Users|\/var|\/private|\/tmp|\/home/);

    // overview 既有 warnings 通道同步可见（UI 消费 uiHints.warnings）
    const overview = await buildStateOverview({ projectDir, chapter: 4 });
    expect(overview.uiHints.warnings.join(" ")).toContain("transaction_recovered_partial");
    expect(overview.uiHints.warnings.join(" ")).not.toMatch(/\/Users|\/var|\/private|\/tmp|\/home/);

    // 细节仍在盘上 manifest 里可人工核对
    await expect(readFile(join(txDir, "manifest.json"), "utf-8")).resolves.toMatch(/"recoveryIssues"/u);
  });

  it("A3 同章重提吸收残留后不再报（分歧态已自愈）", async () => {
    const projectDir = await createFixtureProject();
    const relativePath = "chapters/0003.md";
    const txDir = join(projectDir, ".story-engine-tx", "commit-chapter-0003");
    await mkdir(txDir, { recursive: true });
    await writeFile(join(projectDir, relativePath), "half-applied chapter kept on disk", "utf-8");
    await writeFile(join(txDir, "manifest.json"), `${JSON.stringify({
      version: 2,
      chapter: 3,
      createdAt: "2026-07-13T00:00:00.000Z",
      files: [relativePath],
      backups: [{ relativePath, existed: false }],
      status: "staged",
    }, null, 2)}\n`, "utf-8");

    // 直接重提同一章：新事务吸收残留目录，旧 manifest 被覆盖为 applied——分歧态自愈，不应再报。
    await writeDraft(projectDir, 3, "# 第三章\n\nGuo Xu 重提并落定了这一章。\n");
    const report = await commitFastDraft({ projectDir, chapter: 3, commitPlan: {} });
    expect(report.passed).toBe(true);
    expect(report.issues.join(" ")).not.toContain("transaction_recovered_partial");
    const overview = await buildStateOverview({ projectDir, chapter: 3 });
    expect(overview.uiHints.warnings.join(" ")).not.toContain("transaction_recovered_partial");
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

  it("P1-6 apply 中段崩溃 → 回滚按内容匹配安全处理新建章节文件，项目不锁死", async () => {
    const projectDir = await createFixtureProject();
    const chapterPath = join(projectDir, "chapters", "0014.md");
    await writeDraft(projectDir, 14, "# 第十四章\n\nGuo Xu 提交后崩溃在 manifest 落 applied 之前。\n");
    // 事务前 chapters/0014.md 不存在（existed:false）——正是新建文件场景（probe 实证）

    // 在章节文件打开后、写入前注入故障：模拟崩溃在 apply 中段
    let injected = false;
    setCommitIoTestHookForTests(async (phase, targetPath) => {
      if (injected || targetPath !== chapterPath) return;
      if (phase !== "after-open-before-verify") return;
      injected = true;
      throw new Error("模拟崩溃：apply 中段故障");
    });
    try {
      const report = await commitFastDraft({ projectDir, chapter: 14, commitPlan: {} });
      expect(report.passed).toBe(false);
    } finally {
      setCommitIoTestHookForTests(undefined);
    }

    // 关键回归点：此前此处会永久锁死——每次提交都进 recover → 遇 existed:false 的新建文件
    // 抛 Rollback failed → commitFastDraft 转 passed:false，永远无法再提交。
    // 修复后回滚自洽（删或保留都如实记录），项目可继续提交。
    const report2 = await commitFastDraft({ projectDir, chapter: 14, commitPlan: {} });
    expect(report2.passed).toBe(true);
  });

  it("P1-6 新建文件被第三方改动后内容不匹配 → 拒绝删除并保留（不误删用户数据）", async () => {
    const projectDir = await createFixtureProject();
    const chapterPath = join(projectDir, "chapters", "0013.md");
    await writeDraft(projectDir, 13, "# 第十三章\n\n原始事务写入的内容。\n");

    let injected = false;
    setCommitIoTestHookForTests(async (phase, targetPath) => {
      if (injected || targetPath !== chapterPath) return;
      if (phase !== "after-open-before-verify") return;
      injected = true;
      // 事务写完后、崩溃前，别的进程改了这个新建文件
      await writeFile(chapterPath, "用户或别的进程刚保存的改动，绝不能被回滚删掉", "utf-8");
      throw new Error("模拟崩溃：apply 中段故障");
    });
    try {
      const report = await commitFastDraft({ projectDir, chapter: 13, commitPlan: {} });
      expect(report.passed).toBe(false);
    } finally {
      setCommitIoTestHookForTests(undefined);
    }

    // 内容已不匹配 → 拒绝删除，第三方改动保留在盘上
    await expect(readFile(chapterPath, "utf-8"))
      .resolves.toBe("用户或别的进程刚保存的改动，绝不能被回滚删掉");
  });

  // P2：世界状态的冲突/隐情/hook 此前只增不减——写到第 50 章时第 1 章的冲突仍挂在 activeConflicts 里，
  // 把用户的世界规则挤出概览、还让已揭底的秘密继续被当悬念写。现在支持显式退场：
  // 只扣模型明确点名的条目（归一化匹配），绝不做推断式清除。
  it("P2 世界状态退场：resolvedConflicts/revealedSecrets 按归一化文本扣除；未点名的必须保留", async () => {
    const projectDir = await createFixtureProject();
    await writeDraft(projectDir, 20, "# 第二十章\n\n城南争夺化解，商会继承权仍在。\n");
    expect((await commitFastDraft({
      projectDir,
      chapter: 20,
      commitPlan: {
        worldUpdates: {
          activeConflicts: ["城南争夺", "商会继承权"],
          knownSecrets: ["会长是义父"],
        },
      },
    })).passed).toBe(true);

    // 归一化匹配：「城南 争夺」（中间多个空格）须扣掉早前登记的「城南争夺」。
    await writeDraft(projectDir, 21, "# 第二十一章\n\n商会继承权仍在。\n");
    expect((await commitFastDraft({
      projectDir,
      chapter: 21,
      commitPlan: {
        worldUpdates: {
          resolvedConflicts: ["城南 争夺"],
          revealedSecrets: ["会长是义父"],
        },
      },
    })).passed).toBe(true);

    const state = await readWorldState(projectDir);
    expect(state.activeConflicts).toEqual(["旧冲突", "商会继承权"]); // 缺失不等于化解
    expect(state.knownSecrets).toEqual(["旧秘密"]); // 本章只揭示了「会长是义父」；未点名的旧秘密保留
  });

  it("P2 resolvedConflicts 传空串/空数组时零扣除（退化输入不静默清空用户数据）", async () => {
    const projectDir = await createFixtureProject();
    await writeDraft(projectDir, 22, "# 第二十二章\n\n什么都没化解。\n");
    await commitFastDraft({
      projectDir,
      chapter: 22,
      commitPlan: { worldUpdates: { activeConflicts: ["新冲突"], resolvedConflicts: ["", "   "] } },
    });
    expect((await readWorldState(projectDir)).activeConflicts).toEqual(["旧冲突", "新冲突"]);
  });

  it("P2 activeHooks 随 hook 化解/废弃退场，不再永久堆积", async () => {
    const projectDir = await createFixtureProject();
    await writeDraft(projectDir, 23, "# 第二十三章\n\n账册线索了结。\n");
    expect((await commitFastDraft({
      projectDir,
      chapter: 23,
      commitPlan: {
        worldUpdates: { activeHooks: ["h-existing", "h-ledger"] },
        hookUpdates: [{ hookId: "h-ledger", status: "resolved" }],
      },
    })).passed).toBe(true);
    // 化解的 h-ledger 退场；未涉及的两个保留。
    expect((await readWorldState(projectDir)).activeHooks).toEqual(["h-existing"]);
  });

  it("P2 退化输入：resolvedConflicts 传非数组/数字时不崩、零扣除", async () => {
    const projectDir = await createFixtureProject();
    await writeDraft(projectDir, 24, "# 第二十四章\n\n退化输入测试。\n");
    await commitFastDraft({
      projectDir,
      chapter: 24,
      // 模型可能给畸形值；引擎须容忍并归一成「无扣除」，而不是清空或崩
      commitPlan: { worldUpdates: { resolvedConflicts: 42 as unknown as readonly string[] } },
    });
    expect((await readWorldState(projectDir)).activeConflicts).toEqual(["旧冲突"]);
  });

  it("P2 故事日不回退：作者已写到第 10 天，后续低章号提交不许压回第 4 天", async () => {
    const projectDir = await createFixtureProject();
    // 作者明确设定：第 3 章时故事已推进到第 10 天、夜晚
    const calPath = join(projectDir, "time", "calendar.json");
    await writeFile(calPath, `${JSON.stringify({ currentStoryDay: 10, currentTimeOfDay: "night" }, null, 2)}\n`, "utf-8");

    await writeDraft(projectDir, 4, "# 第四章\n\n新的清晨。\n");
    expect((await commitFastDraft({
      projectDir,
      chapter: 4,
      commitPlan: { calendar: { storyDay: 4, timeOfDay: "unknown" } },
    })).passed).toBe(true);

    const cal = await readStoryCalendar(projectDir);
    expect(cal.currentStoryDay).toBe(10); // 不许回压
    expect(cal.currentTimeOfDay).toBe("night"); // 无时间证据时沿用上次已知时刻
  });

  it("P2 故事日正常前进：无既有设定时按章号推进，时刻诚实留 unknown", async () => {
    const projectDir = await createFixtureProject();
    await writeDraft(projectDir, 5, "# 第五章\n\n行程继续。\n");
    expect((await commitFastDraft({
      projectDir,
      chapter: 5,
      commitPlan: { calendar: { storyDay: 5, timeOfDay: "unknown" } },
    })).passed).toBe(true);
    expect(await readStoryCalendar(projectDir)).toEqual({
      currentStoryDay: 5,
      currentTimeOfDay: "unknown",
    });
  });

  it("P2 退化输入：storyDay 传 NaN/0/负数时不崩，回落到既有故事日", async () => {
    const projectDir = await createFixtureProject();
    const calPath = join(projectDir, "time", "calendar.json");
    await writeFile(calPath, `${JSON.stringify({ currentStoryDay: 7, currentTimeOfDay: "noon" }, null, 2)}\n`, "utf-8");

    await writeDraft(projectDir, 6, "# 第六章\n\n退化输入测试。\n");
    expect((await commitFastDraft({
      projectDir,
      chapter: 6,
      commitPlan: { calendar: { storyDay: Number.NaN, timeOfDay: "unknown" } },
    })).passed).toBe(true);
    expect(await readStoryCalendar(projectDir)).toEqual({
      currentStoryDay: 7, // NaN 被拒，沿用既有
      currentTimeOfDay: "noon",
    });
  });

  it("P2 currentPhase 水印已移除：作者设定的故事阶段在入库后保留", async () => {
    const projectDir = await createFixtureProject();
    const statePath = join(projectDir, "world", "state.json");
    const seeded = JSON.parse(await readFile(statePath, "utf-8")) as { currentPhase: string };
    await writeFile(statePath, `${JSON.stringify({ ...seeded, currentPhase: "高潮篇·背叛" }, null, 2)}\n`, "utf-8");

    await writeDraft(projectDir, 8, "# 第八章\n\n高潮继续。\n");
    expect((await commitFastDraft({ projectDir, chapter: 8, commitPlan: {} })).passed).toBe(true);
    expect((await readWorldState(projectDir)).currentPhase).toBe("高潮篇·背叛");
  });

  // A4（P1-4 真修）：老书缺台账文件不该让入库直接失败——project-store 的 ENOENT 兜底
  // 把「没建过/早期版本没有」的文件按空台账读。commit-plan-builder 每次必发 calendar 更新，
  // 缺 time/calendar.json 此前会让整次提交 reject。损坏 JSON 仍 fail-closed 不静默。
  it("A4 老书缺台账文件：hooks/calendar/world-state/timeline 全缺也能入库", async () => {
    const projectDir = await createFixtureProject();
    await rm(join(projectDir, "story", "hooks.json"), { force: true });
    await rm(join(projectDir, "time", "calendar.json"), { force: true });
    await rm(join(projectDir, "world", "state.json"), { force: true });
    await rm(join(projectDir, "timeline", "events.json"), { force: true });

    await writeDraft(projectDir, 25, "# 第二十五章\n\n老书续写正常入库。\n");
    const report = await commitFastDraft({
      projectDir,
      chapter: 25,
      commitPlan: {
        calendar: { storyDay: 25, timeOfDay: "unknown" },
        timelineEvents: [{ summary: "老书事件", participants: ["guo-xu"] }],
        worldUpdates: { activeConflicts: ["新冲突"] },
      },
    });
    expect(report.passed).toBe(true);
    expect(report.issues.join(" ")).not.toMatch(/\/Users|\/var|\/private|\/tmp|\/home/u);
    expect(await readStoryCalendar(projectDir)).toMatchObject({ currentStoryDay: 25 });
    expect(await readTimelineEvents(projectDir)).toHaveLength(1);
    expect((await readWorldState(projectDir)).activeConflicts).toContain("新冲突");
    expect((await readHookPool(projectDir)).hooks).toEqual([]);
  });

  // A6 老书回归：盘上 world/state.json 含退休字段（resolvedConflicts/revealedSecrets 键）与
  // 旧版自动水印（currentPhase: chapter_N_committed），calendar 故事日高于后续章号——
  // 读/概览/入库三条主路径必须零崩，字段被忽略但原样透传，故事日不被回压，水印不再被自动覆写。
  it("A6 老书兼容：退休字段+旧水印+回退故事日 零崩且不丢数据", async () => {
    const projectDir = await createFixtureProject();
    await writeFile(join(projectDir, "world", "state.json"), `${JSON.stringify({
      currentPhase: "chapter_3_committed", // 旧版自动水印的存量值
      activeConflicts: ["旧冲突"],
      activeHooks: ["h-existing"],
      knownSecrets: ["旧秘密"],
      lastUpdatedChapter: 3,
      resolvedConflicts: ["已化解的旧冲突"], // 退休字段：老盘上可能已手写/旧版留下
      revealedSecrets: ["已揭示的旧秘密"],
    }, null, 2)}\n`, "utf-8");
    await writeFile(join(projectDir, "time", "calendar.json"), `${JSON.stringify({ currentStoryDay: 10, currentTimeOfDay: "night" }, null, 2)}\n`, "utf-8");

    // readWorldState：未知键透传、不崩
    const state = await readWorldState(projectDir);
    expect(state.currentPhase).toBe("chapter_3_committed");
    expect((state as unknown as Record<string, unknown>).resolvedConflicts).toEqual(["已化解的旧冲突"]);

    // buildStateOverview：零崩（概览对 worldState 未知键本就宽容）
    const overview = await buildStateOverview({ projectDir, chapter: 5 });
    expect(overview.project.title).toBeTruthy();

    // commitFastDraft：零崩；故事日单调不回压；退休字段与旧水印透传保留、不被覆写
    await writeDraft(projectDir, 5, "# 第五章\n\n老书继续推进。\n");
    const report = await commitFastDraft({
      projectDir,
      chapter: 5,
      commitPlan: {
        calendar: { storyDay: 4, timeOfDay: "unknown" }, // 请求日低于既有 10 → 不得回压
        worldUpdates: { activeConflicts: ["新冲突"] },
      },
    });
    expect(report.passed).toBe(true);
    expect((await readStoryCalendar(projectDir)).currentStoryDay).toBe(10);
    const after = JSON.parse(await readFile(join(projectDir, "world", "state.json"), "utf-8")) as Record<string, unknown>;
    expect(after.currentPhase).toBe("chapter_3_committed"); // 自动入库不再写 chapter_N_committed 水印
    expect(after.resolvedConflicts).toEqual(["已化解的旧冲突"]); // 未知键被忽略但透传，不丢数据
    expect(after.revealedSecrets).toEqual(["已揭示的旧秘密"]);
    expect(after.activeConflicts).toEqual(["旧冲突", "新冲突"]);
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



describe("StoryEngine-NG CommitEngine（世界状态只增不减·读侧）", () => {
  it("P2 概览取最近若干条累积项，常设世界规则不被老冲突挤出", async () => {
    const projectDir = await createFixtureProject();
    // 作者填写的故事法则（新建书默认为空，长篇里这是常设设定，不该被章级冲突挤出概览）
    const rules = ["修仙界以矿藏为硬通货。", "宗门弟子按修为分阶。"];
    const corePath = join(projectDir, "world", "core.json");
    const core = JSON.parse(await readFile(corePath, "utf-8")) as { rules: string[] };
    await writeFile(corePath, `${JSON.stringify({ ...core, rules }, null, 2)}\n`, "utf-8");

    // 塞 20 条只增不减的冲突——模拟长篇堆积
    await writeDraft(projectDir, 30, "# 第三十章\n\n堆积测试。\n");
    await commitFastDraft({
      projectDir,
      chapter: 30,
      commitPlan: {
        worldUpdates: { activeConflicts: Array.from({ length: 20 }, (_, index) => `第${index + 1}冲突`) },
      },
    });
    const state = await readWorldState(projectDir);
    expect(state.activeConflicts).toHaveLength(21); // 全量留在盘上（不丢用户数据）

    const overview = await buildStateOverview({ projectDir, chapter: 30 });
    // 世界规则先占位（它们不过期），冲突取最新的若干条——最早的「旧冲突」不再霸占有限名额
    expect(overview.world.importantFacts.slice(0, rules.length)).toEqual(rules);
    expect(overview.world.importantFacts).toContain("第20冲突");
    expect(overview.world.importantFacts).not.toContain("旧冲突");
  });
});

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
