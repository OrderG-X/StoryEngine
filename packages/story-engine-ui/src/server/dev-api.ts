/**
 * Dev API — thin router that registers all route modules.
 *
 * The original monolith was ~4150 lines. This file dispatches each incoming
 * request to the smallest applicable route module.
 */
import type { MiddlewareStack } from "./lib/project-io.js";
import { createSecurityGate } from "./lib/request-guard.js";
import { runInUsageScope } from "./lib/usage-scope.js";
import { registerUsageRoutes } from "./routes/usage.js";
import { registerSearchSettingsRoutes } from "./routes/search-settings.js";
import { registerAboutRoutes } from "./routes/about.js";
import { registerStateOverviewRoutes } from "./routes/state-overview.js";
import { registerReaderProgressRoutes } from "./routes/reader-progress.js";
import { registerDraftRoutes } from "./routes/draft.js";
import { registerDraftRevisionRoutes } from "./routes/draft-revision.js";
import { registerDeAiFlavorRoutes } from "./routes/de-ai-flavor.js";
import { registerBooksRoutes } from "./routes/books.js";
import { registerBookImportRoutes } from "./routes/book-import.js";
import { registerBookFilesRoutes } from "./routes/book-files.js";
import { registerBookMetaRoutes } from "./routes/book-meta.js";
import { registerModelSettingsRoutes } from "./routes/model-settings.js";
import { registerWorkingDraftRoutes } from "./routes/working-draft.js";
import { registerChatSessionsRoutes } from "./routes/chat-sessions.js";
import { registerSnapshotsRoutes } from "./routes/snapshots.js";
import { registerAgentChatRoutes } from "./routes/agent-chat.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerContinuityDismissalsRoutes } from "./routes/continuity-dismissals.js";
import { registerStoryThreadsRoutes } from "./routes/story-threads.js";
import { registerStoryMapRoutes } from "./routes/story-map.js";
import { registerChapterChangesRoutes } from "./routes/chapter-changes.js";
import { registerBookSearchRoutes } from "./routes/book-search.js";
import { registerBibleRoutes } from "./routes/bible.js";

// ---------------------------------------------------------------------------
// Public entry point — Vite 插件(server.middlewares)与独立 server(connect 实例)都满足
// MiddlewareStack（{use(handler)}），故这里用本地类型、不再耦合 vite，方便脱壳独立运行/打包桌面。
// ---------------------------------------------------------------------------

export function registerStateOverviewApi(router: MiddlewareStack): void {
  // 安全闸必须最先挂（审查 #2）：Host 白名单 + 写路由 Origin/Content-Type 校验，挡 DNS rebinding / CSRF。
  router.use(createSecurityGate());
  // 每个请求一个用量范围：路由过项目路径闸时记下书，这次请求里调模型的用量记到它名下（P10）。
  router.use((_req, _res, next) => runInUsageScope(() => next()));
  registerStateOverviewRoutes(router);
  registerReaderProgressRoutes(router);
  registerDraftRoutes(router);
  registerDraftRevisionRoutes(router);
  registerDeAiFlavorRoutes(router);
  registerBooksRoutes(router);
  registerBookImportRoutes(router);
  registerBookFilesRoutes(router);
  registerBookMetaRoutes(router);
  registerModelSettingsRoutes(router);
  registerUsageRoutes(router);
  registerSearchSettingsRoutes(router);
  registerAboutRoutes(router);
  registerWorkingDraftRoutes(router);
  registerChatSessionsRoutes(router);
  registerSnapshotsRoutes(router);
  registerAgentChatRoutes(router);
  registerContinuityDismissalsRoutes(router);
  registerStoryThreadsRoutes(router);
  registerStoryMapRoutes(router);
  registerChapterChangesRoutes(router);
  registerBookSearchRoutes(router);
  registerBibleRoutes(router);
  registerHealthRoutes(router);
}
