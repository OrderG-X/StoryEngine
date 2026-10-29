/**
 * 工作稿的读和存（重构 P5；写作版本 P1b 加了恢复稿和 AI 候选）：
 *   GET /api/working-draft?project=…&chapter=…  → { ok, paper: { chapter, draft, committed, editedSinceCommit, pending? } }
 *     draft = { chapter, title?, body, version } | null；committed = { title?, body } | null（定稿正文）
 *     pending = 等作者选的一份：恢复稿（作者上次没存上的字）或 AI 候选（AI 写好、没换上的），和工作稿一样的不给。
 *   PUT /api/working-draft { projectPath, chapter, body, title?, baseVersion, client?, seq? } → { ok, version, unchanged }
 *     baseVersion 和盘上对不上 → 先把这份存成恢复稿（client = 稿纸窗口号、seq = 这个窗口第几笔，比盘上旧的不写），
 *     再 409 { ok:false, code:"draft_conflict", error, current, recoveryId }；恢复稿也没写进去 → 503 recovery_failed（没存上）。
 *     工作稿不动。盘上已经就是这份（同一笔重发）算存上。整段在书锁里。
 *   POST /api/working-draft/pending { projectPath, chapter, kind, id, sha, decision, baseVersion, client?, seq? }
 *     decision=adopt：换上那一份（作者档 draft.adoptCandidate，带作者眼前那份的版本，对不上不换；换前存档、可撤销）；
 *     decision=dismiss：不要了（AI 候选删掉；恢复稿清掉——本窗口自己的直接清，别的窗口的要 sha 对得上）。
 *     查那一份、换上、清掉在同一把书锁里。
 *   POST /api/chapter-title { projectPath, chapter, title, requestId } → { ok, title, unchanged, snapshotId? }
 *     改已定稿那一章的章名（作者档 chapter.retitle，改前存档、可撤销；正文和账单条目不动）。requestId 是这次点击的幂等键。
 *     没定稿的章不走这里：章名跟着存稿走。
 *
 * 版本号是这章的工作稿代次 + 草稿文件全文的哈希（核心包 draft/draft.ts）。
 */
