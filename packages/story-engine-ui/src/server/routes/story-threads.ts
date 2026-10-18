/**
 * GET /api/story-threads?project= —— 伏笔看板的数据（重构 P6，草图 ④）。
 *
 * 直接读新核心的投影（老格式镜像把「停太久」和分量都丢了）：四种状态原样给界面分四列，
 * 每条线索带上每一笔（第几章、埋 / 推进 / 收、一句话、原句），点原句回稿纸。
 * 线索编号只给界面当按钮参数用（收掉 / 调分量走「确认改账」结构化动作），界面不显示。
 */
import { projectBook, type BookProjection } from "@actalk/story-core";
import { guardProjectPath, writeJson, type MiddlewareStack } from "../lib/project-io.js";
import { scrubLocalAbsolutePaths } from "../lib/local-path-scrubber.js";
import { ensureBookOnCore } from "../book/mirror/ensure.js";
import { coreSnapshotFor } from "../lib/snapshot.js";

export interface ThreadBoardTouch {
  readonly chapter: number;
  readonly op: "open" | "advance" | "close";
  readonly note: string;
  readonly quote?: string;
}

export interface ThreadBoardItem {
  readonly id: string;
  readonly title: string;
  readonly type: "question" | "intent" | "goal";
  readonly status: "open" | "active" | "stale" | "closed";
  readonly weight: "major" | "normal" | "minor";
  readonly openedAt: number;
  readonly lastTouchedAt: number;
  readonly closedAt?: number;
  readonly closedBy?: "ledger" | "author";
  /** 停了几章（最新定稿章 − 最近一笔）。 */
  readonly idle: number;
  readonly touches: readonly ThreadBoardTouch[];
}

export interface ThreadBoard {
  /** 投影算到第几章（最新定稿章）；0 = 还没有定稿的章。 */
  readonly upTo: number;
  readonly threads: readonly ThreadBoardItem[];
}

const WEIGHT_RANK = { major: 0, normal: 1, minor: 2 } as const;

/** 投影 → 看板：每列里分量重的先，同分量最近动过的先（停太久那列停得久的先）。 */
export function toThreadBoard(projection: Pick<BookProjection, "upTo" | "threads">): ThreadBoard {
  const threads = projection.threads.map((thread): ThreadBoardItem => ({
    id: thread.id,
    title: thread.title,
    type: thread.type,
    status: thread.status,
    weight: thread.weight,
    openedAt: thread.openedAt,
    lastTouchedAt: thread.lastTouchedAt,
    ...(thread.closedAt !== undefined ? { closedAt: thread.closedAt } : {}),
    ...(thread.closedBy ? { closedBy: thread.closedBy } : {}),
    idle: Math.max(0, projection.upTo - thread.lastTouchedAt),
    touches: thread.touches.map((touch) => ({
      chapter: touch.chapter,
      op: touch.op,
      note: touch.note,
      ...(touch.quote ? { quote: touch.quote } : {}),
    })),
  }));
  // 一个键排（保证可传递）：停太久的按停得久排（键取负的最近一笔），其余按最近动过 / 收的那章。
  const recency = (thread: ThreadBoardItem): number => (thread.status === "stale" ? -thread.lastTouchedAt : thread.closedAt ?? thread.lastTouchedAt);
  threads.sort((a, b) =>
    WEIGHT_RANK[a.weight] - WEIGHT_RANK[b.weight]
    || recency(b) - recency(a)
    || a.openedAt - b.openedAt
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { upTo: projection.upTo, threads };
}

export function registerStoryThreadsRoutes(middlewares: MiddlewareStack): void {
  middlewares.use(async (req, res, next) => {
    if (!req.url?.startsWith("/api/story-threads")) {
      next();
      return;
    }
    try {
      if (req.method !== "GET") {
        writeJson(res, 405, { ok: false, error: "Only GET is supported." });
        return;
      }
      const url = new URL(req.url, "http://localhost");
      const projectDir = url.searchParams.get("project")?.trim();
      if (!projectDir) {
        writeJson(res, 400, { ok: false, error: "Project path is required." });
        return;
      }
      if (!guardProjectPath(res, projectDir)) return;
      const onCore = await ensureBookOnCore(projectDir, { snapshot: coreSnapshotFor(projectDir) });
      if (!onCore.ok) {
        writeJson(res, 200, { ok: false, error: `这本书的账还没接到新格式上：${onCore.reason}` });
        return;
      }
      writeJson(res, 200, { ok: true, board: toThreadBoard(await projectBook(projectDir)) });
    } catch (error) {
      writeJson(res, 500, { ok: false, error: scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error)) });
    }
  });
}
