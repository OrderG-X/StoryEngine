/**
 * 作者文风样本的核心逻辑（story/writing-rules.json 的 styleExemplars 数组）：
 * add / list / update / remove 四个动作的纯逻辑 manageStyleExemplarsLogic。
 *
 * 2026-10-12 编辑部 R3b 起，独立工具 manage_style_exemplars 并入 foundation_write
 * （actionType=style_exemplar_*，见 foundation-write.ts 的 applyStyleExemplarLogic——快照/撤销/
 * list 只读不建快照的语义由 foundation_write 的 writeTool 包装承接）；本文件只留这份可单测的纯逻辑。
 *
 * 文风样本是写正文的正向锚：存进后每章写正文都会喂给模型（模仿句法节奏、用词偏好与叙事温度，
 * 不得照抄样本内容）。引擎侧限额：最多 5 条、单条正文 ≤2000 字——超限如实拒绝，不截断硬塞。
 *
 * 铁律：
 * - 绝不静默失败 / 绝不谎报：ok 字段如实回报；坏输入（空标题/空正文/超长/超 5 条/目标没找到）
 *   一律 ok:false + 原因，绝不假装写入。
 * - 绝不泄露裸 id：summary 只用样本标题；id 只在 exemplars 结构里供 agent 定位用。
 * - 读取防御：writing-rules.json 可被手改坏——坏样本条目跳过并在 droppedBad 如实报告；
 *   文件损坏（非法 JSON）整体 ok:false，绝不覆盖丢数据。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  normalizeStyleExemplars,
  STYLE_EXEMPLAR_MAX_COUNT,
  STYLE_EXEMPLAR_MAX_TEXT_CHARS,
} from "@actalk/story-engine";
import type { StyleExemplar } from "@actalk/story-engine";

import { scrubLocalAbsolutePaths } from "../../lib/local-path-scrubber.js";
import { writeFileAtomic } from "../../lib/project-io.js";

export const STYLE_EXEMPLAR_ACTIONS = ["add", "list", "update", "remove"] as const;
export type StyleExemplarAction = (typeof STYLE_EXEMPLAR_ACTIONS)[number];

export interface ManageStyleExemplarsInput {
  readonly action: StyleExemplarAction;
  readonly id?: string;
  readonly title?: string;
  readonly text?: string;
  readonly note?: string;
}

export interface ManageStyleExemplarsOutput {
  readonly ok: boolean;
  readonly action: StyleExemplarAction;
  readonly count: number;
  readonly exemplars: StyleExemplar[];
  readonly droppedBad: string[];
  readonly summary: string;
}

const WRITING_RULES_RELATIVE_PATH = join("story", "writing-rules.json");

interface WritingRulesFileRead {
  readonly ok: boolean;
  /** 读取成功的整份原始对象（写回时只动 styleExemplars 键，其余字段原样保留）。 */
  readonly record?: Record<string, unknown>;
  readonly exemplars: readonly StyleExemplar[];
  readonly droppedBad: readonly string[];
  readonly failSummary?: string;
}

/** 读 writing-rules.json：ENOENT=还没有任何样本（合理空）；非法 JSON/非对象=损坏，拒不覆盖。 */
async function readWritingRulesFile(projectDir: string): Promise<WritingRulesFileRead> {
  const path = join(projectDir, WRITING_RULES_RELATIVE_PATH);
  let raw: string | undefined;
  try {
    raw = await readFile(path, "utf-8");
  } catch (error) {
    if ((error as { code?: string })?.code === "ENOENT") {
      return { ok: true, record: {}, exemplars: [], droppedBad: [] };
    }
    return {
      ok: false,
      exemplars: [],
      droppedBad: [],
      failSummary: `读 story/writing-rules.json 失败：${scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error))}，没改任何东西。`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      exemplars: [],
      droppedBad: [],
      failSummary: "story/writing-rules.json 内容损坏（不是合法 JSON），没改任何东西以免覆盖丢数据；请先修复该文件。",
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      exemplars: [],
      droppedBad: [],
      failSummary: "story/writing-rules.json 结构异常（顶层不是对象），没改任何东西以免覆盖丢数据；请先修复该文件。",
    };
  }
  const record = parsed as Record<string, unknown>;
  const { exemplars, dropped } = normalizeStyleExemplars(record.styleExemplars);
  return { ok: true, record, exemplars, droppedBad: dropped };
}

