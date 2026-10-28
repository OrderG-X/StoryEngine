/**
 * 工作稿的读和存（重构 P5；写作版本 P1b 加了恢复稿和 AI 候选）：
 *   GET /api/working-draft?project=…&chapter=…  → { ok, paper: { chapter, draft, committed, editedSinceCommit, pending? } }
 *     draft = { chapter, title?, body, version } | null；committed = { title?, body } | null（定稿正文）
 *     pending = 等作者选的一份：恢复稿（作者上次没存上的字）或 AI 候选（AI 写好、没换上的），和工作稿一样的不给。
 *   PUT /api/working-draft { projectPath, chapter, body, title?, baseVersion } → { ok, version, unchanged }
 *     baseVersion 和盘上对不上 → 先把这份存成恢复稿，再 409 { ok:false, code:"draft_conflict", error, current, recoveryId }；
 *     工作稿不动。盘上已经就是这份（同一笔重发）算存上。
 *   POST /api/working-draft/pending { projectPath, chapter, kind, id, sha, decision, baseVersion }
 *     decision=adopt：换上那一份（作者档 draft.adoptCandidate，带作者眼前那份的版本，对不上不换；换前存档、可撤销）；
 *     decision=dismiss：不要了（AI 候选删掉；恢复稿删掉——作者自己说不要的）。
 *   POST /api/chapter-title { projectPath, chapter, title, requestId } → { ok, title, unchanged, snapshotId? }
 *     改已定稿那一章的章名（作者档 chapter.retitle，改前存档、可撤销；正文和账单条目不动）。requestId 是这次点击的幂等键。
 *     没定稿的章不走这里：章名跟着存稿走。
 *
 * 版本号是草稿文件全文的哈希（核心包 draft.save）。外面先拿老引擎的项目锁，和 AI 改稿 / 出稿互斥
 * （它们还在老锁里写同一个文件），里面跑核心命令。
 */
import { chapterRetitle, draftAdoptCandidate, draftSave, readChapterPaper, runCommand, sha256, type DraftConflictDetails } from "@actalk/story-core";
import {
  assertStoryEngineProject,
  guardProjectPath,
  readJsonBody,
  requireBodyString,
  requirePositiveBodyInteger,
  writeJson,
  type MiddlewareStack,
} from "../lib/project-io.js";
import { scrubLocalAbsolutePaths } from "../lib/local-path-scrubber.js";
import { chapterWordsNow, recordChapterWords } from "../lib/word-stats.js";
import { runWithLazySnapshot } from "../lib/snapshot.js";
import { syncLegacyMirror } from "../book/mirror/sync.js";
import {
  clearSavedRecoveries,
  pendingDraftFor,
  readDraftCandidate,
  readDraftRecovery,
  removeDraftCandidate,
  removeDraftRecovery,
  saveDraftRecovery,
} from "../lib/draft-candidates.js";

const PATH = "/api/working-draft";
const PENDING_PATH = "/api/working-draft/pending";
const TITLE_PATH = "/api/chapter-title";

function readBaseVersion(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new Error("baseVersion 要么是上次读到的版本号，要么是 null（这一章原来没有工作稿）。");
}

