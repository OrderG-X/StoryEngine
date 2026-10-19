import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { cardsImport, cardWrite, runCommand, type CardOp } from "@actalk/story-core";
import type {
  ArcGoalPool,
  FactLedger,
  HookPool,
  TimelineEvent,
  StoryCalendar,
  StoryProject,
  ThreadPool,
} from "./types.js";

export interface CreateStoryProjectInput {
  readonly rootDir: string;
  readonly title: string;
  /** 作者建书时填的题材 / 一句话 / 主角名：没填就不写，不落占位（重构 P9）。 */
  readonly genre?: string;
  readonly logline?: string;
  readonly protagonistName?: string;
}

export interface CreateStoryProjectResult {
  readonly projectDir: string;
  readonly project: StoryProject;
}

/** 建书时写进故事设定的栏名（自家格式，state-overview 按同名取题材和书架简介）。 */
const GENRE_LABEL = "题材";
const LOGLINE_LABEL = "一句话";

/**
 * 建书（重构 P9）：只写 project.json 和章节目录，设定卡走核心命令（作者档）——作者填了什么就写什么，
 * 没填的空着，不再写一堆模板占位（占位主角、占位前提、默认文风）让模型当真。
 */
export async function createStoryProject(input: CreateStoryProjectInput): Promise<CreateStoryProjectResult> {
  const now = new Date().toISOString();
  const projectIdBase = toProjectIdBase(input.title);
  const projectId = await resolveUniqueProjectId(join(input.rootDir, "story-engine"), projectIdBase);
  const projectDir = join(input.rootDir, "story-engine", projectId);

  try {
    await mkdir(join(projectDir, "chapters"), { recursive: true });
    const project: StoryProject = {
      id: projectId,
      title: input.title,
      createdAt: now,
      updatedAt: now,
    };
    await writeJsonAtomic(join(projectDir, "project.json"), project);

    const ops: CardOp[] = [
      ...(input.genre?.trim() ? [{ op: "story.set" as const, label: GENRE_LABEL, value: input.genre.trim() }] : []),
      ...(input.logline?.trim() ? [{ op: "story.set" as const, label: LOGLINE_LABEL, value: input.logline.trim() }] : []),
      ...(input.protagonistName?.trim()
        ? [{ op: "card.create" as const, kind: "character" as const, name: input.protagonistName.trim(), protagonist: true }]
        : []),
    ];
    const outcome = ops.length > 0
      ? await runCommand(projectDir, cardWrite, { ops }, { caller: "author", idempotencyKey: "book-create" })
      : await runCommand(projectDir, cardsImport, {}, { caller: "author", idempotencyKey: "book-create" });
    if (!outcome.ok) throw new Error(outcome.message);

    return { projectDir, project };
  } catch (error) {
    await rm(projectDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readProject(projectDir: string): Promise<StoryProject> {
  return readJson<StoryProject>(join(projectDir, "project.json"));
}

export async function readFactLedger(projectDir: string): Promise<FactLedger | null> {
  return readOptionalJson<FactLedger>(join(projectDir, "story", "fact-ledger.json"));
}

export async function readHookPool(projectDir: string): Promise<HookPool> {
  // 老书兼容（审计 P1-4）：缺 hooks.json 按空池处理，与 readThreadPool/readArcGoalPool 同款兜底；
  // 损坏 JSON 仍上抛——伏笔池是正式状态，坏文件绝不能静默当空池往下写。
  return readJson<HookPool>(join(projectDir, "story", "hooks.json")).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return { hooks: [] };
    throw error;
  });
}

export async function readThreadPool(projectDir: string): Promise<ThreadPool> {
  return readJson<ThreadPool>(join(projectDir, "story", "threads.json")).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return { threads: [] };
    throw error;
  });
}

export async function readArcGoalPool(projectDir: string): Promise<ArcGoalPool> {
  return readJson<ArcGoalPool>(join(projectDir, "story", "arc-goals.json")).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return { goals: [] };
    throw error;
  });
}

