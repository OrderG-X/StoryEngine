// @vitest-environment node
/**
 * 挑 AI 稿（写作版本 P2a 片 2D）：draft.adopt / draft.discard 只认按钮、核候选号 + 指纹 + 作者眼前那份的版本，
 * 换上存档可撤销、处理过的立墓碑；一次写几版时落选的、作者要自己挑的都留成候选，不上稿纸提示条。
 * 真配方、真执行器、真核心写盘，只换模型。
 */
import { randomUUID } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { draftSave, readDraft, readDraftState, readTruthBasis, runCommand } from "@actalk/story-core";
import { createStoryProject } from "../../../book/project-store.js";
import { __resetCatchUpLocksForTests } from "../../../editorial/reader-window.js";
import { draftSha, pendingDraftFor, readDraftCandidate, saveDraftCandidate } from "../../../lib/draft-candidates.js";
import { makeHomeTempDir } from "../../../lib/home-test-tmp.js";
import { __resetExecutionsForTests } from "../../../lib/operations/context.js";
import { __resetLiveForTests } from "../../../lib/operations/live.js";
import { __resetOperationStoreForTests, type OperationRecord } from "../../../lib/operations/store.js";
import { listSnapshots } from "../../../lib/snapshot.js";
import type { KeptVersion } from "../../draft-change/steps.js";
import { __drainOperationsForTests, __resetRecipesForTests, registerRecipe, submitOperation } from "../executor.js";
import { draftAdoptRecipe, draftDiscardRecipe } from "./draft-candidate.js";
import { fakeDraftDeps, settledDraftChange, submitDraftChange } from "./draft-change-kit.js";
import type { DraftChangeDeps } from "./draft-change.js";

let root: string;
let book: string;

