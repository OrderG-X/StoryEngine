import { createHash } from "node:crypto";
import { access, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FoundationGapSuggestion } from "../../api/types.js";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import type { Middleware } from "../lib/project-io.js";

const storyEngineMocks = vi.hoisted(() => ({
  applyFoundationGapDecisions: vi.fn(),
  buildFoundationGapApplyPlan: vi.fn(),
  buildFoundationGapReport: vi.fn(),
  buildFoundationGapSuggestions: vi.fn(),
  buildStateOverview: vi.fn(),
}));

vi.mock("@actalk/story-engine", async () => {
  const actual = await vi.importActual<typeof import("@actalk/story-engine")>("@actalk/story-engine");
  return {
    ...actual,
    ...storyEngineMocks,
  };
});

const snapshotMocks = vi.hoisted(() => ({
  createSnapshot: vi.fn(),
}));

vi.mock("../lib/snapshot.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/snapshot.js")>("../lib/snapshot.js");
  return {
    ...actual,
    createSnapshot: snapshotMocks.createSnapshot,
  };
});

import { __foundationGapsRouteTest, registerFoundationGapsRoutes } from "./foundation-gaps.js";

const { createSnapshot } = snapshotMocks;

const {
  applyFoundationGapDecisions,
  buildFoundationGapApplyPlan,
  buildFoundationGapReport,
  buildFoundationGapSuggestions,
  buildStateOverview,
} = storyEngineMocks;