/** 原子写回：只换 styleExemplars 键，其余字段（proseStyle/customNotes/未知字段）原样保留。 */
async function writeStyleExemplars(
  projectDir: string,
  record: Record<string, unknown>,
  exemplars: readonly StyleExemplar[],
): Promise<void> {
  const path = join(projectDir, WRITING_RULES_RELATIVE_PATH);
  const next = { ...record, version: "v0", styleExemplars: exemplars };
  // writeFileAtomic 不隐式建目录（首次 add 时 story/ 可能还不存在）
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
}

/** 生成不撞现有条目的样本 id（内部定位用，绝不对用户展示）。 */
function generateExemplarId(title: string, text: string, createdAtMs: number, existing: readonly StyleExemplar[]): string {
  const base = `exemplar-${createHash("sha256").update(`${title}\n${text}\n${createdAtMs}`).digest("hex").slice(0, 6)}`;
  const used = new Set(existing.map((item) => item.id));
  let id = base;
  let suffix = 2;
  while (used.has(id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  return id;
}

/** 按 id（优先）或标题定位；title 同时给了且按 id 定位时，title 视为「要改成的新标题」。 */
function locateExemplar(
  input: ManageStyleExemplarsInput,
  exemplars: readonly StyleExemplar[],
): { readonly target?: StyleExemplar; readonly locatorSummary: string } {
  const id = input.id?.trim();
  if (id) {
    return {
      target: exemplars.find((item) => item.id === id),
      locatorSummary: "没找到这条文风样本（按编号未命中）——先 list 看看现有样本再改。",
    };
  }
  const title = input.title?.trim();
  if (title) {
    return {
      target: exemplars.find((item) => item.title === title),
      locatorSummary: `没找到文风样本「${title}」——先 list 看看现有样本再改。`,
    };
  }
  return { locatorSummary: "update/remove 需要给 id 或标题来定位哪一条样本。" };
}

function validateTextForWrite(text: string | undefined, required: boolean): { readonly ok: boolean; readonly value?: string; readonly failSummary?: string } {
  const trimmed = text?.trim() ?? "";
  if (!trimmed) {
    return required
      ? { ok: false, failSummary: "样本正文（text）必填且不能为空——给一段作者自己写的、想让 AI 模仿风格的段落。" }
      : { ok: true };
  }
  if (trimmed.length > STYLE_EXEMPLAR_MAX_TEXT_CHARS) {
    return {
      ok: false,
      failSummary: `样本正文 ${trimmed.length} 字超过单条上限 ${STYLE_EXEMPLAR_MAX_TEXT_CHARS} 字——没有写入；请精简到 ${STYLE_EXEMPLAR_MAX_TEXT_CHARS} 字以内再存（风格锚不需要长文）。`,
    };
  }
  return { ok: true, value: trimmed };
}

/** 核心逻辑（不依赖 writeTool 框架，可单测）。add/update/remove 会落盘；list 只读。 */
export async function manageStyleExemplarsLogic(input: {
  readonly projectDir: string;
  readonly toolInput: ManageStyleExemplarsInput;
}): Promise<ManageStyleExemplarsOutput> {
  const { projectDir, toolInput } = input;
  const fail = (summary: string, exemplars: readonly StyleExemplar[] = [], droppedBad: readonly string[] = []): ManageStyleExemplarsOutput => ({
    ok: false,
    action: toolInput.action,
    count: exemplars.length,
    exemplars: [...exemplars],
    droppedBad: [...droppedBad],
    summary,
  });

  const read = await readWritingRulesFile(projectDir);
  if (!read.ok) return fail(read.failSummary ?? "读取写作规则失败。", [], []);
  const existing = read.exemplars;

  if (toolInput.action === "list") {
    const head = existing.length === 0
      ? "这本书还没有文风样本。"
      : `这本书现有 ${existing.length} 条文风样本：${existing.map((item) => `「${item.title}」`).join("、")}。`;
    const tail = read.droppedBad.length > 0
      ? `另有 ${read.droppedBad.length} 条损坏条目被跳过：${read.droppedBad.join("；")}。`
      : "";
    return {
      ok: true,
      action: "list",
      count: existing.length,
      exemplars: [...existing],
      droppedBad: [...read.droppedBad],
      summary: `${head}${tail}文风样本会在写正文时作为风格锚喂给 AI（模仿节奏与用词，不照抄内容）。`,
    };
  }

  if (toolInput.action === "add") {
    const title = toolInput.title?.trim() ?? "";
    if (!title) return fail("样本标题（title）必填且不能为空——起个能认出这段的名字，如「雨夜开场」。", existing, read.droppedBad);
    const text = validateTextForWrite(toolInput.text, true);
    if (!text.ok) return fail(text.failSummary ?? "样本正文不合要求。", existing, read.droppedBad);
    if (existing.length >= STYLE_EXEMPLAR_MAX_COUNT) {
      return fail(
        `文风样本最多存 ${STYLE_EXEMPLAR_MAX_COUNT} 条（已有 ${existing.length} 条：${existing.map((item) => `「${item.title}」`).join("、")}）——没有写入；先 remove 一条再 add，或用 update 替换。`,
        existing,
        read.droppedBad,
      );
    }
    if (existing.some((item) => item.title === title)) {
      return fail(`已存在同名文风样本「${title}」——没有写入；换个标题，或用 update 改那一条。`, existing, read.droppedBad);
    }
    const note = toolInput.note?.trim();
    const createdAtMs = Date.now();
    const entry: StyleExemplar = {
      id: generateExemplarId(title, text.value ?? "", createdAtMs, existing),
      title,
      text: text.value ?? "",
      ...(note ? { note } : {}),
      createdAtMs,
    };
    const next = [...existing, entry];
    try {
      await writeStyleExemplars(projectDir, read.record ?? {}, next);
    } catch (error) {
      return fail(`写入 story/writing-rules.json 失败：${scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error))}`, existing, read.droppedBad);
    }
    return {
      ok: true,
      action: "add",
      count: next.length,
      exemplars: next,
      droppedBad: [...read.droppedBad],
      summary: `已存文风样本「${title}」（第 ${next.length}/${STYLE_EXEMPLAR_MAX_COUNT} 条）——写正文时会作为风格锚喂给 AI，模仿其句法节奏与用词偏好、不照抄内容；可一键撤销。`,
    };
  }

  if (toolInput.action === "update") {
    const { target, locatorSummary } = locateExemplar(toolInput, existing);
    if (!target) return fail(locatorSummary, existing, read.droppedBad);
    const renameToRaw = toolInput.id?.trim() ? toolInput.title?.trim() : undefined;
    const renameTo = renameToRaw && renameToRaw !== target.title ? renameToRaw : undefined;
    const text = validateTextForWrite(toolInput.text, false);
    if (!text.ok) return fail(text.failSummary ?? "样本正文不合要求。", existing, read.droppedBad);
    const note = toolInput.note?.trim();
    if (!renameTo && text.value === undefined && note === undefined) {
      return fail(`没有要改的内容——给 text（换正文）、note（设备注）${toolInput.id?.trim() ? "或 title（改标题）" : ""}至少一项。`, existing, read.droppedBad);
    }
    if (renameTo && existing.some((item) => item.id !== target.id && item.title === renameTo)) {
      return fail(`另一条样本已经叫「${renameTo}」——没有写入；换个标题。`, existing, read.droppedBad);
    }
    const patched: StyleExemplar = {
      ...target,
      ...(renameTo ? { title: renameTo } : {}),
      ...(text.value !== undefined ? { text: text.value } : {}),
      ...(note !== undefined ? { note } : {}),
    };
    const next = existing.map((item) => (item.id === target.id ? patched : item));
    try {
      await writeStyleExemplars(projectDir, read.record ?? {}, next);
    } catch (error) {
      return fail(`写入 story/writing-rules.json 失败：${scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error))}`, existing, read.droppedBad);
    }
    const changes = [
      renameTo ? `标题改为「${renameTo}」` : undefined,
      text.value !== undefined ? "正文已替换" : undefined,
      note !== undefined ? "备注已更新" : undefined,
    ].filter((item): item is string => Boolean(item));
    return {
      ok: true,
      action: "update",
      count: next.length,
      exemplars: next,
      droppedBad: [...read.droppedBad],
      summary: `已更新文风样本「${patched.title}」（${changes.join("、")}），可一键撤销。`,
    };
  }

  // remove
  const { target, locatorSummary } = locateExemplar(toolInput, existing);
  if (!target) return fail(locatorSummary, existing, read.droppedBad);
  const next = existing.filter((item) => item.id !== target.id);
  try {
    await writeStyleExemplars(projectDir, read.record ?? {}, next);
  } catch (error) {
    return fail(`写入 story/writing-rules.json 失败：${scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error))}`, existing, read.droppedBad);
  }
  return {
    ok: true,
    action: "remove",
    count: next.length,
    exemplars: next,
    droppedBad: [...read.droppedBad],
    summary: `已删除文风样本「${target.title}」（还剩 ${next.length} 条），可一键撤销。`,
  };
}