beforeEach(async () => {
  __resetOperationStoreForTests();
  __resetExecutionsForTests();
  __resetLiveForTests();
  __resetRecipesForTests();
  __resetCatchUpLocksForTests();
  root = await makeHomeTempDir("draft-candidate-");
  vi.stubEnv("SE_DATA_DIR", join(root, "data"));
  ({ projectDir: book } = await createStoryProject({ rootDir: root, title: "挑一版", genre: "都市", protagonistName: "林远" }));
});
afterEach(async () => {
  await __drainOperationsForTests();
  __resetRecipesForTests();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

const prose = (line: string): string =>
  Array(6).fill(`${line}林远沿着河岸走了很久，手里的账册越攥越紧。他还记得早上的约定，却不知道对方为什么迟迟没有露面。巷子尽头有人推开门，朝他招了招手。`).join("\n\n");

async function save(chapter: number, body: string, title = ""): Promise<string> {
  const baseVersion = (await readDraftState(book, chapter)).version;
  const outcome = await runCommand(book, draftSave, { chapter, body, baseVersion, title }, { caller: "author" });
  if (!outcome.ok) throw new Error(outcome.message);
  return outcome.result.version;
}

/** 写手每调一次回下一版（第 n 版的开头写着「第n版」）；记下每次拿到的章纲方向。 */
function versionWriters(): { readonly deps: DraftChangeDeps; readonly calls: () => number } {
  let n = 0;
  return {
    calls: () => n,
    deps: {
      ...fakeDraftDeps(),
      writer: async () => {
        n += 1;
        const which = n;
        return { async generateDraft() { return { content: prose(`第${which}版的开头。`) }; } };
      },
    },
  };
}

type DecisionKind = "draft.adopt" | "draft.discard";

/** 交一次换上 / 不要了，等它跑完。 */
async function decide(kind: DecisionKind, params: Record<string, unknown>, origin: "button" | "chat" = "button"): Promise<{ readonly ok: boolean; readonly record?: OperationRecord; readonly code?: string; readonly message?: string }> {
  registerRecipe(draftAdoptRecipe);
  registerRecipe(draftDiscardRecipe);
  const outcome = await submitOperation(book, { kind, params, requestKey: randomUUID(), issuedAt: new Date().toISOString(), origin: { kind: origin, chapter: Number(params.chapter) || undefined } });
  if (!outcome.ok) return { ok: false, code: outcome.code, message: outcome.message };
  if (!("record" in outcome)) throw new Error("回了墓碑");
  return { ok: true, record: await settledDraftChange(book, outcome.record.opId) };
}

const summaryOf = (record?: OperationRecord): string => String((record?.result as { summary?: unknown } | undefined)?.summary ?? "");

/** 写一次几版（作者自己挑 / 选优），拿回留下的几版。 */
async function writeVersions(params: Record<string, unknown>): Promise<{ readonly record: OperationRecord; readonly versions: readonly Extract<KeptVersion, { sha: string }>[]; readonly calls: number }> {
  const { deps, calls } = versionWriters();
  const outcome = await submitDraftChange(book, "write", params, deps);
  if (!outcome.ok || !("record" in outcome)) throw new Error(`没受理：${JSON.stringify(outcome)}`);
  const record = await settledDraftChange(book, outcome.record.opId);
  const body = (record.result as { body?: { otherVersions?: readonly KeptVersion[] } } | undefined)?.body;
  const versions = (body?.otherVersions ?? []).filter((version): version is Extract<KeptVersion, { sha: string }> => "sha" in version);
  return { record, versions, calls: calls() };
}

describe("作者自己挑（AI 另写几版）", () => {
  it("写两版都留成候选，一版都不换上；作者的稿子不动、稿纸上不提示；结果说清写了几版", async () => {
    await save(1, "作者自己写的稿。", "作者的章名");
    const { record, versions, calls } = await writeVersions({ chapter: 1, candidates: 2, pick: "author" });
    expect(record.state).toBe("succeeded");
    expect(calls).toBe(2);
    expect(versions.map((version) => version.index)).toEqual([1, 2]);
    expect(summaryOf(record)).toContain("另写了 2 版");
    expect(record.result).toMatchObject({ body: { kind: "draft.change", pick: "author", ok: false, chapter: 1 } });
    expect(await readDraft(book, 1)).toMatchObject({ title: "作者的章名", body: "作者自己写的稿。" });
    for (const version of versions) {
      // 写手没起名：章名是开写时作者的那个（候选是整份稿，第 14 轮复核 AB3）。
      expect(version.title).toBe("作者的章名");
      expect(await readDraftCandidate(book, version.candidateId)).toMatchObject({ reason: "author_pick", chapter: 1 });
    }
    expect(await pendingDraftFor(book, 1)).toBeUndefined();
  });

  it("没说方向：照这一章现有章纲的方向另写（长篇实跑第 16 章：另写几版不该丢了作者定过的方向）", async () => {
    const first = await writeVersions({ chapter: 1, direction: "林远去河岸等人" });
    expect(first.record.state).toBe("succeeded");
    await save(1, "作者改过的稿。");
    const { record } = await writeVersions({ chapter: 1, candidates: 2, pick: "author" });
    expect(record.state).toBe("succeeded");
    expect(record.params).toMatchObject({ chapter: 1, pick: "author", direction: "林远去河岸等人" });
    expect((await readDraft(book, 1))?.body).toBe("作者改过的稿。");
  });

  it("挑一版换上：存档、可撤销，这一版立墓碑；同一版再换一次如实说处理过了", async () => {
    const base = await save(1, "作者自己写的稿。");
    const { versions } = await writeVersions({ chapter: 1, candidates: 2, pick: "author" });
    const second = versions[1]!;
    const before = (await listSnapshots(book)).length;
    const adopted = await decide("draft.adopt", { chapter: 1, candidateId: second.candidateId, sha: second.sha, baseVersion: base });
    expect(adopted.record?.state).toBe("succeeded");
    expect(summaryOf(adopted.record)).toContain("换上了 AI 这一版");
    expect((await readDraft(book, 1))?.body).toBe(second.body);
    expect((await listSnapshots(book)).slice(0, -before).map((snapshot) => snapshot.label)).toContain("换上 AI 稿：第1章");
    expect(await readDraftCandidate(book, second.candidateId)).toMatchObject({ status: "handled", body: "" });
    // 另一版还留着。
    expect(await readDraftCandidate(book, versions[0]!.candidateId)).toMatchObject({ reason: "author_pick", body: versions[0]!.body });

    const again = await decide("draft.adopt", { chapter: 1, candidateId: second.candidateId, sha: second.sha, baseVersion: (await readDraftState(book, 1)).version });
    expect(again.record?.state).toBe("obsolete");
    expect(again.record?.failure?.message).toContain("处理过了");
  });
});

describe("一次写几版、选优换上一版", () => {
  it("落选的那版留成候选（另外几版），不上稿纸提示条；点它换上", async () => {
    const { record, versions } = await writeVersions({ chapter: 1, candidates: 2 });
    expect(record.state).toBe("succeeded");
    expect(versions).toHaveLength(1);
    const loser = versions[0]!;
    expect(await readDraftCandidate(book, loser.candidateId)).toMatchObject({ reason: "other_version" });
    expect(await pendingDraftFor(book, 1)).toBeUndefined();
    const chosen = (await readDraft(book, 1))!;
    expect(chosen.body).not.toBe(loser.body);

    const adopted = await decide("draft.adopt", { chapter: 1, candidateId: loser.candidateId, sha: loser.sha, baseVersion: chosen.version });
    expect(adopted.record?.state).toBe("succeeded");
    expect((await readDraft(book, 1))?.body).toBe(loser.body);
  });
});

describe("换上：对不上就不换，作者那份不动", () => {
  async function aCandidate(title: string): Promise<{ readonly id: string; readonly sha: string }> {
    const candidate = await saveDraftCandidate(book, { chapter: 1, title, body: "AI 稿。", baseVersion: null, basisDigest: (await readTruthBasis(book)).digest, source: "draft", status: "ready", reason: "draft_moved" });
    return { id: candidate.id, sha: draftSha(candidate) };
  }

  it("对话 AI 交的不受理（只认按钮）；缺指纹的按钮不受理", async () => {
    const version = await save(1, "作者稿。");
    const candidate = await aCandidate("");
    const chat = await decide("draft.adopt", { chapter: 1, candidateId: candidate.id, sha: candidate.sha, baseVersion: version }, "chat");
    expect(chat).toMatchObject({ ok: false, code: "author_only" });
    const noSha = await decide("draft.discard", { chapter: 1, candidateId: candidate.id });
    expect(noSha).toMatchObject({ ok: false, code: "bad_params" });
    expect(await readDraftCandidate(book, candidate.id)).toMatchObject({ body: "AI 稿。" });
    expect((await readDraft(book, 1))?.body).toBe("作者稿。");
  });

  it("作者看过之后稿子又改了：不换（obsolete），候选留着", async () => {
    const seen = await save(1, "作者稿。");
    const candidate = await aCandidate("");
    await save(1, "作者又改了一句。");
    const moved = await decide("draft.adopt", { chapter: 1, candidateId: candidate.id, sha: candidate.sha, baseVersion: seen });
    expect(moved.record?.state).toBe("obsolete");
    expect(moved.record?.failure?.message).toContain("又改过了");
    expect((await readDraft(book, 1))?.body).toBe("作者又改了一句。");
    expect(await readDraftCandidate(book, candidate.id)).toMatchObject({ body: "AI 稿。" });
  });

  it("那一版这期间变过了（指纹对不上）：不换", async () => {
    const version = await save(1, "作者稿。");
    const candidate = await aCandidate("");
    const changed = await decide("draft.adopt", { chapter: 1, candidateId: candidate.id, sha: "f".repeat(64), baseVersion: version });
    expect(changed.record?.state).toBe("obsolete");
    expect(changed.record?.failure?.message).toContain("变过了");
    expect((await readDraft(book, 1))?.body).toBe("作者稿。");
  });

  it.each([
    { label: "没章名", title: "", expected: undefined },
    { label: "自己的章名", title: "AI 起的章名", expected: "AI 起的章名" },
  ])("AB3：候选（$label）换上时照它自己的章名，不夹带盘上后来的章名", async ({ title, expected }) => {
    await save(1, "作者原稿。", "作者旧章名");
    const candidate = await aCandidate(title);
    const now = await save(1, "作者后来改的稿。", "作者后来改的章名");
    const adopted = await decide("draft.adopt", { chapter: 1, candidateId: candidate.id, sha: candidate.sha, baseVersion: now });
    expect(adopted.record?.state).toBe("succeeded");
    expect(await readDraft(book, 1)).toMatchObject({ body: "AI 稿。" });
    expect((await readDraft(book, 1))?.title).toBe(expected);
  });
});

describe("不要了", () => {
  it("指纹对得上才清（立了墓碑、稿子不动）；再点一次算成；变过了不清", async () => {
    await save(1, "作者稿。");
    const basisDigest = (await readTruthBasis(book)).digest;
    const input = { chapter: 1, body: "候选正文。", baseVersion: null, basisDigest, source: "draft" as const, status: "ready" as const };
    const candidate = await saveDraftCandidate(book, { ...input, title: "看到的旧名" });
    const seenSha = draftSha(candidate);
    // AB4：作者看到之后那份又更新了（同号），按旧指纹不删。
    await saveDraftCandidate(book, { ...input, id: candidate.id, title: "后来更新的新名" });
    const stale = await decide("draft.discard", { chapter: 1, candidateId: candidate.id, sha: seenSha });
    expect(stale.record?.state).toBe("obsolete");
    expect(await readDraftCandidate(book, candidate.id)).toMatchObject({ title: "后来更新的新名" });

    const fresh = draftSha((await readDraftCandidate(book, candidate.id))!);
    const dropped = await decide("draft.discard", { chapter: 1, candidateId: candidate.id, sha: fresh });
    expect(dropped.record?.state).toBe("succeeded");
    expect(summaryOf(dropped.record)).toContain("不要了");
    expect(await readDraftCandidate(book, candidate.id)).toBeUndefined();
    const twice = await decide("draft.discard", { chapter: 1, candidateId: candidate.id, sha: fresh });
    expect(twice.record?.state).toBe("succeeded");
    expect(summaryOf(twice.record)).toContain("处理过了");
    expect((await readDraft(book, 1))?.body).toBe("作者稿。");
  });
});

describe("只有一条路换上 AI 稿（源码检查）", () => {
  it("核心 draft.adoptCandidate 只在 lib/candidate-adopt.ts（AI 候选，操作里）和 routes/working-draft.ts（作者自己的恢复稿）调；没有 /api/draft/ 路由", async () => {
    const server = join(dirname(fileURLToPath(import.meta.url)), "../../..");
    const files = (await readdir(server, { recursive: true }))
      .filter((file) => file.endsWith(".ts") && !file.includes(".test."))
      .map((file) => join(server, file));
    const callers: string[] = [];
    const routes: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf-8");
      if (/\bdraftAdoptCandidate\b/u.test(text)) callers.push(relative(server, file));
      if (/["'`]\/api\/draft\//u.test(text)) routes.push(relative(server, file));
    }
    expect(callers.sort()).toEqual(["lib/candidate-adopt.ts", "routes/working-draft.ts"]);
    expect(routes).toEqual([]);
  });
});