describe("foundation gap routes", () => {
  let projectDir: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    createSnapshot.mockResolvedValue({ id: "snap-test", label: "资料写入前快照", createdAt: new Date().toISOString() });
    buildFoundationGapReport.mockResolvedValue({ gaps: [], summary: "ok" });
    buildFoundationGapSuggestions.mockResolvedValue([]);
    buildFoundationGapApplyPlan.mockResolvedValue({ acceptedSuggestions: [], skippedSuggestions: [], fileChanges: [] });
    applyFoundationGapDecisions.mockResolvedValue({ applied: [], plan: {}, writes: [], overview: {} });
    buildStateOverview.mockResolvedValue({
      project: { title: "Foundation Route Test", genre: "", currentChapter: null },
      storyStatus: {},
      hooks: { activeCount: 0, touchedCount: 0, resolvedCount: 0, activeItems: [] },
      threads: { total: 0, open: 0, touched: 0, done: 0, openIntents: 0, cleanupVisibleCount: 0, keyOpenItems: [] },
      arcGoals: { activeCount: 0, touchedCount: 0, completedCount: 0, activeItems: [] },
      timeline: { recentEvents: [], earlierSummary: [], macroSummary: [] },
      characters: { knownCharacters: [] },
      world: { activeLocations: [], importantFacts: [] },
      maintenance: {
        diagnosticsAvailable: false,
        cleanupVisibleCount: 0,
        markDoneCandidateCount: 0,
        mergeDisabled: true,
        dropDisabled: true,
        confirmPolicy: { markDone: "manual_only", merge: "disabled", drop: "disabled" },
      },
      uiHints: { recommendedNextPanels: [], warnings: [], disabledActions: [] },
    });
  });

  afterEach(async () => {
    if (projectDir) {
      await rm(projectDir, { recursive: true, force: true });
      projectDir = undefined;
    }
  });

  it("keeps report, suggestions, and preview available when formal writes are disabled", async () => {
    projectDir = await createFoundationRouteProject();

    const reportResponse = await callFoundationGapsRoute(
      `/api/foundation-gaps/report?project=${encodeURIComponent(projectDir)}`,
      undefined,
      "GET",
    );
    const suggestionsResponse = await callFoundationGapsRoute("/api/foundation-gaps/suggestions", {
      projectPath: projectDir,
    });
    const previewResponse = await callFoundationGapsRoute("/api/foundation-gaps/preview", {
      projectPath: projectDir,
      decisions: [],
      currentSuggestions: [],
    });

    expect(reportResponse.statusCode).toBe(200);
    expect(suggestionsResponse.statusCode).toBe(200);
    expect(previewResponse.statusCode).toBe(200);
    expect(buildFoundationGapReport).toHaveBeenCalledTimes(2);
    expect(buildFoundationGapSuggestions).toHaveBeenCalledTimes(1);
    expect(buildFoundationGapApplyPlan).toHaveBeenCalledTimes(1);
    expect(applyFoundationGapDecisions).not.toHaveBeenCalled();
  });

  it("allows foundation apply with an undo snapshot and can roll it back", async () => {
    projectDir = await createFoundationRouteProject();
    await writeFile(join(projectDir, "story", "writing-rules.json"), `${JSON.stringify({ pointOfView: "第三人称" }, null, 2)}\n`, "utf-8");
    const suggestion: FoundationGapSuggestion = {
      id: "suggestion-writing-rule-1",
      gapId: "gap-writing-rule-1",
      category: "writingRules",
      actionType: "update_writing_rule",
      targetFile: "story/writing-rules.json",
      targetPath: "pointOfView",
      before: "第三人称",
      after: "第一人称",
      rationale: "用户要求以后用第一人称写。",
      risk: "info",
      requiresUserConfirm: true,
    };
    const plan = {
      acceptedSuggestions: [suggestion],
      rejectedSuggestionIds: [],
      deferredSuggestionIds: [],
      skippedConflicts: [],
      fileChanges: [{
        targetFile: "story/writing-rules.json",
        summary: "更新写作视角",
        suggestionIds: [suggestion.id],
      }],
    };
    buildFoundationGapApplyPlan.mockResolvedValueOnce(plan);
    applyFoundationGapDecisions.mockImplementationOnce(async () => {
      await writeFile(join(projectDir!, "story", "writing-rules.json"), `${JSON.stringify({ pointOfView: "第一人称" }, null, 2)}\n`, "utf-8");
      return {
        applied: true,
        plan,
        writes: [{
          domain: "writingRules",
          action: "update_writing_rule",
          targetFile: "story/writing-rules.json",
          summary: "更新写作视角",
        }],
        overview: {},
      };
    });

    const response = await callFoundationGapsRoute("/api/foundation-gaps/apply", {
      projectPath: projectDir,
      confirm: true,
      decisions: [{ suggestionId: suggestion.id, decision: "accept" }],
      currentSuggestions: [suggestion],
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload).toMatchObject({
      ok: true,
      result: {
        undo: {
          changedFiles: ["story/writing-rules.json"],
        },
      },
    });
    await expect(readJson(projectDir, "story/writing-rules.json")).resolves.toEqual({ pointOfView: "第一人称" });
    const undoId = (((response.payload.result as Record<string, unknown>).undo as Record<string, unknown>).undoId as string);

    const rollback = await callFoundationGapsRoute("/api/foundation-gaps/rollback", {
      projectPath: projectDir,
      undoId,
    });

    expect(rollback.statusCode).toBe(200);
    expect(rollback.payload).toMatchObject({
      ok: true,
      result: {
        undoId,
        restoredFiles: ["story/writing-rules.json"],
      },
    });
    await expect(readJson(projectDir, "story/writing-rules.json")).resolves.toEqual({ pointOfView: "第三人称" });
    expect(applyFoundationGapDecisions).toHaveBeenCalledTimes(1);
  });

  it("takes a pre-write git snapshot and passes engine newExtraFields through on apply", async () => {
    projectDir = await createFoundationRouteProject();
    await writeFile(join(projectDir, "story", "character-bible.json"), `${JSON.stringify({ version: "v0", characters: [{ id: "lin-wan", name: "林晚", role: "主角" }] }, null, 2)}\n`, "utf-8");
    const suggestion: FoundationGapSuggestion = {
      id: "suggestion-realm",
      gapId: "gap-realm",
      category: "characters",
      actionType: "update_character_detail",
      targetFile: "story/character-bible.json",
      targetPath: "characters",
      targetId: "lin-wan",
      before: undefined,
      after: { extraFields: { 境界: "金丹期" } },
      rationale: "林晚突破金丹期。",
      risk: "info",
      requiresUserConfirm: true,
    };
    const plan = {
      acceptedSuggestions: [suggestion],
      rejectedSuggestionIds: [],
      deferredSuggestionIds: [],
      skippedConflicts: [],
      fileChanges: [{ targetFile: "story/character-bible.json", summary: "更新角色资料", suggestionIds: [suggestion.id] }],
    };
    buildFoundationGapApplyPlan.mockResolvedValueOnce(plan);
    applyFoundationGapDecisions.mockImplementationOnce(async () => ({
      applied: true,
      plan,
      writes: [{
        domain: "character",
        action: "update_character_detail",
        targetFile: "story/character-bible.json",
        targetId: "lin-wan",
        targetName: "林晚",
        summary: "更新角色资料",
        newExtraFields: ["境界"],
      }],
      overview: {},
    }));

    const response = await callFoundationGapsRoute("/api/foundation-gaps/apply", {
      projectPath: projectDir,
      confirm: true,
      decisions: [{ suggestionId: suggestion.id, decision: "accept" }],
      currentSuggestions: [suggestion],
    });

    expect(response.statusCode).toBe(200);
    // 写前快照（阶段一）在直写路径上仍然成立，保障“可撤销”。
    expect(createSnapshot).toHaveBeenCalledWith(projectDir, "资料写入前快照");
    // 字段级回报：newExtraFields 原样透传到 wire，不被中间 re-map 丢字段。
    const writes = (response.payload.result as { readonly writes: readonly { readonly newExtraFields?: readonly string[] }[] }).writes;
    expect(writes[0]?.newExtraFields).toEqual(["境界"]);
  });

  it("rolls back character rename snapshots for character bible and profile files", async () => {
    projectDir = await createFoundationRouteProject();
    await mkdir(join(projectDir, "characters", "lin-xu"), { recursive: true });
    await writeFile(join(projectDir, "story", "character-bible.json"), `${JSON.stringify({ version: "v0", characters: [{ id: "lin-xu", name: "林序", role: "主角" }] }, null, 2)}\n`, "utf-8");
    await writeFile(join(projectDir, "characters", "lin-xu", "profile.json"), `${JSON.stringify({ id: "lin-xu", name: "林序", identity: "protagonist" }, null, 2)}\n`, "utf-8");
    const suggestion: FoundationGapSuggestion = {
      id: "suggestion-rename-1",
      gapId: "gap-rename-1",
      category: "characters",
      actionType: "rename_character",
      targetFile: "story/character-bible.json",
      targetPath: "characters.name",
      targetId: "lin-xu",
      before: "林序",
      after: { name: "林远" },
      rationale: "用户要求修改主角名。",
      risk: "info",
      requiresUserConfirm: true,
      writeMode: "replace",
    };
    const plan = {
      acceptedSuggestions: [suggestion],
      rejectedSuggestionIds: [],
      deferredSuggestionIds: [],
      skippedConflicts: [],
      fileChanges: [
        { targetFile: "story/character-bible.json", summary: "修改角色名", suggestionIds: [suggestion.id] },
        { targetFile: "characters/lin-xu/profile.json", summary: "同步角色档案名", suggestionIds: [suggestion.id] },
      ],
    };
    buildFoundationGapApplyPlan.mockResolvedValueOnce(plan);
    applyFoundationGapDecisions.mockImplementationOnce(async () => {
      await writeFile(join(projectDir!, "story", "character-bible.json"), `${JSON.stringify({ version: "v0", characters: [{ id: "lin-xu", name: "林远", role: "主角" }] }, null, 2)}\n`, "utf-8");
      await writeFile(join(projectDir!, "characters", "lin-xu", "profile.json"), `${JSON.stringify({ id: "lin-xu", name: "林远", identity: "protagonist" }, null, 2)}\n`, "utf-8");
      return {
        applied: true,
        plan,
        writes: [{
          domain: "character",
          action: "rename_character",
          targetFile: "story/character-bible.json",
          targetId: "lin-xu",
          targetName: "林远",
          summary: "修改角色名",
        }],
        overview: {},
      };
    });

    const response = await callFoundationGapsRoute("/api/foundation-gaps/apply", {
      projectPath: projectDir,
      confirm: true,
      decisions: [{ suggestionId: suggestion.id, decision: "accept" }],
      currentSuggestions: [suggestion],
    });
    const undoId = (((response.payload.result as Record<string, unknown>).undo as Record<string, unknown>).undoId as string);

    const rollback = await callFoundationGapsRoute("/api/foundation-gaps/rollback", {
      projectPath: projectDir,
      undoId,
    });

    expect(rollback.statusCode).toBe(200);
    expect(rollback.payload).toMatchObject({ ok: true });
    expect([...(rollback.payload.result as { readonly restoredFiles: readonly string[] }).restoredFiles].sort()).toEqual([
      "characters/lin-xu/profile.json",
      "story/character-bible.json",
    ]);
    await expect(readJson(projectDir, "story/character-bible.json")).resolves.toMatchObject({
      characters: [{ id: "lin-xu", name: "林序", role: "主角" }],
    });
    await expect(readJson(projectDir, "characters/lin-xu/profile.json")).resolves.toMatchObject({
      id: "lin-xu",
      name: "林序",
    });
  });

  it("commits only characters/<id>/state.json through the character confirm route", async () => {
    projectDir = await createFoundationRouteProject();
    await writeCharacterState(projectDir, "lin-xiao", { mood: "紧张", notes: "旧状态" });
    const body = characterStateConfirmBody(projectDir, {
      baseState: { mood: "紧张", notes: "旧状态" },
      statePatch: { mood: "冷静", currentGoal: "保护主角" },
    });

    const response = await callFoundationGapsRoute("/api/foundation-gaps/confirm-character-write", body);

    expect(response.statusCode).toBe(200);
    expect(response.payload).toMatchObject({
      ok: true,
      result: {
        status: "committed",
        scope: "character_state_only",
        changedFiles: ["characters/lin-xiao/state.json"],
        didWriteCharacterState: true,
        didWriteCharacterProfile: false,
        didWriteCharacterBible: false,
        didWriteCharacterMatrix: false,
        didWriteChapterMarkdown: false,
        didWriteTimeline: false,
        didWriteWorld: false,
        didWriteMemory: false,
        didCallCommitEngine: false,
        didCallApplyCommit: false,
        stateOverviewRefreshRequested: true,
        stateOverviewRefreshSucceeded: true,
        rollbackAttempted: false,
        rollbackSucceeded: null,
      },
    });
    await expect(readJson(projectDir, "characters/lin-xiao/state.json")).resolves.toMatchObject({
      mood: "冷静",
      currentGoal: "保护主角",
      notes: "旧状态",
    });
    await expect(readFile(join(projectDir, "characters", "lin-xiao", "profile.json"), "utf-8")).rejects.toThrow();
    expect(applyFoundationGapDecisions).not.toHaveBeenCalled();
  });

  it("blocks missing explicitConfirm, invalid target files, forbidden patch keys, and stale hashes", async () => {
    projectDir = await createFoundationRouteProject();
    await writeCharacterState(projectDir, "lin-xiao", { mood: "紧张" });
    const valid = characterStateConfirmBody(projectDir);

    const missingConfirm = await callFoundationGapsRoute("/api/foundation-gaps/confirm-character-write", {
      ...valid,
      explicitConfirm: false,
    });
    const profileTarget = await callFoundationGapsRoute("/api/foundation-gaps/confirm-character-write", {
      ...valid,
      targetFile: "characters/lin-xiao/profile.json",
    });
    const unsafeTarget = await callFoundationGapsRoute("/api/foundation-gaps/confirm-character-write", {
      ...valid,
      targetFile: "../characters/lin-xiao/state.json",
    });
    const forbiddenPatch = await callFoundationGapsRoute("/api/foundation-gaps/confirm-character-write", characterStateConfirmBody(projectDir, {
      statePatch: { mood: "冷静", profile: { name: "blocked" } },
    }));
    const staleBase = await callFoundationGapsRoute("/api/foundation-gaps/confirm-character-write", {
      ...valid,
      baseHash: sha256(stableJson({ mood: "其他状态" })),
    });
    const stalePreview = await callFoundationGapsRoute("/api/foundation-gaps/confirm-character-write", {
      ...valid,
      previewHash: sha256("stale"),
    });

    expect(missingConfirm.statusCode).toBe(400);
    expect(missingConfirm.payload).toMatchObject({ result: { status: "blocked", reason: "missing_explicit_confirm", didWriteCharacterState: false } });
    expect(profileTarget.statusCode).toBe(400);
    expect(profileTarget.payload).toMatchObject({ result: { reason: "target_file_must_be_character_state_only" } });
    expect(unsafeTarget.statusCode).toBe(400);
    expect(unsafeTarget.payload).toMatchObject({ result: { reason: "invalid_target_file" } });
    expect(forbiddenPatch.statusCode).toBe(400);
    expect(String((forbiddenPatch.payload.result as { readonly reason?: string }).reason)).toContain("forbidden_state_patch_keys:profile");
    expect(staleBase.statusCode).toBe(409);
    expect(staleBase.payload).toMatchObject({ result: { reason: "base_hash_mismatch" } });
    expect(stalePreview.statusCode).toBe(409);
    expect(stalePreview.payload).toMatchObject({ result: { reason: "preview_hash_mismatch" } });
    await expect(readJson(projectDir, "characters/lin-xiao/state.json")).resolves.toEqual({ mood: "紧张" });
  });

  it("replays duplicate clicks and blocks idempotency conflicts", async () => {
    projectDir = await createFoundationRouteProject();
    await writeCharacterState(projectDir, "lin-xiao", { mood: "紧张" });
    const body = characterStateConfirmBody(projectDir, {
      idempotencyKey: "same-click",
      statePatch: { mood: "冷静" },
    });

    const first = await callFoundationGapsRoute("/api/foundation-gaps/confirm-character-write", body);
    const replay = await callFoundationGapsRoute("/api/foundation-gaps/confirm-character-write", body);
    const conflict = await callFoundationGapsRoute("/api/foundation-gaps/confirm-character-write", characterStateConfirmBody(projectDir, {
      idempotencyKey: "same-click",
      statePatch: { mood: "愤怒" },
    }));

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.payload).toMatchObject({ result: { idempotencyReplayed: true, changedFiles: ["characters/lin-xiao/state.json"] } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.payload).toMatchObject({ result: { reason: "idempotency_conflict", didWriteCharacterState: false } });
    await expect(readJson(projectDir, "characters/lin-xiao/state.json")).resolves.toMatchObject({ mood: "冷静" });
  });

  it("reports refresh failure separately after a successful character state write", async () => {
    projectDir = await createFoundationRouteProject();
    await writeCharacterState(projectDir, "lin-xiao", { mood: "紧张" });
    buildStateOverview.mockRejectedValueOnce(new Error("refresh failed"));

    const response = await callFoundationGapsRoute("/api/foundation-gaps/confirm-character-write", characterStateConfirmBody(projectDir));

    expect(response.statusCode).toBe(200);
    expect(response.payload).toMatchObject({
      result: {
        status: "committed",
        didWriteCharacterState: true,
        stateOverviewRefreshRequested: true,
        stateOverviewRefreshSucceeded: false,
        stateOverviewRefreshError: "refresh failed",
      },
    });
    await expect(readJson(projectDir, "characters/lin-xiao/state.json")).resolves.toMatchObject({ mood: "冷静" });
  });

  it("rolls back the character state file when post-write bookkeeping fails", async () => {
    projectDir = await createFoundationRouteProject();
    await writeCharacterState(projectDir, "lin-xiao", { mood: "紧张", notes: "原始状态" });
    await writeFile(join(projectDir, ".story-engine-tx"), "blocks transaction directory", "utf-8");

    const response = await callFoundationGapsRoute("/api/foundation-gaps/confirm-character-write", characterStateConfirmBody(projectDir, {
      baseState: { mood: "紧张", notes: "原始状态" },
      statePatch: { mood: "冷静" },
    }));

    expect(response.statusCode).toBe(500);
    expect(response.payload).toMatchObject({
      ok: false,
      result: {
        status: "failed",
        changedFiles: [],
        didWriteCharacterState: false,
        rollbackAttempted: true,
        rollbackSucceeded: true,
      },
    });
    await expect(readJson(projectDir, "characters/lin-xiao/state.json")).resolves.toEqual({ mood: "紧张", notes: "原始状态" });
  });

  it("rolls back newly created character state file by deleting it when bookkeeping fails", async () => {
    projectDir = await createFoundationRouteProject();
    await writeFile(join(projectDir, ".story-engine-tx"), "blocks transaction directory", "utf-8");

    const response = await callFoundationGapsRoute("/api/foundation-gaps/confirm-character-write", characterStateConfirmBody(projectDir, {
      baseState: {},
      statePatch: { mood: "冷静" },
    }));

    expect(response.statusCode).toBe(500);
    expect(response.payload).toMatchObject({
      ok: false,
      result: {
        status: "failed",
        changedFiles: [],
        didWriteCharacterState: false,
        rollbackAttempted: true,
        rollbackSucceeded: true,
        residue: [],
      },
    });
    await expect(access(join(projectDir, "characters", "lin-xiao", "state.json"))).rejects.toThrow();
  });

  // 故障注入确定性版：tempPath 命名确定（targetFile.tmp-sha256(idempotencyKey) 前 12 位），
  // 预先在该处放一个只读文件 → writeFile(临时文件) 必以 EACCES 失败，且留下「待清理」的占位文件。
  // （rename(文件→文件) 无法靠文件系统状态造失败，故故障点选在写临时文件这一步。）
  it.skipIf(process.platform === "win32")("cleans the staged temp file when the character state write fails mid-write", async () => {
    projectDir = await createFoundationRouteProject();
    await writeCharacterState(projectDir, "lin-xiao", { mood: "紧张", notes: "原始状态" });
    const idempotencyKey = "state-confirm-tmp-cleanup";
    const tempPath = join(projectDir, "characters", "lin-xiao", `state.json.tmp-${sha256(idempotencyKey).slice(0, 12)}`);
    await writeFile(tempPath, "occupied", { encoding: "utf-8", mode: 0o444 });

    const response = await callFoundationGapsRoute("/api/foundation-gaps/confirm-character-write", characterStateConfirmBody(projectDir, {
      baseState: { mood: "紧张", notes: "原始状态" },
      idempotencyKey,
      statePatch: { mood: "冷静" },
    }));

    expect(response.statusCode).toBe(500);
    expect(response.payload).toMatchObject({
      ok: false,
      result: {
        status: "failed",
        didWriteCharacterState: false,
        rollbackAttempted: false,
        rollbackSucceeded: null,
      },
    });
    // 写入未发生：旧内容分毫未动，且不留 .tmp- 残渣（残留会被下一次快照扫进 git）。
    await expect(readJson(projectDir, "characters/lin-xiao/state.json")).resolves.toEqual({ mood: "紧张", notes: "原始状态" });
    const residue = (await readdir(join(projectDir, "characters", "lin-xiao"))).filter((entry) => entry.includes(".tmp-"));
    expect(residue).toEqual([]);
  });
});