export async function readStoryCalendar(projectDir: string): Promise<StoryCalendar> {
  // 老书兼容（审计 P1-4）：缺 time/calendar.json 按「第 1 天·时刻未知」起步——
  // commit-plan-builder 每次提交必发 calendar 更新，缺文件不该让 commit 直接 reject。
  return readJson<StoryCalendar>(join(projectDir, "time", "calendar.json")).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return { currentStoryDay: 1, currentTimeOfDay: "unknown" };
    throw error;
  });
}

export async function readTimelineEvents(projectDir: string): Promise<readonly TimelineEvent[]> {
  // 老书兼容（审计 P1-4）：缺 timeline/events.json 按空时间线处理；
  // 损坏 JSON 仍上抛，由上层（context-gateway 的 read_failures 等）如实记录降级。
  return readJson<TimelineEvent[]>(join(projectDir, "timeline", "events.json")).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as TimelineEvent[];
    throw error;
  });
}

function normalizeToSafeIdCore(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/['’]/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-{2,}/gu, "-");
}

/**
 * 新书目录名：书名里抽得出像样的英文词就用它（如「UI审计-20260912」→ ui-20260912），
 * 否则用 story-<hash>。中文书名里只剩数字时（「测试书2」→「2」）以前会建出叫 `2` 的目录，看不出是书。
 * 只影响新建，旧书目录不动。
 */
function toProjectIdBase(title: string): string {
  const core = normalizeToSafeIdCore(title);
  return /[a-z]{2,}/u.test(core) ? core : `story-${shortHash(title)}`;
}

async function resolveUniqueProjectId(rootDir: string, baseId: string): Promise<string> {
  let candidate = baseId;
  let suffix = 2;
  while (await pathExists(join(rootDir, candidate))) {
    candidate = `${baseId}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 6);
}

/**
 * 原子写盘（tmp + rename），引擎内统一口径（2026-09-15 审计 P0-2 收口）：
 * 直接 writeFile 覆盖在进程被杀（OOM/断电/强退）时会留下截断文件，而读侧 readJsonSafe
 * 对 SyntaxError 一律回 fallback → 面板和写手上下文静默显示空设定。rename 在同文件
 * 系统内原子：要么完整落盘、要么保持旧文件不动。tmp 统一 `<file>.tmp-<pid>` 后缀；
 * 写盘或改名任一步失败先清 tmp 再原样上抛——绝不静默失败、不留半成品。
 */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  // dirname 平台感知：Windows 反斜杠路径也算出正确父目录——旧 lastIndexOf("/") 算法
  // 在 `\` 路径下得出 ""，mkdir 被静默跳过（复审 C 级）。
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  try {
    await writeFile(tmpPath, content, "utf-8");
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** 原子写 JSON：2 空格缩进 + 尾换行，与旧 writeJson 落盘格式一致。 */
async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf-8")) as T;
}

async function readOptionalJson<T>(path: string): Promise<T | null> {
  return readJson<T>(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

/**
 * 错误的用户可见简报——路径泄漏纪律（2026-09-15 复审；引擎侧不复制 UI 的 scrub 正则，只产出结构化简报）：
 * - errno/自造 code（EACCES、UNSAFE_*、TX_*…）→ `错误码 X`，错误自带 path 且能折算进 projectDir 时附相对文件名；
 * - JSON 解析失败 → 固定文案（不带源文件内容）；
 * - 普通 Error：message 里**不含任何路径分隔符**（`/`、`\`）才原样放行——配置类错误（如缺 API key）
 *   的文案本来就该到用户面前；带分隔符的 message 可能藏本地绝对路径，一律降级为类型名。
 */
export function describeErrorBriefly(error: unknown, projectDir?: string): string {
  if (error instanceof SyntaxError) return "JSON 解析失败";
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    const kind = typeof code === "string" && code.length > 0
      ? `错误码 ${code}`
      : (() => {
        const message = error.message.trim();
        return message.length > 0 && !message.includes("/") && !message.includes("\\")
          ? message
          : `错误类型 ${error.name || "Error"}`;
      })();
    const rawPath = (error as NodeJS.ErrnoException).path;
    if (projectDir !== undefined && typeof rawPath === "string" && rawPath.length > 0) {
      const rel = relative(resolve(projectDir), resolve(rawPath));
      if (rel.length > 0 && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
        return `${kind}（${rel}）`;
      }
    }
    return kind;
  }
  return "未知错误";
}