import { chapterRetitle, draftAdoptCandidate, draftSave, readChapterPaper, runCommand, sha256, withBookLock, type DraftConflictDetails } from "@actalk/story-core";
import {
  assertStoryEngineProject,
  guardProjectPath,
  readJsonBody,
  requireBodyString,
  requirePositiveBodyInteger,
  writeJson,
  type DevApiResponse,
  type MiddlewareStack,
} from "../lib/project-io.js";
import { scrubLocalAbsolutePaths } from "../lib/local-path-scrubber.js";
import { chapterWordsNow, recordChapterWords } from "../lib/word-stats.js";
import { runWithLazySnapshot } from "../lib/snapshot.js";
import { syncLegacyMirror } from "../book/mirror/sync.js";
import {
  clearSavedRecoveries,
  consumeDraftRecovery,
  dismissDraftRecovery,
  pendingDraftFor,
  readDraftCandidate,
  readDraftRecovery,
  recoveryClientOf,
  removeDraftCandidate,
  saveDraftRecovery,
  type DraftRecovery,
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
        const sha = typeof body.sha === "string" ? body.sha : undefined;
        const from = recoveryClientOf(body.client, body.seq);
        // 查那一份、换上、清掉它，整段在书锁里（写作版本 P1b 第 3 轮复核）：查过之后别的存稿改了它，就不会拿旧的换上、再把新的删了。
        const reply = await withBookLock(projectDir, async (): Promise<{ readonly status: number; readonly payload: DevApiResponse }> => {
          const entry = kind === "candidate" ? await readDraftCandidate(projectDir, id) : await readDraftRecovery(projectDir, id);
          const live = entry && entry.chapter === chapter && entry.body.trim() ? entry : undefined;
          if (decision === "dismiss") {
            if (kind === "candidate") {
              // 不要了：已经不在也算成（重发、两个窗口各点一次）。
              if (!live) return { status: 200, payload: { ok: true } };
              if (sha !== undefined && sha !== sha256(live.body)) return { status: 409, payload: { ok: false, error: "那一份在这期间变过了，没删。看一眼再选。" } };
              await removeDraftCandidate(projectDir, id);
              return { status: 200, payload: { ok: true } };
            }
            // 恢复稿已经清空了（找回了、别处不要了）也算成；清空的那份也交给它推进序号（第 5 轮复核 S10）。
            if (!entry || entry.chapter !== chapter) return { status: 200, payload: { ok: true } };
            const dismissed = await dismissDraftRecovery(projectDir, entry as DraftRecovery, { ...(sha !== undefined ? { sha } : {}), ...(from ? { from } : {}) });
            return dismissed ? { status: 200, payload: { ok: true } } : { status: 409, payload: { ok: false, error: "那一份在这期间变过了，没删。看一眼再选。" } };
          }
          if (!live) return { status: 404, payload: { ok: false, error: "那一份已经不在了（可能已经换上或不要了）。" } };
          // 作者看到的就是这一份才换（这期间又存进了新字之类，内容变了就不换）。
          if (sha !== sha256(live.body)) return { status: 409, payload: { ok: false, error: "那一份在这期间变过了，没换。看一眼再选。" } };
          const baseVersion = readBaseVersion(body.baseVersion);
          const label = kind === "candidate" ? `换上 AI 稿：第${chapter}章` : `找回没存上的稿：第${chapter}章`;
          const wordsBefore = await chapterWordsNow(projectDir, chapter).catch(() => undefined);
          const { snapshotId, result: outcome } = await runWithLazySnapshot(projectDir, (snapshot) =>
            runCommand(projectDir, draftAdoptCandidate, {
              chapter,
              body: live.body,
              ...(live.title ? { title: live.title } : {}),
              baseVersion,
            }, { caller: "author", snapshot }), label);
          if (!outcome.ok) {
            return {
              status: outcome.code === "draft_conflict" ? 409 : 400,
              payload: {
                ok: false,
                code: outcome.code,
                error: outcome.code === "draft_conflict" ? "这一章的稿子在这期间又改过了，没换。看一眼稿纸再选。" : outcome.message,
              },
            };
          }
          if (!outcome.result.unchanged) await recordChapterWords(projectDir, chapter, kind === "candidate" ? "ai" : "author", wordsBefore);
          if (kind === "candidate") await removeDraftCandidate(projectDir, id);
          else await consumeDraftRecovery(projectDir, live as DraftRecovery);
          return { status: 200, payload: { ok: true, version: outcome.result.version, ...(snapshotId ? { snapshotId } : {}) } };
        });
        writeJson(res, reply.status, reply.payload);
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
        const text = body.body;
        const baseVersion = readBaseVersion(body.baseVersion);
        const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : undefined;
        const from = recoveryClientOf(body.client, body.seq);
        await assertStoryEngineProject(projectDir);
        // 存稿和撞版本时留恢复稿在同一把书锁里（写作版本 P1b 第 3 轮复核）：两笔存稿不会交错着写恢复稿，找回也切不进中间。
        const reply = await withBookLock(projectDir, async (): Promise<{ readonly status: number; readonly payload: DevApiResponse }> => {
          // 写作统计：写之前量一下这章多少字，存完按差值记成作者写的。
          const wordsBefore = await chapterWordsNow(projectDir, chapter).catch(() => undefined);
          const outcome = await runCommand(projectDir, draftSave, {
            chapter,
            body: text,
            ...(title ? { title } : {}),
            baseVersion,
          }, { caller: "author" });
          if (outcome.ok) {
            if (!outcome.result.unchanged) await recordChapterWords(projectDir, chapter, "author", wordsBefore);
            // 存上了：这个窗口的恢复稿、和这份一样的恢复稿没用了。清不掉不影响存稿（下次开章和工作稿一样也不提示）。
            await clearSavedRecoveries(projectDir, chapter, text, from).catch(() => undefined);
            return { status: 200, payload: { ok: true, version: outcome.result.version, unchanged: outcome.result.unchanged } };
          }
          if (outcome.code !== "draft_conflict") return { status: 400, payload: { ok: false, code: outcome.code, error: outcome.message } };
          const details = outcome.details as DraftConflictDetails | undefined;
          // 作者手上这份先留下来（写作版本 P1b）：稿纸上选「换成那一版」之前、或这时应用被关了，字都还在。
          // 留不下来就如实说没存上（503），稿纸当没存、过一会儿再试，换章、关书都拦着。
          try {
            const saved = await saveDraftRecovery(projectDir, { chapter, body: text, ...(title ? { title } : {}), baseVersion, ...(from ? { from } : {}) });
            return { status: 409, payload: { ok: false, code: outcome.code, error: outcome.message, current: details?.current ?? null, currentVersion: details?.currentVersion ?? null, recoveryId: saved.recovery.id } };
          } catch (error) {
            console.warn(`[working-draft] 第 ${chapter} 章没存上的那份没留成恢复稿：${scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error))}`);
            return { status: 503, payload: { ok: false, code: "recovery_failed", error: "别处刚改过这一章，你这段也没能另存下来（写盘没成功）。字还在稿纸上，稍后自动再试。" } };
          }
        });
        writeJson(res, reply.status, reply.payload);
        return;
      }
      writeJson(res, 405, { ok: false, error: "只支持 GET 和 PUT。" });
    } catch (error) {
      writeJson(res, 500, { ok: false, error: scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error)) });
    }
  });
}