describe("foundation gap route suggestion drafting", () => {
  it("keeps a single rich character request as one character draft", () => {
    const message = "补一个角色：沈岚，26岁，远山集团公关总监。外貌是黑色短发、银色耳钉、常穿白色西装；性格冷静强势但保护林远；欲望是借林远重新掌控集团舆论；弱点是害怕失控；禁忌是不能提前透露她和董事会旧派有交易。写入角色资料。";
    const intent = __foundationGapsRouteTest.inferFoundationGapChatIntent(message, undefined);

    expect(intent).toBe("create_character");
    expect(__foundationGapsRouteTest.shouldDraftFoundationSchema(message, intent, undefined)).toBe(true);

    const draft = __foundationGapsRouteTest.buildDeterministicSchemaSuggestion(message, intent, undefined);
    const explicit = __foundationGapsRouteTest.buildExplicitFoundationWriteSuggestions(message);

    expect(draft?.actionType).toBe("create_character");
    expect(draft?.targetPath).toBe("characters");
    expect(explicit).toHaveLength(1);

    const after = draft?.after as {
      bibleEntry?: {
        name?: string;
        age?: string;
        identity?: string;
        appearanceAnchors?: readonly string[];
        desire?: string;
        weakness?: string;
        cannotReveal?: readonly string[];
      };
      core?: {
        desire?: string;
        fear?: string;
        weakness?: string;
        behaviorHabits?: readonly string[];
      };
    };
    expect(after.bibleEntry?.name).toBe("沈岚");
    expect(after.bibleEntry?.age).toBe("26");
    expect(after.bibleEntry?.identity).toBe("远山集团公关总监");
    expect(after.bibleEntry?.appearanceAnchors).toEqual(expect.arrayContaining(["黑色短发", "银色耳钉", "常穿白色西装"]));
    expect(after.bibleEntry?.desire).toContain("掌控集团舆论");
    expect(after.bibleEntry?.weakness).toContain("害怕失控");
    expect(after.bibleEntry?.cannotReveal?.[0]).toContain("董事会旧派");
    expect(after.core?.behaviorHabits).toEqual(expect.arrayContaining(["优先从舆论、公关和外部观感角度判断风险。"]));
  });

  it("strips direct-write command words from character names", () => {
    const message = "测试写入角色：请直接新增角色顾青棠，27岁，海港集团法务顾问，外表冷静，擅长合同和董事会规则，当前目标是提醒许澄不要被董事会话术套住。直接写入当前书籍角色资料。";

    const draft = __foundationGapsRouteTest.buildDeterministicSchemaSuggestion(message, "create_character", undefined);
    const explicit = __foundationGapsRouteTest.buildExplicitFoundationWriteSuggestions(message);

    const after = draft?.after as {
      bibleEntry?: {
        name?: string;
        age?: string;
        identity?: string;
      };
    };
    expect(after.bibleEntry?.name).toBe("顾青棠");
    expect(after.bibleEntry?.age).toBe("27");
    expect(after.bibleEntry?.identity).toBe("海港集团法务顾问");
    expect(explicit).toHaveLength(1);
    expect((explicit[0]?.after as { bibleEntry?: { name?: string } }).bibleEntry?.name).toBe("顾青棠");
  });

  it("keeps department lead titles as character identity", () => {
    const message = "测试写入角色：请直接新增角色陆明栖，31岁，海港集团审计部负责人，做事谨慎，掌握旧账线索但不会主动泄密。直接写入当前书籍角色资料。";

    const draft = __foundationGapsRouteTest.buildDeterministicSchemaSuggestion(message, "create_character", undefined);
    const after = draft?.after as {
      bibleEntry?: {
        name?: string;
        identity?: string;
      };
    };

    expect(after.bibleEntry?.name).toBe("陆明栖");
    expect(after.bibleEntry?.identity).toBe("海港集团审计部负责人");
  });

  it("treats explicit character attribute edits as character write suggestions", () => {
    const message = "把陆映身份改成风控合规部专员；和林序关系是提供会议记录线索；行为边界是只提供线索不替主角做决定。写入资料。";

    const explicit = __foundationGapsRouteTest.buildExplicitFoundationWriteSuggestions(message);

    expect(explicit).toHaveLength(1);
    expect(explicit[0]?.actionType).toBe("create_character");

    const after = explicit[0]?.after as {
      bibleEntry?: {
        name?: string;
        identity?: string;
        relationshipToProtagonist?: string;
        behaviorBoundaries?: readonly string[];
      };
    };
    expect(after.bibleEntry?.name).toBe("陆映");
    expect(after.bibleEntry?.identity).toBe("风控合规部专员");
    expect(after.bibleEntry?.relationshipToProtagonist).toBe("提供会议记录线索");
    expect(after.bibleEntry?.behaviorBoundaries).toEqual(["只提供线索不替主角做决定"]);
  });

  it("turns natural protagonist rename into an executable rename suggestion without write/save wording", () => {
    const explicit = __foundationGapsRouteTest.buildExplicitFoundationWriteSuggestions("把主角改成林远吧", {
      protagonistId: "lin-xu",
      protagonistName: "林序",
    });

    expect(explicit).toHaveLength(1);
    expect(explicit[0]).toMatchObject({
      actionType: "rename_character",
      category: "characters",
      targetFile: "story/character-bible.json",
      targetPath: "characters.name",
      targetId: "lin-xu",
      before: "林序",
      after: { name: "林远" },
      extractedEntityName: "林远",
      sourceUserMessage: "把主角改成林远吧",
      writeMode: "replace",
    });
  });

  it("turns natural direct asset, location, world, and writing-rule requests into executable suggestions", () => {
    expect(__foundationGapsRouteTest.buildExplicitFoundationWriteSuggestions("给主角加一辆黑色越野车")).toEqual([
      expect.objectContaining({
        actionType: "create_asset",
        category: "assets",
        targetFile: "story/assets.json",
        targetPath: "assets",
        extractedEntityName: "黑色越野车",
      }),
    ]);
    expect(__foundationGapsRouteTest.buildExplicitFoundationWriteSuggestions("新增一个地点：地下诊所")).toEqual([
      expect.objectContaining({
        actionType: "create_location",
        category: "locations",
        targetFile: "story/location-bible.json",
        targetPath: "locations",
        extractedEntityName: "地下诊所",
      }),
    ]);
    expect(__foundationGapsRouteTest.buildExplicitFoundationWriteSuggestions("把世界观改成末日后第七年")).toEqual([
      expect.objectContaining({
        actionType: "update_world_rule",
        category: "world",
        targetFile: "story/world-bible.json",
      }),
    ]);
    expect(__foundationGapsRouteTest.buildExplicitFoundationWriteSuggestions("以后文风更冷一点，少解释")).toEqual([
      expect.objectContaining({
        actionType: "update_writing_rule",
        category: "writingRules",
        targetFile: "story/writing-rules.json",
      }),
    ]);
  });

  it("turns field-only protagonist facts from chat into executable character detail updates", () => {
    const explicit = __foundationGapsRouteTest.buildExplicitFoundationWriteSuggestions(
      "年龄23吧 职业无 性格闷骚外冷内热，好色 背景刚毕业 人际关系暂无 外貌帅气",
      {
        protagonistId: "guo-xu",
        protagonistName: "林远",
        knownCharacters: [{ id: "guo-xu", name: "林远" }],
      },
    );

    expect(explicit).toEqual([
      expect.objectContaining({
        actionType: "update_character_detail",
        targetId: "guo-xu",
        extractedEntityName: "林远",
        after: expect.objectContaining({
          age: "23岁",
          identity: "无",
        }),
      }),
    ]);
  });

  it("turns concrete world and money-source facts from chat into executable suggestions", () => {
    expect(__foundationGapsRouteTest.buildExplicitFoundationWriteSuggestions("世界观就是现实世界，贴近社会现实，符合实际社会运转")).toEqual([
      expect.objectContaining({
        actionType: "update_world_rule",
        category: "world",
        targetFile: "story/world-bible.json",
      }),
    ]);
    expect(__foundationGapsRouteTest.buildExplicitFoundationWriteSuggestions("城市是虚构的对标上海")).toEqual([
      expect.objectContaining({
        actionType: "update_world_rule",
        category: "world",
        targetFile: "story/world-bible.json",
      }),
    ]);
    expect(__foundationGapsRouteTest.buildExplicitFoundationWriteSuggestions("十亿是父母摊牌实际家里是千亿富翁，给了十个亿资金")).toEqual([
      expect.objectContaining({
        actionType: "create_asset",
        category: "assets",
        targetFile: "story/assets.json",
      }),
    ]);
  });

  it("turns natural existing-character edits into a targeted character detail update", () => {
    const options = {
      protagonistId: "guo-xu",
      protagonistName: "林远",
      knownCharacters: [
        { id: "guo-xu", name: "林远" },
        { id: "lin-xiaowei", name: "苏晓薇" },
      ],
    };

    expect(__foundationGapsRouteTest.buildExplicitFoundationWriteSuggestions("把苏晓薇当前目标改成保护主角", options)).toEqual([
      expect.objectContaining({
        actionType: "update_character_detail",
        category: "characters",
        targetFile: "story/character-bible.json",
        targetPath: "characters",
        targetId: "lin-xiaowei",
        extractedEntityName: "苏晓薇",
        after: expect.objectContaining({
          state: expect.objectContaining({ currentGoal: "保护主角" }),
        }),
      }),
    ]);
    expect(__foundationGapsRouteTest.buildExplicitFoundationWriteSuggestions("林远说话更冷一点", options)).toEqual([
      expect.objectContaining({
        actionType: "update_character_detail",
        targetId: "guo-xu",
        after: expect.objectContaining({ speechStyle: "更冷一点" }),
      }),
    ]);
    expect(__foundationGapsRouteTest.buildExplicitFoundationWriteSuggestions("苏晓薇知道林远真实身份", options)).toEqual([
      expect.objectContaining({
        actionType: "update_character_detail",
        targetId: "lin-xiaowei",
        after: expect.objectContaining({ knowledgeKnown: ["林远真实身份"] }),
      }),
    ]);
  });

  it("keeps a single rich location request as one location draft", () => {
    const message = "补一个地点：远山集团公关部，位于远山集团总部18楼。视觉是玻璃隔间、白色长桌、墙上滚动舆情大屏；声音是键盘声和低声电话；叙事功能是许澄处理舆论危机和董事会压力的战场；风险是旧派董事会能监控这里。写入地点资料。";
    const intent = __foundationGapsRouteTest.inferFoundationGapChatIntent(message, undefined);

    expect(intent).toBe("create_location");
    expect(__foundationGapsRouteTest.shouldDraftFoundationSchema(message, intent, undefined)).toBe(true);

    const draft = __foundationGapsRouteTest.buildDeterministicSchemaSuggestion(message, intent, undefined);
    const explicit = __foundationGapsRouteTest.buildExplicitFoundationWriteSuggestions(message);

    expect(draft?.actionType).toBe("create_location");
    expect(explicit).toHaveLength(1);

    const after = draft?.after as {
      name?: string;
      spatialStructure?: {
        floors?: readonly string[];
        rooms?: readonly string[];
      };
      sensoryDetails?: {
        visual?: readonly string[];
        sound?: readonly string[];
      };
      narrativeFunction?: string;
      risks?: readonly string[];
      hiddenFacts?: readonly string[];
    };
    expect(after.name).toBe("远山集团公关部");
    expect(after.spatialStructure?.floors).toEqual(expect.arrayContaining(["18楼"]));
    expect(after.sensoryDetails?.visual).toEqual(expect.arrayContaining(["玻璃隔间", "白色长桌", "墙上滚动舆情大屏"]));
    expect(after.sensoryDetails?.sound).toEqual(expect.arrayContaining(["键盘声和低声电话"]));
    expect(after.narrativeFunction).toContain("舆论危机");
    expect(after.risks?.[0]).toContain("旧派董事会");
    expect(after.hiddenFacts?.[0]).toContain("监控风险");
  });

  it("keeps labeled location fields separated at Chinese commas", () => {
    const message = "新增地点：海港集团三十二层风控会议室。类型是办公会议室，叙事功能是陆映提供线索，风险是监控和门禁记录。写入资料。";

    const draft = __foundationGapsRouteTest.buildDeterministicSchemaSuggestion(message, "create_location", undefined);

    const after = draft?.after as {
      name?: string;
      type?: string;
      locationType?: string;
      narrativeFunction?: string;
      risks?: readonly string[];
    };
    expect(after.name).toBe("海港集团三十二层风控会议室");
    expect(after.type).toBe("办公会议室");
    expect(after.locationType).toBe("办公会议室");
    expect(after.narrativeFunction).toBe("陆映提供线索");
    expect(after.risks).toEqual(expect.arrayContaining(["监控和门禁记录"]));
  });

  it("extracts basement garage structure from B2 location requests", () => {
    const message = "补地点：远山集团总部地下车库，属于远山集团总部的地下空间，主要是 B2 停车区和集团车辆调度位置，叙事功能是展示集团给林远安排专车司机，也埋下董事会监控和行程安排的压力。";

    const draft = __foundationGapsRouteTest.buildDeterministicSchemaSuggestion(message, "create_location", undefined);

    const after = draft?.after as {
      name?: string;
      spatialStructure?: {
        floors?: readonly string[];
        rooms?: readonly string[];
      };
    };
    expect(after.name).toBe("远山集团总部地下车库");
    expect(after.spatialStructure?.floors).toEqual(expect.arrayContaining(["B2停车区"]));
    expect(after.spatialStructure?.rooms).toEqual(expect.arrayContaining(["地下车库", "车辆调度位置"]));
  });

  it("treats a world-rule request as world data, not asset extraction", () => {
    const message = "补一条世界观规则：海天市上层圈子表面讲秩序和体面，实际由资产、舆论和董事会关系决定话语权；普通人可以看见富人生活，但很难进入核心圈。写入世界观资料。";
    const intent = __foundationGapsRouteTest.inferFoundationGapChatIntent(message, undefined);

    expect(intent).toBe("update_world_rule");
    expect(__foundationGapsRouteTest.shouldDraftFoundationSchema(message, intent, undefined)).toBe(true);

    const draft = __foundationGapsRouteTest.buildDeterministicSchemaSuggestion(message, intent, undefined);

    expect(draft?.actionType).toBe("update_world_rule");
    expect(draft?.category).toBe("world");
    expect(draft?.targetFile).toBe("story/world-bible.json");
    expect(draft?.after).toEqual([expect.stringContaining("海天市上层圈子")]);
    expect(draft?.after).toEqual([expect.not.stringContaining("写入世界观资料")]);
  });

  it("strips short command prefixes from world-rule direct requests", () => {
    const message = "补世界观：海港集团所有关键门禁都会记录刷卡人、时间和楼层，风控部可调取但必须留痕。写入资料。";

    const draft = __foundationGapsRouteTest.buildDeterministicSchemaSuggestion(message, "update_world_rule", undefined);
    const explicit = __foundationGapsRouteTest.buildExplicitFoundationWriteSuggestions(message);

    expect(draft?.after).toEqual(["海港集团所有关键门禁都会记录刷卡人、时间和楼层，风控部可调取但必须留痕"]);
    expect(explicit[0]?.after).toEqual(["海港集团所有关键门禁都会记录刷卡人、时间和楼层，风控部可调取但必须留痕"]);
  });

  it("turns explicit writing-rule requests into writable suggestions", () => {
    const message = "新增写作规则：主角不能靠巧合获得关键证据，必须通过行动交换或观察得到。写入资料。";

    const explicit = __foundationGapsRouteTest.buildExplicitFoundationWriteSuggestions(message);

    expect(explicit).toHaveLength(1);
    expect(explicit[0]?.actionType).toBe("update_writing_rule");
    expect(explicit[0]?.targetFile).toBe("story/writing-rules.json");
    expect(explicit[0]?.targetPath).toBe("doNotDo");
    expect(explicit[0]?.after).toEqual(["主角不能靠巧合获得关键证据，必须通过行动交换或观察得到"]);
  });

  it("turns knowledge-boundary requests into the named character instead of a fake command name", () => {
    const message = "补知识边界：陆映知道会议记录的位置，但不知道蓝色权限卡的来源。写入资料。";

    const draft = __foundationGapsRouteTest.buildDeterministicSchemaSuggestion(message, "update_knowledge_boundary", undefined);
    const explicit = __foundationGapsRouteTest.buildExplicitFoundationWriteSuggestions(message);

    expect(draft?.actionType).toBe("create_character");
    expect(explicit).toHaveLength(1);
    const after = draft?.after as {
      bibleEntry?: {
        name?: string;
        knowledgeKnown?: readonly string[];
        knowledgeUnknown?: readonly string[];
      };
    };
    expect(after.bibleEntry?.name).toBe("陆映");
    expect(after.bibleEntry?.knowledgeKnown).toEqual(["会议记录的位置"]);
    expect(after.bibleEntry?.knowledgeUnknown).toEqual(["蓝色权限卡的来源"]);
  });

  it("keeps a single rich asset request as one asset draft", () => {
    const message = "补一个资产：黑色权限卡，归林远持有，当前位置随身，可打开远山集团总部高层电梯；限制是不能复制，遗失会触发安保记录。写入资产资料。";
    const intent = __foundationGapsRouteTest.inferFoundationGapChatIntent(message, undefined);

    expect(intent).toBe("create_asset");
    expect(__foundationGapsRouteTest.shouldDraftFoundationSchema(message, intent, undefined)).toBe(true);

    const draft = __foundationGapsRouteTest.buildDeterministicSchemaSuggestion(message, intent, undefined);
    const explicit = __foundationGapsRouteTest.buildExplicitFoundationWriteSuggestions(message);

    expect(draft?.actionType).toBe("create_asset");
    expect(explicit).toHaveLength(1);

    const after = draft?.after as {
      name?: string;
      type?: string;
      ownerName?: string;
      currentLocationName?: string;
      carriedByCharacterId?: string;
      rules?: readonly string[];
      usageRules?: readonly string[];
      lossRules?: readonly string[];
    };
    expect(after.name).toBe("黑色权限卡");
    expect(after.type).toBe("keyItem");
    expect(after.ownerName).toBe("林远");
    expect(after.currentLocationName).toBe("随身");
    expect(after.carriedByCharacterId).toBe("林远");
    expect(after.rules).toEqual(expect.arrayContaining(["不能复制", "打开远山集团总部高层电梯"]));
    expect(after.usageRules).toEqual(expect.arrayContaining(["打开远山集团总部高层电梯"]));
    expect(after.lossRules).toEqual(expect.arrayContaining(["不能复制。", "遗失会触发安保记录"]));
  });

  it("does not include 归属 prefix or later risk text in asset fields", () => {
    const message = "新增资产：蓝色权限卡。归属林序，当前位置林序随身，用途是进入风控会议室外走廊，风险是会留下门禁记录。写入资料。";

    const draft = __foundationGapsRouteTest.buildDeterministicSchemaSuggestion(message, "create_asset", undefined);

    const after = draft?.after as {
      name?: string;
      ownerName?: string;
      carriedByCharacterId?: string;
      usageRules?: readonly string[];
    };
    expect(after.name).toBe("蓝色权限卡");
    expect(after.ownerName).toBe("林序");
    expect(after.carriedByCharacterId).toBe("林序");
    expect(after.usageRules).toEqual(["进入风控会议室外走廊"]);
  });

  it("keeps a useful model draft instead of overriding it with deterministic single-entity parsing", () => {
    const message = "补一个角色：沈岚，26岁，远山集团公关总监。外貌是黑色短发、银色耳钉；性格冷静强势但保护林远；写入角色资料。";
    const modelDraft = makeCharacterSuggestion("model-shen-lan", "沈岚", "远山集团舆情危机处理人");

    const resolved = __foundationGapsRouteTest.resolveFoundationChatSuggestions({
      message,
      modelResult: makeModelResult({
        intent: "create_character",
        draftSuggestion: modelDraft,
        focusedSuggestionIds: [modelDraft.id],
      }),
    });

    const after = resolved.draftSuggestion?.after as { bibleEntry?: { appearanceAnchors?: readonly string[]; identity?: string; name?: string } };
    expect(resolved.usedDeterministicDraft).toBe(false);
    expect(resolved.draftSuggestion?.id).toBe(modelDraft.id);
    expect(after.bibleEntry?.name).toBe("沈岚");
    expect(after.bibleEntry?.identity).toBe("远山集团舆情危机处理人");
    expect(after.bibleEntry?.appearanceAnchors).toEqual(expect.arrayContaining(["黑色短发", "银色耳钉"]));
  });

  it("uses deterministic fallback when the model draft is generic and would lose the user's entity", () => {
    const message = "补一个角色：沈岚，26岁，远山集团公关总监。外貌是黑色短发、银色耳钉；性格冷静强势但保护林远；写入角色资料。";
    const genericDraft = makeCharacterSuggestion("model-generic-character", "待定导师", "待确认身份");

    const resolved = __foundationGapsRouteTest.resolveFoundationChatSuggestions({
      message,
      modelResult: makeModelResult({
        intent: "create_character",
        draftSuggestion: genericDraft,
        focusedSuggestionIds: [genericDraft.id],
      }),
    });

    const after = resolved.draftSuggestion?.after as { bibleEntry?: { identity?: string; name?: string } };
    expect(resolved.usedDeterministicDraft).toBe(true);
    expect(resolved.draftSuggestion?.id).not.toBe(genericDraft.id);
    expect(after.bibleEntry?.name).toBe("沈岚");
    expect(after.bibleEntry?.identity).toBe("远山集团公关总监");
  });

  it("does not turn a model-handled query into a write card just because keywords are present", () => {
    const resolved = __foundationGapsRouteTest.resolveFoundationChatSuggestions({
      message: "把世界观目前已有内容列给我看看",
      modelResult: makeModelResult({
        intent: "update_world_rule",
        reply: "当前世界观已有城市阶层、集团权力和门禁留痕规则。",
      }),
    });

    expect(resolved.usedDeterministicDraft).toBe(false);
    expect(resolved.draftSuggestion).toBeUndefined();
    expect(resolved.generatedSuggestions).toHaveLength(0);
    expect(resolved.explicitSuggestions).toHaveLength(0);
  });
});

