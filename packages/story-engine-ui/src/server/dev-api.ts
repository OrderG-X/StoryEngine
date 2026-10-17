/**
 * Dev API — thin router that registers all route modules.
 *
 * The original monolith was ~4150 lines. This file dispatches each incoming
 * request to the smallest applicable route module.
 */
import type { MiddlewareStack } from "./lib/project-io.js";
import { createSecurityGate } from "./lib/request-guard.js";
import { registerStateOverviewRoutes } from "./routes/state-overview.js";
import { registerReaderProgressRoutes } from "./routes/reader-progress.js";
import { registerDraftRoutes } from "./routes/draft.js";
import { registerDraftRevisionRoutes } from "./routes/draft-revision.js";
import { registerDeAiFlavorRoutes } from "./routes/de-ai-flavor.js";
import { registerBooksRoutes } from "./routes/books.js";
import { registerModelSettingsRoutes } from "./routes/model-settings.js";
import { registerChapterWorkspaceRoutes } from "./routes/chapter-workspace.js";
import { registerChatSessionsRoutes } from "./routes/chat-sessions.js";
import { registerSnapshotsRoutes } from "./routes/snapshots.js";
import { registerAgentChatRoutes } from "./routes/agent-chat.js";
import { registerWorldbuildingRoutes } from "./routes/worldbuilding.js";
import { registerAssetEnrichmentRoutes } from "./routes/asset-enrichment.js";
import { registerLocationEnrichmentRoutes } from "./routes/location-enrichment.js";
import { registerCharacterEnrichmentRoutes } from "./routes/character-enrichment.js";
import { registerWritingRulesEnrichmentRoutes } from "./routes/writing-rules-enrichment.js";
import { registerForeshadowingOverridesRoutes } from "./routes/foreshadowing-overrides.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerContinuityDismissalsRoutes } from "./routes/continuity-dismissals.js";

// ---------------------------------------------------------------------------
// Public entry point — Vite 插件(server.middlewares)与独立 server(connect 实例)都满足
// MiddlewareStack（{use(handler)}），故这里用本地类型、不再耦合 vite，方便脱壳独立运行/打包桌面。
// ---------------------------------------------------------------------------

export function registerStateOverviewApi(router: MiddlewareStack): void {
  // 安全闸必须最先挂（审查 #2）：Host 白名单 + 写路由 Origin/Content-Type 校验，挡 DNS rebinding / CSRF。
  router.use(createSecurityGate());
  registerStateOverviewRoutes(router);
  registerReaderProgressRoutes(router);
  registerDraftRoutes(router);
  registerDraftRevisionRoutes(router);
  registerDeAiFlavorRoutes(router);
  registerBooksRoutes(router);
  registerModelSettingsRoutes(router);
  registerChapterWorkspaceRoutes(router);
  registerChatSessionsRoutes(router);
  registerSnapshotsRoutes(router);
  registerAgentChatRoutes(router);
  registerWorldbuildingRoutes(router);
  registerAssetEnrichmentRoutes(router);
  registerLocationEnrichmentRoutes(router);
  registerCharacterEnrichmentRoutes(router);
  registerWritingRulesEnrichmentRoutes(router);
  registerForeshadowingOverridesRoutes(router);
  registerContinuityDismissalsRoutes(router);
  registerHealthRoutes(router);
}
