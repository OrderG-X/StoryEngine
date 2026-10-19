// @vitest-environment node
//
// task-assignments 旁路存储单测：任务→{profileId, thinking} 映射，引擎零改下存 UI 侧文件。
// ENOENT→走默认(corrupt:false)、坏 JSON→corrupt:true 且不覆盖、思考默认开。
import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  TASK_ASSIGNMENT_KEYS,
  taskAssignmentsPath,
  readTaskAssignments,
  writeTaskAssignments,
  resolveTaskThinking,
  resolveTaskProfileId,
  buildTaskAssignmentsView,
  pickTaskAssignmentsFromBody,
  engineProfileFallback,
  type TaskAssignmentsFile,
} from "./task-assignments.js";

async function home(): Promise<string> {
  return mkdtemp(join(tmpdir(), "task-assign-"));
}
const FILE: TaskAssignmentsFile = { version: 1, tasks: { fastDraft: { profileId: "p1", thinking: false } } };

describe("task-assignments 旁路存储", () => {
  it("6 个任务 key、不含 futureReview 和已删的 enrichment", () => {
    expect(TASK_ASSIGNMENT_KEYS).toEqual([
      "fastDraft", "triage", "repair", "chapterSteering", "draftReview", "qualityCheck",
    ]);
    expect(TASK_ASSIGNMENT_KEYS).not.toContain("futureReview");
    expect(TASK_ASSIGNMENT_KEYS).not.toContain("enrichment");
  });

  it("文件不存在 → {file:null, corrupt:false}（走默认、不报损坏）", async () => {
    const h = await home();
    expect(await readTaskAssignments(h)).toEqual({ file: null, corrupt: false });
  });

  it("写入后能读回", async () => {
    const h = await home();
    await writeTaskAssignments(h, FILE);
    const { file } = await readTaskAssignments(h);
    expect(file?.tasks.fastDraft).toEqual({ profileId: "p1", thinking: false });
  });

  it("坏 JSON → {file:null, corrupt:true}，且不覆盖原文件", async () => {
    const h = await home();
    await mkdir(join(h, ".story-engine"), { recursive: true });
    await writeFile(taskAssignmentsPath(h), "{ 坏的", "utf-8");
    expect(await readTaskAssignments(h)).toEqual({ file: null, corrupt: true });
    expect(await readFile(taskAssignmentsPath(h), "utf-8")).toBe("{ 坏的"); // 没被动
  });

  it("resolveTaskThinking 默认开（null 或缺该任务都返回 true）", () => {
    expect(resolveTaskThinking(null, "fastDraft")).toBe(true);
    expect(resolveTaskThinking(FILE, "draftReview")).toBe(true);
    expect(resolveTaskThinking(FILE, "fastDraft")).toBe(false);
  });

  it("resolveTaskProfileId 无配置返回 undefined（调用方回退引擎）", () => {
    expect(resolveTaskProfileId(null, "fastDraft")).toBeUndefined();
    expect(resolveTaskProfileId(FILE, "fastDraft")).toBe("p1");
  });
});

describe("buildTaskAssignmentsView 合成 7 任务视图（旁路 + engineProfileFallback 同口径 + 默认开）", () => {
  it("旁路覆盖 fastDraft；未配置走 engineProfileFallback（与运行时同口径）；全缺则 defaultProfile；thinking 默认开", () => {
    const engineTp = { fastDraft: "p-draft", chapterSteering: "p-steer", qualityCheck: "p-q" };
    const file: TaskAssignmentsFile = { version: 1, tasks: { fastDraft: { profileId: "p-mini", thinking: false } } };
    const view = buildTaskAssignmentsView(engineTp, "p-default", file);
    expect(view.fastDraft).toEqual({ profileId: "p-mini", thinking: false }); // 旁路覆盖
    expect(view.qualityCheck).toEqual({ profileId: "p-q", thinking: true });
    expect(view.chapterSteering).toEqual({ profileId: "p-steer", thinking: true });
    expect(view.triage.profileId).toBe("p-q"); // triage→qualityCheck（与运行时同口径，治「展示≠真用」）
    expect(view.draftReview.profileId).toBe("p-q"); // draftReview→qualityCheck
    expect(view.draftReview.thinking).toBe(true);
    expect(Object.keys(view).sort()).toEqual([...TASK_ASSIGNMENT_KEYS].sort()); // 6 个 key 都在

    // 引擎全缺相关键 → defaultProfile
    const sparse = buildTaskAssignmentsView({ fastDraft: "p-draft" }, "p-default", null);
    expect(sparse.triage.profileId).toBe("p-default");
  });
});

describe("pickTaskAssignmentsFromBody 只收 7 个合法 key（profileId 可省、thinking 独立保住）", () => {
  it("过滤非法 key；thinking-only（无模型）也收；thinking 默认 true", () => {
    const picked = pickTaskAssignmentsFromBody({
      taskAssignments: {
        fastDraft: { profileId: "p1", thinking: false },
        bogus: { profileId: "x" }, // 非法 key → 丢
        triage: { thinking: false }, // 无 profileId 但只关思考 → 必须保住（治静默丢弃）
        repair: { profileId: "p2" }, // 无 thinking → 默认 true
      },
    });
    expect(picked?.tasks.fastDraft).toEqual({ profileId: "p1", thinking: false });
    expect(picked?.tasks.repair).toEqual({ profileId: "p2", thinking: true });
    expect(picked?.tasks.triage).toEqual({ thinking: false }); // thinking-only 保住、无 profileId
    expect((picked?.tasks as Record<string, unknown>).bogus).toBeUndefined();
  });

  it("无 taskAssignments → null", () => {
    expect(pickTaskAssignmentsFromBody({})).toBeNull();
  });
});

describe("engineProfileFallback 任务回退链（运行时与面板同口径）", () => {
  it("先用任务自己的引擎配置，缺了才跨任务回退", () => {
    const full = { fastDraft: "fd", chapterSteering: "cs", qualityCheck: "qc", repair: "rp", draftReview: "dr", triage: "tr" };
    expect(engineProfileFallback(full, "fastDraft")).toBe("fd"); // 普通任务=自己
    expect(engineProfileFallback(full, "draftReview")).toBe("dr"); // 自己有就用自己
    // 缺自己时跨任务回退
    expect(engineProfileFallback({ qualityCheck: "qc", chapterSteering: "cs" }, "draftReview")).toBe("qc");
    expect(engineProfileFallback({ qualityCheck: "qc" }, "triage")).toBe("qc");
    expect(engineProfileFallback({ draftReview: "dr" }, "repair")).toBe("dr");
    // 全缺 → undefined
    expect(engineProfileFallback({}, "triage")).toBeUndefined();
  });
});