type TestModelResult = {
  readonly reply: string;
  readonly intent?: FoundationGapSuggestion["actionType"];
  readonly askedQuestions: readonly string[];
  readonly draftSuggestion?: FoundationGapSuggestion;
  readonly missingFields: readonly string[];
  readonly focusedCategory?: FoundationGapSuggestion["category"];
  readonly focusedGapIds: readonly string[];
  readonly focusedSuggestionIds: readonly string[];
  readonly generatedSuggestions: readonly FoundationGapSuggestion[];
  readonly suggestedActions: readonly { readonly id: string; readonly label: string }[];
  readonly safetyWarnings: readonly string[];
};

function makeModelResult(overrides: Partial<TestModelResult> = {}): TestModelResult {
  return {
    reply: "已整理。",
    askedQuestions: [],
    missingFields: [],
    focusedGapIds: [],
    focusedSuggestionIds: [],
    generatedSuggestions: [],
    suggestedActions: [],
    safetyWarnings: [],
    ...overrides,
  };
}

function makeCharacterSuggestion(id: string, name: string, identity: string): FoundationGapSuggestion {
  return {
    id,
    gapId: "ai-gap-test-character",
    category: "characters",
    actionType: "create_character",
    targetFile: "story/character-bible.json",
    targetPath: "characters",
    targetId: `char-${id}`,
    before: undefined,
    after: {
      bibleEntry: {
        id: `char-${id}`,
        name,
        role: "重要角色",
        age: "26",
        gender: "女",
        identity,
      },
    },
    rationale: "测试模型草案。",
    risk: "warning",
    requiresUserConfirm: true,
  };
}