export function registerWorkingDraftRoutes(middlewares: MiddlewareStack): void {
  middlewares.use(async (req, res, next) => {
    const url = new URL(req.url ?? "", "http://localhost");
    if (url.pathname !== PATH && url.pathname !== TITLE_PATH && url.pathname !== PENDING_PATH) {
      next();
      return;
    }
    try {
      if (url.pathname === TITLE_PATH) {
        if (req.method !== "POST") {
          writeJson(res, 405, { ok: false, error: "只能用 POST 改章名。" });
          return;
        }
        const body = await readJsonBody(req);
        const projectDir = requireBodyString(body.projectPath, "项目路径不能为空。");
        if (!guardProjectPath(res, projectDir)) return;
        const chapter = requirePositiveBodyInteger(body.chapter, "章节不能为空。");
        const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
        if (!requestId) {
          writeJson(res, 400, { ok: false, error: "没改章名：这次改动缺少防重复的编号。" });
          return;
        }
        await assertStoryEngineProject(projectDir);
        const { snapshotId, result } = await runWithLazySnapshot(projectDir, (snapshot) =>
          runCommand(projectDir, chapterRetitle, { chapter, title: typeof body.title === "string" ? body.title : "" }, {
            caller: "author",
            idempotencyKey: `chapter-title:${requestId}`,
            snapshot,
          }));
        if (!result.ok) {
          writeJson(res, 409, { ok: false, code: result.code, error: result.message });
          return;
        }
        // 老格式镜像（时间线里的章名）跟着定稿正文走；没同步上不算没改成，下次打开书会补。
        if (!result.result.unchanged) {
          const mirror = await syncLegacyMirror(projectDir);
          if (!mirror.ok) console.warn(`[chapter-title] 第 ${chapter} 章改章名后老格式镜像没同步上：${mirror.reason}`);
        }
        writeJson(res, 200, {
          ok: true,
          title: result.result.title,
          unchanged: result.result.unchanged,
          ...(snapshotId && !result.replayed ? { snapshotId } : {}),
        });
        return;
      }
      if (url.pathname === PENDING_PATH) {
        if (req.method !== "POST") {
          writeJson(res, 405, { ok: false, error: "只能用 POST。" });
          return;
        }
        const body = await readJsonBody(req);
        const projectDir = requireBodyString(body.projectPath, "项目路径不能为空。");
        if (!guardProjectPath(res, projectDir)) return;
        const chapter = requirePositiveBodyInteger(body.chapter, "章节不能为空。");
        const id = requireBodyString(body.id, "缺少是哪一份。");
        const kind = body.kind === "recovery" ? "recovery" as const : body.kind === "candidate" ? "candidate" as const : undefined;
        const decision = body.decision === "adopt" ? "adopt" as const : body.decision === "dismiss" ? "dismiss" as const : undefined;
        if (!kind || !decision) {
          writeJson(res, 400, { ok: false, error: "不知道要对哪一份做什么。" });
          return;
        }
        await assertStoryEngineProject(projectDir);
        const entry = kind === "candidate" ? await readDraftCandidate(projectDir, id) : await readDraftRecovery(projectDir, id);
        if (decision === "dismiss") {
          // 不要了：已经不在也算成（重发、两个窗口各点一次）。
          if (entry && entry.chapter === chapter) {
            if (kind === "candidate") await removeDraftCandidate(projectDir, id);
            else await removeDraftRecovery(projectDir, id);
          }
          writeJson(res, 200, { ok: true });
          return;
        }
        if (!entry || entry.chapter !== chapter) {
          writeJson(res, 404, { ok: false, error: "那一份已经不在了（可能已经换上或不要了）。" });
          return;
        }
        // 作者看到的就是这一份才换（候选写到一半进程没了又被续上之类，内容变了就不换）。
        if (typeof body.sha !== "string" || body.sha !== sha256(entry.body)) {
          writeJson(res, 409, { ok: false, error: "那一份在这期间变过了，没换。看一眼再选。" });
          return;
        }
        const baseVersion = readBaseVersion(body.baseVersion);
        const label = kind === "candidate" ? `换上 AI 稿：第${chapter}章` : `找回没存上的稿：第${chapter}章`;
        const wordsBefore = await chapterWordsNow(projectDir, chapter).catch(() => undefined);
        const { snapshotId, result: outcome } = await runWithLazySnapshot(projectDir, (snapshot) =>
          runCommand(projectDir, draftAdoptCandidate, {
            chapter,
            body: entry.body,
            ...(entry.title ? { title: entry.title } : {}),
            baseVersion,
          }, { caller: "author", snapshot }), label);
        if (!outcome.ok) {
          writeJson(res, outcome.code === "draft_conflict" ? 409 : 400, {
            ok: false,
            code: outcome.code,
            error: outcome.code === "draft_conflict" ? "这一章的稿子在这期间又改过了，没换。看一眼稿纸再选。" : outcome.message,
          });
          return;
        }
        if (!outcome.result.unchanged) await recordChapterWords(projectDir, chapter, kind === "candidate" ? "ai" : "author", wordsBefore);
        if (kind === "candidate") await removeDraftCandidate(projectDir, id);
        else await removeDraftRecovery(projectDir, id);
        writeJson(res, 200, { ok: true, version: outcome.result.version, ...(snapshotId ? { snapshotId } : {}) });
        return;
      }
      if (req.method === "GET") {
        const projectDir = requireBodyString(url.searchParams.get("project"), "项目路径不能为空。");
        if (!guardProjectPath(res, projectDir)) return;
        const chapter = requirePositiveBodyInteger(Number(url.searchParams.get("chapter")), "章节不能为空。");
        // 读路径不拿锁、不写盘（重构 P7）。
        await assertStoryEngineProject(projectDir);
        const paper = await readChapterPaper(projectDir, chapter);
        const pending = await pendingDraftFor(projectDir, chapter);
        writeJson(res, 200, { ok: true, paper: { ...paper, ...(pending ? { pending } : {}) } });
        return;
      }
      if (req.method === "PUT") {
        const body = await readJsonBody(req);
        const projectDir = requireBodyString(body.projectPath, "项目路径不能为空。");
        if (!guardProjectPath(res, projectDir)) return;
        const chapter = requirePositiveBodyInteger(body.chapter, "章节不能为空。");
        if (typeof body.body !== "string") throw new Error("正文不能缺。");
        const baseVersion = readBaseVersion(body.baseVersion);
        const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : undefined;
        await assertStoryEngineProject(projectDir);
        // 写作统计：写之前量一下这章多少字，存完按差值记成作者写的。
        const wordsBefore = await chapterWordsNow(projectDir, chapter).catch(() => undefined);
        const outcome = await runCommand(projectDir, draftSave, {
          chapter,
          body: body.body as string,
          ...(title ? { title } : {}),
          baseVersion,
        }, { caller: "author" });
        if (outcome.ok) {
          if (!outcome.result.unchanged) await recordChapterWords(projectDir, chapter, "author", wordsBefore);
          // 存上了：和这份一样的恢复稿没用了。清不掉不影响存稿。
          await clearSavedRecoveries(projectDir, chapter, body.body as string).catch(() => undefined);
          writeJson(res, 200, { ok: true, version: outcome.result.version, unchanged: outcome.result.unchanged });
          return;
        }
        if (outcome.code === "draft_conflict") {
          const details = outcome.details as DraftConflictDetails | undefined;
          // 作者手上这份先留下来（写作版本 P1b）：稿纸上选「换成那一版」之前、或这时应用被关了，字都还在。
          // 存不上照样回 409（字还在作者的稿纸上），只是少了这份底。
          const recovery = await saveDraftRecovery(projectDir, { chapter, body: body.body as string, ...(title ? { title } : {}), baseVersion }).catch((error: unknown) => {
            console.warn(`[working-draft] 第 ${chapter} 章没存上的那份没留成恢复稿：${scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error))}`);
            return undefined;
          });
          writeJson(res, 409, { ok: false, code: outcome.code, error: outcome.message, current: details?.current ?? null, ...(recovery ? { recoveryId: recovery.id } : {}) });
          return;
        }
        writeJson(res, 400, { ok: false, code: outcome.code, error: outcome.message });
        return;
      }
      writeJson(res, 405, { ok: false, error: "只支持 GET 和 PUT。" });
    } catch (error) {
      writeJson(res, 500, { ok: false, error: scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error)) });
    }
  });
}
