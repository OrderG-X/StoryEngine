/**
 * read_draft — 只读工具：直接返回某章「工作稿（草稿）」或「已入库正文」的【全文】。
 *
 * 补的洞（2026-06-23 真实会话实锤）：agent 此前只有 ai_review/quality_check/commit_preview 能「内部读」草稿、
 * 却只回分析结果，没有任何工具能把草稿正文本身交给模型 → 用户问「看一下草稿 / 草稿里写了 X 吗 / 直接读草稿」时
 * agent 只能反问用户、或拿 commit_preview 凑合瞄几段（用户原话「要催好几遍才知道读取入库预览」）。本工具直读
 * 草稿文件、回全文，让 agent 能直接看、直接答。
 *
 * 只读：不写盘、不建快照、不带 snapshotId / refreshScope（不动磁盘，前端无需刷新面板）。
 * source=auto（默认）优先读工作稿、没有则回退已入库正文，并如实标注读的是哪一份。题材中立。
 */
import { readFile } from "node:fs/promises";
import { createTool } from "@mastra/core/tools";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { z } from "zod";
import { coerceEnum, coerceNumber } from "./lenient-args.js";

import { defaultCommittedChapterPath, defaultDraftPath, extractDraftTitle } from "../../lib/project-io.js";
import { readProjectDirFromContext, resolveChapterFromInputOrContext } from "../request-context.js";

export const READ_DRAFT_SOURCES = ["auto", "draft", "committed"] as const;
export type ReadDraftSource = (typeof READ_DRAFT_SOURCES)[number];

const inputSchema = z.object({
  chapter: coerceNumber(z.number().int().positive().optional().describe("要读哪一章；省略时默认用户当前所在章。")),
  // 模型无关：枚举大小写/空白宽容（模型传 "Draft"/" auto " 不再硬 InputValidationError；空串→undefined→auto）。
  source: coerceEnum(z.enum(READ_DRAFT_SOURCES).optional().describe(
    "读哪一份正文：\n" +
      "- auto（默认）：优先读工作稿，没有工作稿才回退到已定稿正文。\n" +
      "- draft：只读工作稿。\n" +
      "- committed：只读已定稿正文。",
  )),
});

const outputSchema = z.object({
  chapter: z.number().int().positive(),
  found: z.boolean().describe("是否读到了正文（草稿与已入库都没有时为 false）。"),
  source: z.enum(["draft", "committed"]).nullable().describe(
    "实际读到的是哪一份：draft=工作稿 / committed=已定稿；都没有时为 null。",
  ),
  title: z.string().nullable().describe("从正文首行解析出的标题（没有则 null）。"),
  content: z.string().describe("正文全文（found=false 时为空串）。"),
  charCount: z.number().int().nonnegative().describe("正文去空白后的字数。"),
  summary: z.string().describe("自然语言摘要，供回答用户。"),
});

export interface ReadDraftToolOutput {
  readonly chapter: number;
  readonly found: boolean;
  readonly source: "draft" | "committed" | null;
  readonly title: string | null;
  readonly content: string;
  readonly charCount: number;
  readonly summary: string;
}

function hasText(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** 读文本：文件不存在(ENOENT)→ content undefined（合理没草稿）；真读失败(损坏/权限)→ readError（诚实回报，不塌成没草稿）。 */
async function readTextTolerant(path: string): Promise<{ readonly content?: string; readonly readError?: string }> {
  try {
    return { content: await readFile(path, "utf-8") };
  } catch (error) {
    if ((error as { code?: string })?.code === "ENOENT") return {};
    return { readError: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 纯逻辑：按 source 读出某章正文。抽出为可直接单测的函数（不经 Mastra execute 包装）。
 * 题材中立：summary 不注入任何题材假设。
 */
export async function readDraftContent(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly source?: ReadDraftSource;
}): Promise<ReadDraftToolOutput> {
  const { projectDir, chapter } = input;
  const source = input.source ?? "auto";
  // 区分「文件不存在=合理没草稿」与「真读失败（损坏/权限）」——真错诚实回报，绝不塌成「还没草稿」误导。
  const draft = source === "committed" ? { content: undefined } : await readTextTolerant(defaultDraftPath(projectDir, chapter));
  const committed = await readTextTolerant(defaultCommittedChapterPath(projectDir, chapter));
  const readError = draft.readError ?? (source === "draft" ? undefined : committed.readError);
  if (readError) {
    return {
      chapter,
      found: false,
      source: null,
      title: null,
      content: "",
      charCount: 0,
      summary: `读取第 ${chapter} 章正文失败（${readError}），不是「没有工作稿」——请稍后重试或检查文件。`,
    };
  }

  const picked: { readonly content: string; readonly source: "draft" | "committed" } | null =
    hasText(draft.content)
      ? { content: draft.content, source: "draft" }
      : source !== "draft" && hasText(committed.content)
        ? { content: committed.content, source: "committed" }
        : null;

  if (!picked) {
    const want = source === "committed" ? "已定稿正文" : source === "draft" ? "工作稿" : "工作稿或已定稿正文";
    return {
      chapter,
      found: false,
      source: null,
      title: null,
      content: "",
      charCount: 0,
      summary: `第 ${chapter} 章还没有${want}，没读到任何正文。`,
    };
  }

  const charCount = picked.content.replace(/\s/gu, "").length;
  const title = extractDraftTitle(picked.content);
  const hasCommittedChapter = hasText(committed.content);
  const label =
    picked.source === "draft"
      ? hasCommittedChapter
        ? "工作稿（该章已有定稿正文，当前读的是工作稿）"
        : "工作稿（未定稿）"
      : "已定稿正文";
  return {
    chapter,
    found: true,
    source: picked.source,
    title: title ?? null,
    content: picked.content,
    charCount,
    summary: `已读取第 ${chapter} 章${label}${title ? `《${title}》` : ""}，约 ${charCount} 字。`,
  };
}

export const readDraftTool = createTool({
  id: "read_draft",
  description:
    "直接读取并返回某章工作稿或已定稿正文的【全文】。" +
    "当用户问『看一下这章草稿 / 草稿里写了什么 / 某句话或某设定在不在正文里 / 帮我读一下正文』时，先调本工具拿到正文再回答——" +
    "别反问用户、也别拿审稿/质检/定稿预览去凑合读。只读，不改稿、不定稿。缺章号时默认用户当前所在章。",
  inputSchema,
  outputSchema,
  execute: async (input: z.infer<typeof inputSchema>, context: ToolExecutionContext) => {
    const projectDir = readProjectDirFromContext(context);
    if (!projectDir) {
      throw new Error("read_draft 缺少 projectDir：请确认调用 agent 时通过 RequestContext 注入了 projectDir。");
    }
    const resolvedChapter = resolveChapterFromInputOrContext(input.chapter, context);
    if (resolvedChapter === undefined) {
      throw new Error("read_draft 缺少章号：LLM 未给出章号，且前端未注入 currentChapter。请明确指定章号。");
    }
    return readDraftContent({
      projectDir,
      chapter: resolvedChapter,
      ...(input.source !== undefined ? { source: input.source } : {}),
    });
  },
});