async function createFoundationRouteProject(): Promise<string> {
  const root = await makeHomeTempDir("story-engine-ui-foundation-route-");
  await Promise.all([
    mkdir(join(root, "characters"), { recursive: true }),
    mkdir(join(root, "story"), { recursive: true }),
    mkdir(join(root, "timeline"), { recursive: true }),
    mkdir(join(root, "world"), { recursive: true }),
  ]);
  await writeFile(join(root, "project.json"), `${JSON.stringify({ title: "Foundation Route Test" }, null, 2)}\n`, "utf-8");
  return root;
}

async function writeCharacterState(projectDir: string, characterId: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(join(projectDir, "characters", characterId), { recursive: true });
  await writeFile(join(projectDir, "characters", characterId, "state.json"), `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function readJson(projectDir: string, relativePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(projectDir, relativePath), "utf-8")) as Record<string, unknown>;
}

function characterStateConfirmBody(
  projectDir: string,
  overrides: {
    readonly baseState?: Record<string, unknown>;
    readonly idempotencyKey?: string;
    readonly statePatch?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  const characterId = "lin-xiao";
  const targetFile = "characters/lin-xiao/state.json";
  const baseState = overrides.baseState ?? { mood: "紧张" };
  const statePatch = overrides.statePatch ?? { mood: "冷静" };
  return {
    projectPath: projectDir,
    characterId,
    targetFile,
    previewHash: sha256(stableJson({
      characterId,
      targetFile,
      suggestionIds: ["suggestion-state-1"],
      statePatch,
    })),
    baseHash: sha256(stableJson(baseState)),
    idempotencyKey: overrides.idempotencyKey ?? "state-confirm-1",
    explicitConfirm: true,
    suggestionIds: ["suggestion-state-1"],
    statePatch,
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf-8").digest("hex");
}

async function callFoundationGapsRoute(
  path: string,
  body?: Record<string, unknown> | string,
  method: "GET" | "POST" = "POST",
): Promise<{
  readonly statusCode: number;
  readonly payload: Record<string, unknown>;
}> {
  const handlers: Middleware[] = [];
  registerFoundationGapsRoutes({ use: (handler) => handlers.push(handler) });
  const rawBody = typeof body === "string" ? body : body ? JSON.stringify(body) : "";
  const req = Object.assign(Readable.from(rawBody ? [Buffer.from(rawBody)] : []), {
    method,
    url: path,
  }) as IncomingMessage;
  const chunks: Buffer[] = [];
  const res = {
    statusCode: 200,
    setHeader: (name: string, value: string | number | readonly string[]) => {
      void name;
      void value;
      return res as unknown as ServerResponse;
    },
    end: (chunk?: string | Buffer) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return res as unknown as ServerResponse;
    },
  } as unknown as ServerResponse;

  await new Promise<void>((resolve, reject) => {
    const result = handlers[0]?.(req, res, (error?: unknown) => error ? reject(error) : resolve()) as unknown;
    Promise.resolve(result).then(() => resolve(), reject);
  });

  const payload = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>;
  return { statusCode: res.statusCode, payload };
}
