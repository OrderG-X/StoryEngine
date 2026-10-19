/**
 * task-assignments — UI 侧旁路存储：任务 → { 用哪个模型档案 profileId, 开不开思考 thinking }。
 *
 * 为什么单独一个文件、不并进引擎的 model-settings.json：引擎 model-settings schema 在 normalize 时
 * 只保留它认识的字段、丢弃未知字段（thinking 塞进 profile 会被吃掉），且对未知 task key 只发 warning。
 * 「引擎包零改」是铁律 → 把「任务→{档案,思考}」整张映射存在引擎看不到的 UI 旁路文件
 * （~/.story-engine/task-assignments.json），由 UI 自己读写、合成进 resolveConfiguredChatModel。
 *
 * 默认开（向后兼容）：旁路文件缺失 / 某任务无配置 → thinking=true、profileId=undefined（调用方回退引擎）。
 * 坏 JSON 不当空：解析失败返回 corrupt:true 用默认，绝不覆盖用户文件（「坏 JSON 不当空」模式）。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveGlobalDataDirFor } from "./data-dirs.js";

export interface TaskAssignment {
  /** 该任务指定的模型档案 id；省略=没显式选模型、走引擎回退。思考开关独立于它。 */
  readonly profileId?: string;
  readonly thinking: boolean;
}

export interface TaskAssignmentsFile {
  readonly version: 1;
  readonly tasks: Readonly<Record<string, TaskAssignment>>;
}

/** 面板可分配的 6 个任务类型（已删 futureReview 死槽；做厚工具删了，enrichment 槽也删了，重构 P9）。 */
export const TASK_ASSIGNMENT_KEYS = [
  "fastDraft", "triage", "repair", "chapterSteering", "draftReview", "qualityCheck",
] as const;

export type TaskAssignmentKey = (typeof TASK_ASSIGNMENT_KEYS)[number];

export function taskAssignmentsPath(homeDir: string): string {
  return join(resolveGlobalDataDirFor(homeDir), "task-assignments.json");
}

/**
 * 读旁路文件。区分三态：
 * - 文件不存在（ENOENT 等读失败）→ { file:null, corrupt:false }（走默认，不报损坏）。
 * - 解析成功 → { file, corrupt:false }。
 * - 解析失败（坏 JSON）→ { file:null, corrupt:true }（用默认、绝不覆盖用户文件）。
 */
export async function readTaskAssignments(
  homeDir: string,
): Promise<{ readonly file: TaskAssignmentsFile | null; readonly corrupt: boolean }> {
  let text: string;
  try {
    text = await readFile(taskAssignmentsPath(homeDir), "utf-8");
  } catch {
    return { file: null, corrupt: false }; // 无文件 → 走默认
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null) return { file: null, corrupt: true };
    const tasksRaw = (parsed as { tasks?: unknown }).tasks;
    const tasks: Record<string, TaskAssignment> = {};
    if (tasksRaw && typeof tasksRaw === "object") {
      for (const [key, value] of Object.entries(tasksRaw as Record<string, unknown>)) {
        if (value && typeof value === "object") {
          const pid = (value as { profileId?: unknown }).profileId;
          const think = (value as { thinking?: unknown }).thinking;
          // 思考与模型两个旋钮独立：profileId 可省（只关思考、没显式选模型也要保住）。thinking 默认开。
          tasks[key] = {
            thinking: think !== false,
            ...(typeof pid === "string" && pid.trim() ? { profileId: pid } : {}),
          };
        }
      }
    }
    return { file: { version: 1, tasks }, corrupt: false };
  } catch {
    return { file: null, corrupt: true }; // 坏 JSON：用默认、绝不覆盖
  }
}

export async function writeTaskAssignments(homeDir: string, file: TaskAssignmentsFile): Promise<void> {
  await mkdir(resolveGlobalDataDirFor(homeDir), { recursive: true });
  await writeFile(taskAssignmentsPath(homeDir), `${JSON.stringify(file, null, 2)}\n`, "utf-8");
}

/** 思考开关：旁路有配置就用它，否则默认开（向后兼容、不破现有书）。 */
export function resolveTaskThinking(file: TaskAssignmentsFile | null, task: string): boolean {
  return file?.tasks[task]?.thinking ?? true;
}

/** 任务指定的模型档案 id；无配置返回 undefined（调用方回退引擎 taskProfiles）。 */
export function resolveTaskProfileId(file: TaskAssignmentsFile | null, task: string): string | undefined {
  return file?.tasks[task]?.profileId;
}

/**
 * 引擎 taskProfiles 的任务回退链（唯一真值源）：resolveConfiguredChatModel 与 buildTaskAssignmentsView 共用，
 * 保证「面板展示用哪个模型」与「运行时实际解析用哪个模型」同口径（受控破例④精神，治审查 #1/#4 双实现漂移）。
 */
export function engineProfileFallback(
  tp: Readonly<Record<string, string | undefined>>,
  task: string,
): string | undefined {
  // 先用任务自己的引擎配置，没有再跨任务回退（与旧 resolveConfiguredChatModel 的 `tp[task] ?? fallback` 等价）。
  switch (task) {
    case "draftReview": return tp.draftReview ?? tp.qualityCheck ?? tp.chapterSteering;
    case "repair": return tp.repair ?? tp.draftReview ?? tp.qualityCheck;
    case "triage": return tp.triage ?? tp.qualityCheck ?? tp.chapterSteering;
    default: return tp[task];
  }
}

/**
 * 合成「6 任务 → {profileId, thinking}」视图，供设置面板 GET 展示。
 * profileId 解析顺序：旁路 → engineProfileFallback（与运行时同口径）→ defaultProfile → ""。
 * thinking：旁路有则用，否则默认开。
 */
export function buildTaskAssignmentsView(
  engineTaskProfiles: Readonly<Record<string, string | undefined>>,
  defaultProfile: string | undefined,
  file: TaskAssignmentsFile | null,
): Record<TaskAssignmentKey, TaskAssignment> {
  const view = {} as Record<TaskAssignmentKey, TaskAssignment>;
  for (const task of TASK_ASSIGNMENT_KEYS) {
    const profileId = resolveTaskProfileId(file, task) ?? engineProfileFallback(engineTaskProfiles, task) ?? defaultProfile ?? "";
    view[task] = { profileId, thinking: resolveTaskThinking(file, task) };
  }
  return view;
}

/**
 * 从面板 PUT body 抽出 taskAssignments，只收 7 个合法 key；thinking 默认 true，profileId 可省
 * （只关思考、没显式选模型也要落盘——治审查 important：纯切思考被静默丢弃）。无 taskAssignments 字段 → null。
 */
export function pickTaskAssignmentsFromBody(body: unknown): TaskAssignmentsFile | null {
  if (typeof body !== "object" || body === null) return null;
  const raw = (body as { taskAssignments?: unknown }).taskAssignments;
  if (typeof raw !== "object" || raw === null) return null;
  const tasks: Record<string, TaskAssignment> = {};
  for (const task of TASK_ASSIGNMENT_KEYS) {
    const value = (raw as Record<string, unknown>)[task];
    if (value && typeof value === "object") {
      const pid = (value as { profileId?: unknown }).profileId;
      const think = (value as { thinking?: unknown }).thinking;
      tasks[task] = {
        thinking: think !== false,
        ...(typeof pid === "string" && pid.trim() ? { profileId: pid } : {}),
      };
    }
  }
  return { version: 1, tasks };
}
