/**
 * POST /api/projects/create
 * POST /api/books/rename
 * POST /api/books/delete
 * POST /api/books/open-folder
 * POST /api/books/story-settings
 * POST /api/books/writing-rules
 * GET  /api/usage-summary
 */
import { execFile } from "node:child_process";
import { access, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { promisify } from "node:util";

import { resolveBooksRootDir } from "../lib/data-dirs.js";
import {
  buildStateOverview,
  createStoryProject,
} from "@actalk/story-engine";
import {
  assertStoryEngineProject,
  guardProjectPath,
  isSafeProjectPath,
  readJsonBody,
  readJsonFile,
  writeJsonFile,
  readString,
  readStringList,
  readPositiveInteger,
  requireBodyString,
  mergeWorldBibleFactions,
  parseWritingRuleLines,
  splitChineseList,
  withUiOverviewDetails,
  readUsageSummary,
  writeJson,
  isRecord,
  type MiddlewareStack,
} from "../lib/project-io.js";
import { createSnapshot } from "../lib/snapshot.js";
import { formatRelativeTimeMs } from "../../utils/textUtils.js";

const execFileAsync = promisify(execFile);

/** 在系统文件管理器里打开目录（跨平台：macOS=open / Windows=explorer / 其余=xdg-open）。 */
async function openDirectoryInFileManager(dir: string): Promise<void> {
  if (process.platform === "darwin") {
    await execFileAsync("open", [dir]);
  } else if (process.platform === "win32") {
    // explorer.exe 打开成功也可能返回非 0 退出码（历史怪癖），吞掉 exec 错误、以不抛为准。
    await execFileAsync("explorer", [dir]).catch(() => {});
  } else {
    await execFileAsync("xdg-open", [dir]);
  }
}

export function registerBooksRoutes(middlewares: MiddlewareStack): void {
  middlewares.use(async (req, res, next) => {
    if (req.url?.startsWith("/api/projects/create")) {
      await handleCreateProject(req, res);
      return;
    }
    if (req.url?.startsWith("/api/books/list-default")) {
      await handleListDefaultBooks(req, res);
      return;
    }
    if (req.url?.startsWith("/api/books/rename")) {
      await handleRenameBook(req, res);
      return;
    }
    if (req.url?.startsWith("/api/books/story-settings")) {
      await handleUpdateStorySettings(req, res);
      return;
    }
    if (req.url?.startsWith("/api/books/writing-rules")) {
      await handleUpdateWritingRules(req, res);
      return;
    }
    if (req.url?.startsWith("/api/books/delete")) {
      await handleDeleteBook(req, res);
      return;
    }
    if (req.url?.startsWith("/api/books/open-folder")) {
      await handleOpenBookFolder(req, res);
      return;
    }
    if (req.url?.startsWith("/api/usage-summary")) {
      await handleUsageSummary(req, res);
      return;
    }
    next();
  });
}

// ---------------------------------------------------------------------------
// Create project
// ---------------------------------------------------------------------------

async function handleCreateProject(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
  let createdProjectDir: string | undefined;
  try {
    if (req.method !== "POST") {
      writeJson(res, 405, { ok: false, error: "Only POST is supported." });
      return;
    }

    const body = await readJsonBody(req);
    const draft = isRecord(body.draft) ? body.draft : {};
    const title = readString(draft.title) ?? "未命名故事";
    const genre = readString(draft.genre) ?? "长篇故事";
    const premise = readString(draft.logline) ?? readString(draft.worldPremise) ?? "主角进入一个等待展开的故事世界。";
    const mainCharacterName = readString(draft.protagonistName) ?? "主角";
    const rootDir = readString(body.rootDir) ?? resolveBooksRootDir();
    // 建书同样过路径闸（与其余路由一致）：rootDir 直接来自客户端。
    // 唯一例外是配置的书库根本身——SE_BOOKS_DIR 覆盖到家目录外时，isSafeProjectPath 的覆盖分支
    // 只放行书库根之下的项目路径、根本身会被拒；而建书落点是 <rootDir>/story-engine/<id>，根可信即落点可信。
    if (!isSafeProjectPath(rootDir) && resolve(rootDir) !== resolve(resolveBooksRootDir())) {
      writeJson(res, 400, { ok: false, error: "不安全的项目路径" });
      return;
    }
    const created = await createStoryProject({
      rootDir,
      title,
      genre,
      premise,
      mainCharacterName,
    });
    createdProjectDir = created.projectDir;
    const overview = await withUiOverviewDetails(created.projectDir, await buildStateOverview({ projectDir: created.projectDir, maxTimelineEvents: 8 }));
    writeJson(res, 200, { ok: true, projectDir: created.projectDir, project: created.project, overview });
  } catch (error) {
    if (createdProjectDir) {
      await rm(createdProjectDir, { recursive: true, force: true }).catch(() => undefined);
    }
    writeJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ---------------------------------------------------------------------------
// GET /api/books/list-default — scan ~/StoryEngine-NG/story-engine/
// ---------------------------------------------------------------------------

/** 默认书库扫描条目：含最近活跃毫秒，供排序后截取前 20。 */
export type DefaultBookCandidate = {
  readonly projectDir: string;
  readonly title: string;
  readonly lastActiveMs: number;
};

/**
 * 按最近活跃时间降序取前 `limit` 本（默认 20）。
 * 超过上限时最旧的被挤掉——保证最近写过的书永远进书架兜底。
 */
export function selectRecentDefaultBooks(
  candidates: readonly DefaultBookCandidate[],
  limit = 20,
): DefaultBookCandidate[] {
  return [...candidates]
    .sort((a, b) => b.lastActiveMs - a.lastActiveMs || a.projectDir.localeCompare(b.projectDir))
    .slice(0, Math.max(0, limit));
}

/**
 * project.json 的 updatedAt（ISO）→ ms；缺失/坏值 → 0。与若干 mtime 候选取 max 才是真实活跃度。
 * mtime 候选除项目根目录外还应包含 chapters/、drafts/fast（写作真正落盘的地方）——
 * 子目录里写文件不会碰根目录 mtime，只看根目录会把「刚写完一章」显示成几十分钟前。
 */
export function resolveBookLastActiveMs(updatedAt: unknown, ...mtimeCandidates: number[]): number {
  let fromUpdatedAt = 0;
  if (typeof updatedAt === "string" && updatedAt.trim()) {
    const parsed = Date.parse(updatedAt);
    if (Number.isFinite(parsed)) fromUpdatedAt = parsed;
  }
  const fromMtime = Math.max(0, ...mtimeCandidates.filter((value) => Number.isFinite(value)));
  return Math.max(fromUpdatedAt, fromMtime);
}

/** 目录 mtime（ms）；不存在/不可读 → 0。 */
async function statMtimeMs(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

async function handleListDefaultBooks(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
  try {
    if (req.method !== "GET") {
      writeJson(res, 405, { ok: false, error: "Only GET is supported." });
      return;
    }
    const defaultRoot = join(resolveBooksRootDir(), "story-engine");
    let entries: string[];
    try {
      entries = await readdir(defaultRoot, { withFileTypes: false });
    } catch {
      writeJson(res, 200, { ok: true, books: [] });
      return;
    }
    const books: DefaultBookCandidate[] = [];
    for (const entry of entries) {
      const projectDir = join(defaultRoot, entry);
      const projectFile = join(projectDir, "project.json");
      try {
        const [raw, dirMtime, chaptersMtime, draftsMtime] = await Promise.all([
          readFile(projectFile, "utf-8"),
          statMtimeMs(projectDir),
          statMtimeMs(join(projectDir, "chapters")),
          statMtimeMs(join(projectDir, "drafts", "fast")),
        ]);
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.title === "string") {
          books.push({
            projectDir,
            title: parsed.title,
            lastActiveMs: resolveBookLastActiveMs(parsed.updatedAt, dirMtime, chaptersMtime, draftsMtime),
          });
        }
      } catch {
        // Not a valid project dir, skip
      }
    }

    // 按最近活跃降序后再截前 20——目录名序会把真书写进书库深处挤出兜底。
    const recent = selectRecentDefaultBooks(books, 20);

    // 批量构建完整 BookSummary（并行调用 state-overview）
    const summaries = await Promise.all(
      recent.map(async ({ projectDir, title, lastActiveMs }) => {
        try {
          const overview = await withUiOverviewDetails(projectDir, await buildStateOverview({ projectDir, maxTimelineEvents: 8 }));
          const book = bookSummaryFromOverviewServer(overview, projectDir, lastActiveMs);
          return book;
        } catch {
          // 回退：只用 title
          return {
            id: `project-${stableHash(projectDir)}`,
            title,
            genre: "长篇故事",
            currentChapterTitle: "第 1 章",
            currentChapterNumber: 1,
            protagonistName: "主角",
            status: "草稿中" as const,
            updatedAt: formatRelativeTimeMs(lastActiveMs),
            lastActiveMs,
            logline: "",
            writtenChapters: 0,
            totalWords: 0,
            projectPath: projectDir,
          };
        }
      }),
    );

    writeJson(res, 200, { ok: true, books: summaries });
  } catch (error) {
    writeJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function stableHash(value: string): string {
  let hash = 0;
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash.toString(16);
}

function bookSummaryFromOverviewServer(
  overview: { project: any; timeline: any; characters: any; world: any; storyStatus: any },
  projectPath: string,
  lastActiveMs: number,
) {
  const proj = overview.project ?? {};
  const timeline = overview.timeline ?? {};
  const events = timeline.recentEvents ?? [];
  const characters = overview.characters ?? {};
  const world = overview.world ?? {};
  const storyStatus = overview.storyStatus ?? {};

  const currentChapterNumber = proj.currentChapter ?? events.at(-1)?.chapter ?? 1;
  const currentEvent = events.find((e: any) => e.chapter === currentChapterNumber) ?? events.at(-1);
  const writtenChapters = Math.max(proj.currentChapter ?? events.length, events.length, 0);
  const projectTitle = (proj.title || "未命名故事").trim();

  let chapterTitle = `第${currentChapterNumber}章`;
  if (currentEvent) {
    const source = currentEvent.mainEvent ?? currentEvent.summary;
    if (source?.trim()) {
      const cleaned = source.replace(/\s+/gu, " ").trim();
      chapterTitle = cleaned.length > 18 ? `${cleaned.slice(0, 18)}…` : cleaned;
    }
  }

  const timelineWords = events.reduce((total: number, event: any) => total + (event.summary?.length ?? 0) + (event.mainEvent?.length ?? 0), 0);
  const totalWords = Math.max(timelineWords * 20, (proj.currentChapter ?? 0) * 3000);

  return {
    id: `project-${stableHash(projectPath)}`,
    title: projectTitle,
    genre: proj.genre || "长篇故事",
    currentChapterTitle: chapterTitle,
    currentChapterNumber,
    protagonistName: characters.protagonist ?? characters.knownCharacters?.[0]?.name ?? "主角",
    status: proj.currentChapter ? "可继续下一章" as const : "草稿中" as const,
    // 真实活跃时间（此前硬编码「刚刚」→ 书架上所有书永远显示刚刚）
    updatedAt: formatRelativeTimeMs(lastActiveMs),
    lastActiveMs,
    logline: world.summary ?? storyStatus.currentObjective ?? "",
    writtenChapters,
    totalWords,
    projectPath,
  };
}

// ---------------------------------------------------------------------------
// Rename book
// ---------------------------------------------------------------------------

async function handleRenameBook(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
  try {
    if (req.method !== "POST") {
      writeJson(res, 405, { ok: false, error: "Only POST is supported." });
      return;
    }
    const body = await readJsonBody(req);
    const projectDir = requireBodyString(body.projectPath, "项目路径不能为空。");
    if (!guardProjectPath(res, projectDir)) return;
    const title = requireBodyString(body.title, "新书名不能为空。").trim();
    if (title.length > 80) {
      writeJson(res, 400, { ok: false, error: "书名不能超过 80 个字符。" });
      return;
    }

    await assertStoryEngineProject(projectDir);
    const projectPath = join(projectDir, "project.json");
    const project = JSON.parse(await readFile(projectPath, "utf-8")) as Record<string, unknown>;
    const nextProject = {
      ...project,
      title,
      updatedAt: new Date().toISOString(),
    };
    await writeFile(projectPath, `${JSON.stringify(nextProject, null, 2)}\n`, "utf-8");
    const overview = await withUiOverviewDetails(projectDir, await buildStateOverview({ projectDir, maxTimelineEvents: 8 }));
    writeJson(res, 200, { ok: true, title, overview });
  } catch (error) {
    writeJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ---------------------------------------------------------------------------
// Update story settings
// ---------------------------------------------------------------------------

async function handleUpdateStorySettings(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
  try {
    if (req.method !== "POST") {
      writeJson(res, 405, { ok: false, error: "Only POST is supported." });
      return;
    }
    const body = await readJsonBody(req);
    const projectDir = requireBodyString(body.projectPath, "项目路径不能为空。");
    if (!guardProjectPath(res, projectDir)) return;
    const title = requireBodyString(body.title, "书名不能为空。").trim();
    const genre = requireBodyString(body.genre, "类型不能为空。").trim();
    const logline = requireBodyString(body.logline, "一句话故事不能为空。").trim();
    const currentPhase = readString(body.currentPhase) ?? "开篇";
    const firstVolumeGoal = readString(body.firstVolumeGoal);
    const longFormGoals = [
      ...(firstVolumeGoal ? [firstVolumeGoal] : []),
      ...readStringList(body.longFormGoals),
    ];
    const worldRules = readStringList(body.worldRules);
    const socialRules = readStringList(body.socialRules);
    const importantFacts = readStringList(body.importantFacts);
    const currentMainGoal = readString(body.currentMainGoal);
    const centralConflicts = readStringList(body.centralConflicts);
    const forbiddenReveals = readStringList(body.forbiddenReveals);
    const openQuestions = readStringList(body.openQuestions);
    await assertStoryEngineProject(projectDir);

    const now = new Date().toISOString();
    const projectPath = join(projectDir, "project.json");
    const worldCorePath = join(projectDir, "world", "core.json");
    const worldStatePath = join(projectDir, "world", "state.json");
    const storyCorePath = join(projectDir, "story", "core.json");
    const storyBiblePath = join(projectDir, "story", "bible.json");
    const worldBiblePath = join(projectDir, "story", "world-bible.json");
    const [project, worldCore, worldState, storyCore, storyBible, worldBible] = await Promise.all([
      readJsonFile(projectPath),
      readJsonFile(worldCorePath),
      readJsonFile(worldStatePath),
      readJsonFile(storyCorePath),
      readJsonFile(storyBiblePath),
      readJsonFile(worldBiblePath),
    ]);

    await createSnapshot(projectDir, "故事设定修改前快照");
    await Promise.all([
      writeJsonFile(projectPath, { ...project, title, updatedAt: now }),
      writeJsonFile(worldCorePath, { ...worldCore, genre, premise: logline, rules: worldRules }),
      writeJsonFile(worldStatePath, { ...worldState, currentPhase, activeConflicts: importantFacts }),
      writeJsonFile(storyCorePath, { ...storyCore, readerPromise: currentMainGoal ?? logline }),
      writeJsonFile(storyBiblePath, {
        ...storyBible,
        projectLogline: logline,
        premise: logline,
        genre,
        readerPromise: logline,
        longFormGoals,
        centralConflicts,
        forbiddenChanges: forbiddenReveals,
        canonFacts: importantFacts,
        openQuestions,
      }),
      writeJsonFile(worldBiblePath, { ...worldBible, rules: worldRules, factions: mergeWorldBibleFactions(worldBible.factions, socialRules) }),
    ]);

    const overview = await withUiOverviewDetails(projectDir, await buildStateOverview({ projectDir, maxTimelineEvents: 8 }));
    writeJson(res, 200, { ok: true, overview });
  } catch (error) {
    writeJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ---------------------------------------------------------------------------
// Update writing rules
// ---------------------------------------------------------------------------

async function handleUpdateWritingRules(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
  try {
    if (req.method !== "POST") {
      writeJson(res, 405, { ok: false, error: "Only POST is supported." });
      return;
    }
    const body = await readJsonBody(req);
    const projectDir = requireBodyString(body.projectPath, "项目路径不能为空。");
    if (!guardProjectPath(res, projectDir)) return;
    await assertStoryEngineProject(projectDir);

    const writingRulesPath = join(projectDir, "story", "writing-rules.json");
    const current = await readJsonFile(writingRulesPath);
    const parsed = Array.isArray(body.rules)
      ? parseWritingRuleLines(readStringList(body.rules))
      : {
        narrativePerspective: readString(body.narrativePerspective),
        proseStyle: readStringList(body.proseStyle),
        pacing: readString(body.pacing),
        revealPolicy: readString(body.revealPolicy),
        chapterLength: readPositiveInteger(body.targetChapterWords) ? { targetWords: readPositiveInteger(body.targetChapterWords) } : undefined,
        genreRequirements: readStringList(body.genreRequirements),
        forbiddenContent: readStringList(body.forbiddenContent),
        doNotDo: readStringList(body.doNotDo),
        readerExperienceRules: readStringList(body.readerExperienceRules),
      };
    await createSnapshot(projectDir, "写作规则修改前快照");
    await writeJsonFile(writingRulesPath, {
      ...current,
      version: "v0",
      ...parsed,
    });

    const overview = await withUiOverviewDetails(projectDir, await buildStateOverview({ projectDir, maxTimelineEvents: 8 }));
    writeJson(res, 200, { ok: true, overview });
  } catch (error) {
    writeJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ---------------------------------------------------------------------------
// Delete book
// ---------------------------------------------------------------------------

async function handleDeleteBook(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
  try {
    if (req.method !== "POST") {
      writeJson(res, 405, { ok: false, error: "Only POST is supported." });
      return;
    }
    const body = await readJsonBody(req);
    const projectDir = requireBodyString(body.projectPath, "项目路径不能为空。");
    if (!guardProjectPath(res, projectDir)) return;

    // 目录已不存在（早期残留的过期书架条目）→ 视作已删除，幂等返回成功，让前端能把这条移出书架
    // （否则 assertStoryEngineProject 会因读不到项目抛错→500→「删不掉」）。
    const exists = await access(resolve(projectDir)).then(() => true).catch(() => false);
    if (!exists) {
      writeJson(res, 200, { ok: true });
      return;
    }

    const { title: projectTitle } = await assertStoryEngineProject(projectDir);

    if (body.confirmDelete !== true && body.confirm !== true) {
      writeJson(res, 400, { ok: false, error: "需要 confirmDelete=true 才能删除项目" });
      return;
    }

    const confirmTitle = readString(body.confirmTitle);
    if (!confirmTitle) {
      writeJson(res, 400, { ok: false, error: "需要确认书名才能删除项目" });
      return;
    }
    if (confirmTitle !== projectTitle) {
      writeJson(res, 400, { ok: false, error: "确认书名不匹配。" });
      return;
    }

    const confirmProjectPath = readString(body.confirmProjectPath);
    if (!confirmProjectPath) {
      writeJson(res, 400, { ok: false, error: "需要确认项目标识才能删除项目" });
      return;
    }
    if (resolve(confirmProjectPath) !== resolve(projectDir)) {
      writeJson(res, 400, { ok: false, error: "确认项目标识不匹配。" });
      return;
    }

    // force:true——若目录在校验后恰好消失（并发/外部删除），不再抛错（删除是幂等的）。
    await rm(resolve(projectDir), { recursive: true, force: true });
    writeJson(res, 200, { ok: true });
  } catch (error) {
    writeJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ---------------------------------------------------------------------------
// Open book folder
// ---------------------------------------------------------------------------

async function handleOpenBookFolder(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
  try {
    if (req.method !== "POST") {
      writeJson(res, 405, { ok: false, error: "Only POST is supported." });
      return;
    }
    const body = await readJsonBody(req);
    const projectDir = requireBodyString(body.projectPath, "项目路径不能为空。");
    if (!guardProjectPath(res, projectDir)) return;
    await assertStoryEngineProject(projectDir);
    await openDirectoryInFileManager(resolve(projectDir));
    writeJson(res, 200, { ok: true });
  } catch (error) {
    writeJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ---------------------------------------------------------------------------
// Usage summary
// ---------------------------------------------------------------------------

async function handleUsageSummary(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
  try {
    if (req.method !== "GET") {
      writeJson(res, 405, { ok: false, error: "Only GET is supported." });
      return;
    }
    const url = new URL(req.url ?? "", "http://localhost");
    const projectDir = requireBodyString(url.searchParams.get("project"), "项目路径不能为空。");
    if (!guardProjectPath(res, projectDir)) return;
    await assertStoryEngineProject(projectDir);
    const summary = await readUsageSummary(projectDir);
    writeJson(res, 200, { ok: true, summary });
  } catch (error) {
    writeJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
